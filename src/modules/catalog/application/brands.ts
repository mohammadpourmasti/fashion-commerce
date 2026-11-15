import { and, asc, eq, ne } from "drizzle-orm";

import { runInTransaction } from "@/shared/db/transaction";
import type { RequestContext } from "@/shared/kernel/authorization";

import { parseKey } from "../domain/codes";
import { invalid, issue, valid, type CatalogIssue } from "../domain/errors";
import { brandChanged } from "../domain/events";
import { parseTranslations, type Translation, type TranslationInput } from "../domain/localization";
import { CATALOG_PERMISSIONS } from "../domain/permissions";
import { brands, brandTranslations } from "../infrastructure/schema";

import { mapUniqueViolations, notFound, replaceTranslations, requireRequiredLocale, type CatalogDeps, type CatalogResult, type Db, type TranslationTable } from "./support";

export interface BrandView {
  readonly id: string;
  readonly key: string;
  readonly status: "active" | "archived";
  readonly translations: readonly Translation[];
}

const TRANSLATIONS: TranslationTable = {
  table: brandTranslations,
  owner: brandTranslations.brandId,
  locale: brandTranslations.locale,
  row: (brandId, t) => ({ brandId, locale: t.locale, name: t.name, slug: t.slug ?? "", description: t.description }),
  updates: [
    ["name", "name"],
    ["slug", "slug"],
    ["description", "description"],
  ],
};

function parseContent(translations: readonly TranslationInput[]): CatalogResult<Translation[]> {
  const parsed = parseTranslations("brand", translations);
  if (!parsed.ok) return parsed;
  const missing = requireRequiredLocale(parsed.value);
  return missing.length > 0 ? invalid(missing) : parsed;
}

async function slugIssues(db: Db, translations: readonly Translation[], exceptBrandId: string | null): Promise<CatalogIssue[]> {
  const issues: CatalogIssue[] = [];
  for (const t of translations) {
    if (!t.slug) continue;
    const taken = await db
      .select({ id: brandTranslations.brandId })
      .from(brandTranslations)
      .where(and(eq(brandTranslations.locale, t.locale), eq(brandTranslations.slug, t.slug), exceptBrandId ? ne(brandTranslations.brandId, exceptBrandId) : undefined))
      .limit(1);
    if (taken.length > 0) issues.push(issue("slug_taken", `translations.${t.locale}.slug`));
  }
  return issues;
}

export function createBrandService({ pool, now }: CatalogDeps) {
  const authorize = (ctx: RequestContext) => ctx.authorize(CATALOG_PERMISSIONS.taxonomyManage);

  async function setStatus(ctx: RequestContext, brandId: string, status: "active" | "archived"): Promise<CatalogResult<{ brandId: string }>> {
    await authorize(ctx);
    return runInTransaction(pool, async (tx) => {
      const [row] = await tx.db.select({ id: brands.id, status: brands.status }).from(brands).where(eq(brands.id, brandId)).for("update").limit(1);
      if (!row) return notFound("brandId");
      if (row.status === status) return valid({ brandId: row.id });
      await tx.db.update(brands).set({ status, updatedAt: now() }).where(eq(brands.id, row.id));
      await tx.events.add(brandChanged(row.id));
      return valid({ brandId: row.id });
    });
  }

  return {
    async create(ctx: RequestContext, input: { key: string; translations: readonly TranslationInput[] }): Promise<CatalogResult<{ brandId: string }>> {
      await authorize(ctx);
      const key = parseKey("brand", input.key);
      const content = parseContent(input.translations);
      if (!key.ok || !content.ok) return invalid([...(key.ok ? [] : key.issues), ...(content.ok ? [] : content.issues)]);

      return mapUniqueViolations(() =>
        runInTransaction(pool, async (tx) => {
          const issues = await slugIssues(tx.db, content.value, null);
          const [existing] = await tx.db.select({ id: brands.id }).from(brands).where(eq(brands.key, key.value)).limit(1);
          if (existing) issues.push(issue("key_taken", "key"));
          if (issues.length > 0) return invalid(issues);
          const at = now();
          const [row] = await tx.db.insert(brands).values({ key: key.value, createdAt: at, updatedAt: at }).returning({ id: brands.id });
          if (!row) throw new Error("brand insert returned no row");
          await replaceTranslations(tx.db, TRANSLATIONS, row.id, content.value);
          await tx.events.add(brandChanged(row.id));
          return valid({ brandId: row.id });
        }),
      );
    },

    /** Replaces the brand's translations (Persian must stay). The key is immutable. */
    async update(ctx: RequestContext, input: { brandId: string; translations: readonly TranslationInput[] }): Promise<CatalogResult<{ brandId: string }>> {
      await authorize(ctx);
      const content = parseContent(input.translations);
      if (!content.ok) return content;

      return mapUniqueViolations(() =>
        runInTransaction(pool, async (tx) => {
          const [row] = await tx.db.select({ id: brands.id }).from(brands).where(eq(brands.id, input.brandId)).for("update").limit(1);
          if (!row) return notFound("brandId");
          const issues = await slugIssues(tx.db, content.value, row.id);
          if (issues.length > 0) return invalid(issues);
          await replaceTranslations(tx.db, TRANSLATIONS, row.id, content.value);
          await tx.db.update(brands).set({ updatedAt: now() }).where(eq(brands.id, row.id));
          await tx.events.add(brandChanged(row.id));
          return valid({ brandId: row.id });
        }),
      );
    },

    /** Archived brands stay on existing products but block publishing (ADR-026). Idempotent. */
    archive: (ctx: RequestContext, input: { brandId: string }) => setStatus(ctx, input.brandId, "archived"),
    restore: (ctx: RequestContext, input: { brandId: string }) => setStatus(ctx, input.brandId, "active"),

    /** Every brand with its translations, ordered by key (admin view, archived included). */
    async list(ctx: RequestContext): Promise<BrandView[]> {
      await ctx.authorize(CATALOG_PERMISSIONS.productsRead);
      const rows = await runInTransaction(
        pool,
        async (tx) => ({
          brands: await tx.db.select().from(brands).orderBy(asc(brands.key)),
          translations: await tx.db.select().from(brandTranslations).orderBy(asc(brandTranslations.locale)),
        }),
        { isolation: "repeatable read" },
      );
      const byBrand = new Map<string, Translation[]>();
      for (const t of rows.translations) {
        const list = byBrand.get(t.brandId) ?? [];
        list.push({ locale: t.locale as Translation["locale"], name: t.name, slug: t.slug, description: t.description, seoTitle: null, seoDescription: null });
        byBrand.set(t.brandId, list);
      }
      return rows.brands.map((b) => ({ id: b.id, key: b.key, status: b.status as BrandView["status"], translations: byBrand.get(b.id) ?? [] }));
    },
  };
}

export type BrandService = ReturnType<typeof createBrandService>;
