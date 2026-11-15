import { and, asc, eq, isNull, ne, sql, type SQL } from "drizzle-orm";

import { runInTransaction } from "@/shared/db/transaction";
import type { RequestContext } from "@/shared/kernel/authorization";

import { toTree, validateCategoryMove, validateNewCategory, type CategoryNode } from "../domain/category-tree";
import { parseKey } from "../domain/codes";
import { invalid, issue, valid, type CatalogIssue } from "../domain/errors";
import { categoryChanged } from "../domain/events";
import { parseTranslations, type Translation, type TranslationInput } from "../domain/localization";
import { CATALOG_PERMISSIONS } from "../domain/permissions";
import { categories, categoryTranslations } from "../infrastructure/schema";

import {
  CATEGORY_TREE_LOCK,
  mapUniqueViolations,
  notFound,
  replaceTranslations,
  requireRequiredLocale,
  type CatalogDeps,
  type CatalogResult,
  type Db,
  type TranslationTable,
} from "./support";

export interface CategoryView {
  readonly id: string;
  readonly key: string;
  readonly parentId: string | null;
  readonly position: number;
  readonly status: "active" | "archived";
  readonly translations: readonly Translation[];
}

const TRANSLATIONS: TranslationTable = {
  table: categoryTranslations,
  owner: categoryTranslations.categoryId,
  locale: categoryTranslations.locale,
  row: (categoryId, t) => ({
    categoryId,
    locale: t.locale,
    name: t.name,
    slug: t.slug ?? "",
    description: t.description,
    seoTitle: t.seoTitle,
    seoDescription: t.seoDescription,
  }),
  updates: [
    ["name", "name"],
    ["slug", "slug"],
    ["description", "description"],
    ["seoTitle", "seo_title"],
    ["seoDescription", "seo_description"],
  ],
};

const parentIs = (parentId: string | null): SQL => (parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId));

async function lockTree(db: Db): Promise<ReturnType<typeof toTree>> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(${CATEGORY_TREE_LOCK})`);
  const rows = await db.select({ id: categories.id, parentId: categories.parentId, status: categories.status }).from(categories);
  return toTree(rows as CategoryNode[]);
}

async function nextPosition(db: Db, parentId: string | null): Promise<number> {
  const [row] = await db.select({ next: sql<number>`coalesce(max(${categories.position}), -1) + 1` }).from(categories).where(parentIs(parentId));
  return Number(row?.next ?? 0);
}

async function slugIssues(db: Db, translations: readonly Translation[], exceptCategoryId: string | null): Promise<CatalogIssue[]> {
  const issues: CatalogIssue[] = [];
  for (const t of translations) {
    if (!t.slug) continue;
    const taken = await db
      .select({ id: categoryTranslations.categoryId })
      .from(categoryTranslations)
      .where(
        and(
          eq(categoryTranslations.locale, t.locale),
          eq(categoryTranslations.slug, t.slug),
          exceptCategoryId ? ne(categoryTranslations.categoryId, exceptCategoryId) : undefined,
        ),
      )
      .limit(1);
    if (taken.length > 0) issues.push(issue("slug_taken", `translations.${t.locale}.slug`));
  }
  return issues;
}

function parseContent(translations: readonly TranslationInput[]): CatalogResult<Translation[]> {
  const parsed = parseTranslations("category", translations);
  if (!parsed.ok) return parsed;
  const missing = requireRequiredLocale(parsed.value);
  return missing.length > 0 ? invalid(missing) : parsed;
}

export function createCategoryService({ pool, now }: CatalogDeps) {
  const authorize = (ctx: RequestContext) => ctx.authorize(CATALOG_PERMISSIONS.taxonomyManage);

  return {
    /** A new category at the end of its siblings. `parentId` null creates a top-level department. */
    async create(ctx: RequestContext, input: { key: string; parentId?: string | null; translations: readonly TranslationInput[] }): Promise<CatalogResult<{ categoryId: string }>> {
      await authorize(ctx);
      const key = parseKey("category", input.key);
      const content = parseContent(input.translations);
      if (!key.ok || !content.ok) return invalid([...(key.ok ? [] : key.issues), ...(content.ok ? [] : content.issues)]);
      const parentId = input.parentId ?? null;

      return mapUniqueViolations(() =>
        runInTransaction(pool, async (tx) => {
          const tree = await lockTree(tx.db);
          const placement = validateNewCategory(tree, parentId);
          const issues = [...(placement.ok ? [] : placement.issues), ...(await slugIssues(tx.db, content.value, null))];
          const [existing] = await tx.db.select({ id: categories.id }).from(categories).where(eq(categories.key, key.value)).limit(1);
          if (existing) issues.push(issue("key_taken", "key"));
          if (issues.length > 0) return invalid(issues);

          const at = now();
          const [row] = await tx.db
            .insert(categories)
            .values({ key: key.value, parentId, position: await nextPosition(tx.db, parentId), createdAt: at, updatedAt: at })
            .returning({ id: categories.id });
          if (!row) throw new Error("category insert returned no row");
          await replaceTranslations(tx.db, TRANSLATIONS, row.id, content.value);
          await tx.events.add(categoryChanged(row.id));
          return valid({ categoryId: row.id });
        }),
      );
    },

    /** Replaces the category's translations (Persian must stay). The key is immutable. */
    async update(ctx: RequestContext, input: { categoryId: string; translations: readonly TranslationInput[] }): Promise<CatalogResult<{ categoryId: string }>> {
      await authorize(ctx);
      const content = parseContent(input.translations);
      if (!content.ok) return content;

      return mapUniqueViolations(() =>
        runInTransaction(pool, async (tx) => {
          const [row] = await tx.db.select({ id: categories.id }).from(categories).where(eq(categories.id, input.categoryId)).for("update").limit(1);
          if (!row) return notFound("categoryId");
          const issues = await slugIssues(tx.db, content.value, row.id);
          if (issues.length > 0) return invalid(issues);
          await replaceTranslations(tx.db, TRANSLATIONS, row.id, content.value);
          await tx.db.update(categories).set({ updatedAt: now() }).where(eq(categories.id, row.id));
          await tx.events.add(categoryChanged(row.id));
          return valid({ categoryId: row.id });
        }),
      );
    },

    /** Moves a category and its subtree under another parent (or to the top level), appended last. */
    async move(ctx: RequestContext, input: { categoryId: string; parentId: string | null }): Promise<CatalogResult<{ categoryId: string; depth: number }>> {
      await authorize(ctx);
      return runInTransaction(pool, async (tx) => {
        const tree = await lockTree(tx.db);
        const node = tree.get(input.categoryId);
        if (!node) return notFound("categoryId");
        const placement = validateCategoryMove(tree, input.categoryId, input.parentId);
        if (!placement.ok) return placement;
        if (node.parentId === input.parentId) return valid({ categoryId: node.id, depth: placement.value.depth });
        await tx.db
          .update(categories)
          .set({ parentId: input.parentId, position: await nextPosition(tx.db, input.parentId), updatedAt: now() })
          .where(eq(categories.id, node.id));
        await tx.events.add(categoryChanged(node.id));
        return valid({ categoryId: node.id, depth: placement.value.depth });
      });
    },

    /** Sets the order of all children of `parentId` (null = top level); the list must name each exactly once. */
    async reorder(ctx: RequestContext, input: { parentId: string | null; orderedIds: readonly string[] }): Promise<CatalogResult<{ changed: number }>> {
      await authorize(ctx);
      return runInTransaction(pool, async (tx) => {
        const tree = await lockTree(tx.db);
        if (input.parentId !== null && !tree.has(input.parentId)) return notFound("parentId");
        const children = await tx.db.select({ id: categories.id, position: categories.position }).from(categories).where(parentIs(input.parentId));
        const current = new Map(children.map((c) => [c.id, c.position]));
        const unique = new Set(input.orderedIds);
        if (unique.size !== input.orderedIds.length || unique.size !== current.size || input.orderedIds.some((id) => !current.has(id))) {
          return invalid([issue("invalid_order", "orderedIds", { expected: current.size })]);
        }
        const at = now();
        let changed = 0;
        for (const [position, id] of input.orderedIds.entries()) {
          if (current.get(id) === position) continue;
          await tx.db.update(categories).set({ position, updatedAt: at }).where(eq(categories.id, id));
          await tx.events.add(categoryChanged(id));
          changed += 1;
        }
        return valid({ changed });
      });
    },

    /** Archives a category. Refused while it has active children: archive them first. Idempotent. */
    async archive(ctx: RequestContext, input: { categoryId: string }): Promise<CatalogResult<{ categoryId: string }>> {
      await authorize(ctx);
      return runInTransaction(pool, async (tx) => {
        const tree = await lockTree(tx.db);
        const node = tree.get(input.categoryId);
        if (!node) return notFound("categoryId");
        if (node.status === "archived") return valid({ categoryId: node.id });
        const activeChildren = [...tree.values()].filter((n) => n.parentId === node.id && n.status === "active").length;
        if (activeChildren > 0) return invalid([issue("category_has_active_children", "categoryId", { children: activeChildren })]);
        await tx.db.update(categories).set({ status: "archived", updatedAt: now() }).where(eq(categories.id, node.id));
        await tx.events.add(categoryChanged(node.id));
        return valid({ categoryId: node.id });
      });
    },

    /** Restores an archived category. Refused while its parent is archived: restore that first. Idempotent. */
    async restore(ctx: RequestContext, input: { categoryId: string }): Promise<CatalogResult<{ categoryId: string }>> {
      await authorize(ctx);
      return runInTransaction(pool, async (tx) => {
        const tree = await lockTree(tx.db);
        const node = tree.get(input.categoryId);
        if (!node) return notFound("categoryId");
        if (node.status === "active") return valid({ categoryId: node.id });
        if (node.parentId !== null && tree.get(node.parentId)?.status !== "active") return invalid([issue("category_archived", "parentId")]);
        await tx.db.update(categories).set({ status: "active", updatedAt: now() }).where(eq(categories.id, node.id));
        await tx.events.add(categoryChanged(node.id));
        return valid({ categoryId: node.id });
      });
    },

    /** Every category with its translations, ordered by parent and position (admin view, archived included). */
    async tree(ctx: RequestContext): Promise<CategoryView[]> {
      await ctx.authorize(CATALOG_PERMISSIONS.productsRead);
      // One snapshot, so nodes and translations are mutually consistent.
      const rows = await runInTransaction(
        pool,
        async (tx) => ({
          nodes: await tx.db.select().from(categories).orderBy(asc(categories.parentId), asc(categories.position), asc(categories.key)),
          translations: await tx.db.select().from(categoryTranslations).orderBy(asc(categoryTranslations.locale)),
        }),
        { isolation: "repeatable read" },
      );
      const byCategory = new Map<string, Translation[]>();
      for (const t of rows.translations) {
        const list = byCategory.get(t.categoryId) ?? [];
        list.push({ locale: t.locale as Translation["locale"], name: t.name, slug: t.slug, description: t.description, seoTitle: t.seoTitle, seoDescription: t.seoDescription });
        byCategory.set(t.categoryId, list);
      }
      return rows.nodes.map((n) => ({
        id: n.id,
        key: n.key,
        parentId: n.parentId,
        position: n.position,
        status: n.status as CategoryView["status"],
        translations: byCategory.get(n.id) ?? [],
      }));
    },
  };
}

export type CategoryService = ReturnType<typeof createCategoryService>;
