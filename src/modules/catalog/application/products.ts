import { and, asc, eq, inArray, isNotNull, ne, notInArray } from "drizzle-orm";

import { runInTransaction } from "@/shared/db/transaction";
import type { RequestContext } from "@/shared/kernel/authorization";

import { parseDecimal, parseDescriptiveValues, type AttributeRecord, type DescriptiveInput, type DescriptiveValue, type ValueRecord } from "../domain/attributes";
import { invalid, issue, valid, type CatalogIssue } from "../domain/errors";
import { CATALOG_EVENT_TYPES, productEvent } from "../domain/events";
import { parseTranslations, type Translation, type TranslationInput } from "../domain/localization";
import { CATALOG_PERMISSIONS } from "../domain/permissions";
import { planBrand, planCategoryAssignment, type ReferenceStatus } from "../domain/products";
import { nextStatus, type ProductAction, type ProductStatus } from "../domain/publication";
import {
  attributes,
  attributeValues,
  brands,
  categories,
  productAttributeValues,
  productAttributeValueTranslations,
  productCategories,
  products,
  productTranslations,
} from "../infrastructure/schema";

import { mapUniqueViolations, notFound, replaceTranslations, requireRequiredLocale, type CatalogDeps, type CatalogResult, type Db, type TranslationTable } from "./support";

export interface ProductView {
  readonly id: string;
  readonly status: ProductStatus;
  readonly version: number;
  readonly brandId: string | null;
  readonly primaryCategoryId: string;
  /** Every category of the product, primary first. */
  readonly categoryIds: readonly string[];
  readonly axisCount: number;
  readonly translations: readonly Translation[];
  readonly attributes: readonly DescriptiveValue[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly publishedAt: Date | null;
  readonly archivedAt: Date | null;
}

export interface ProductContentInput {
  readonly translations: readonly TranslationInput[];
  readonly brandId?: string | null;
  readonly primaryCategoryId: string;
  /** Additional categories; the primary is always included. */
  readonly categoryIds?: readonly string[];
  /** The complete set of descriptive values. */
  readonly attributes?: readonly DescriptiveInput[];
}

/** Every section is optional; a section that is given replaces the stored one. */
export interface ProductUpdateInput {
  readonly productId: string;
  /** The version the caller last read; a different stored version is a conflict. */
  readonly expectedVersion: number;
  readonly translations?: readonly TranslationInput[];
  /** `null` removes the brand. */
  readonly brandId?: string | null;
  readonly primaryCategoryId?: string;
  /** Replaces the additional categories (the primary is always kept in the set). */
  readonly categoryIds?: readonly string[];
  readonly attributes?: readonly DescriptiveInput[];
}

const TRANSLATIONS: TranslationTable = {
  table: productTranslations,
  owner: productTranslations.productId,
  locale: productTranslations.locale,
  row: (productId, t) => ({
    productId,
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

function parseContent(translations: readonly TranslationInput[]): CatalogResult<Translation[]> {
  const parsed = parseTranslations("product", translations);
  if (!parsed.ok) return parsed;
  const missing = requireRequiredLocale(parsed.value);
  return missing.length > 0 ? invalid(missing) : parsed;
}

const issuesOf = (...results: readonly ({ ok: boolean; issues?: readonly CatalogIssue[] } | null)[]): CatalogIssue[] =>
  results.flatMap((r) => (r && !r.ok ? [...(r.issues ?? [])] : []));

// Reads below take FOR SHARE locks: a concurrent archive of a referenced category, brand,
// attribute or value waits until this transaction commits, so checks and writes agree.

async function categoryStatuses(db: Db, ids: readonly string[]): Promise<Map<string, ReferenceStatus>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: categories.id, status: categories.status }).from(categories).where(inArray(categories.id, [...ids])).for("share");
  return new Map(rows.map((r) => [r.id, r.status as ReferenceStatus]));
}

async function brandStatuses(db: Db, id: string | null): Promise<Map<string, ReferenceStatus>> {
  if (id === null) return new Map();
  const rows = await db.select({ id: brands.id, status: brands.status }).from(brands).where(eq(brands.id, id)).for("share");
  return new Map(rows.map((r) => [r.id, r.status as ReferenceStatus]));
}

async function descriptiveContext(db: Db, inputs: readonly DescriptiveInput[], productId: string | null) {
  const attributeIds = [...new Set(inputs.map((i) => i.attributeId))];
  const valueIds = [...new Set(inputs.flatMap((i) => i.valueIds ?? []))];
  const attrRows = attributeIds.length
    ? await db
        .select({ id: attributes.id, usage: attributes.usage, valueType: attributes.valueType, axisKind: attributes.axisKind, status: attributes.status })
        .from(attributes)
        .where(inArray(attributes.id, attributeIds))
        .for("share")
    : [];
  const valueRows = valueIds.length
    ? await db.select({ id: attributeValues.id, attributeId: attributeValues.attributeId, status: attributeValues.status }).from(attributeValues).where(inArray(attributeValues.id, valueIds)).for("share")
    : [];
  const kept = productId
    ? await db
        .select({ valueId: productAttributeValues.valueId })
        .from(productAttributeValues)
        .where(and(eq(productAttributeValues.productId, productId), isNotNull(productAttributeValues.valueId)))
    : [];
  return {
    attributes: new Map(attrRows.map((a) => [a.id, a as AttributeRecord])),
    values: new Map(valueRows.map((v) => [v.id, v as ValueRecord])),
    keepArchived: new Set(kept.map((k) => k.valueId).filter((v): v is string => v !== null)),
  };
}

async function slugIssues(db: Db, translations: readonly Translation[], exceptProductId: string | null): Promise<CatalogIssue[]> {
  const issues: CatalogIssue[] = [];
  for (const t of translations) {
    if (!t.slug) continue;
    const taken = await db
      .select({ id: productTranslations.productId })
      .from(productTranslations)
      .where(and(eq(productTranslations.locale, t.locale), eq(productTranslations.slug, t.slug), exceptProductId ? ne(productTranslations.productId, exceptProductId) : undefined))
      .limit(1);
    if (taken.length > 0) issues.push(issue("slug_taken", `translations.${t.locale}.slug`));
  }
  return issues;
}

/** Replaces a product's descriptive values (text translations go with their rows). */
async function writeAttributes(db: Db, productId: string, values: readonly DescriptiveValue[]): Promise<void> {
  await db.delete(productAttributeValues).where(eq(productAttributeValues.productId, productId));
  for (const value of values) {
    const base = { productId, attributeId: value.attributeId, valueType: value.valueType };
    switch (value.valueType) {
      case "select":
        await db.insert(productAttributeValues).values(value.valueIds.map((valueId) => ({ ...base, valueId })));
        break;
      case "number":
        await db.insert(productAttributeValues).values({ ...base, numberValue: value.number });
        break;
      case "boolean":
        await db.insert(productAttributeValues).values({ ...base, booleanValue: value.boolean });
        break;
      case "text": {
        const [row] = await db.insert(productAttributeValues).values(base).returning({ id: productAttributeValues.id });
        if (!row) throw new Error("product attribute value insert returned no row");
        await db.insert(productAttributeValueTranslations).values(value.text.map((t) => ({ productAttributeValueId: row.id, locale: t.locale, textValue: t.name })));
        break;
      }
    }
  }
}

const versionConflict = (current: number): CatalogResult<never> => invalid([issue("version_conflict", "expectedVersion", { current })]);

export function createProductService({ pool, now }: CatalogDeps) {
  async function transition(ctx: RequestContext, input: { productId: string; expectedVersion: number }, action: Extract<ProductAction, "archive" | "restore">): Promise<CatalogResult<{ productId: string; version: number; status: ProductStatus }>> {
    await ctx.authorize(CATALOG_PERMISSIONS.productsPublish);
    return runInTransaction(pool, async (tx) => {
      const [row] = await tx.db.select({ id: products.id, status: products.status, version: products.version }).from(products).where(eq(products.id, input.productId)).for("update").limit(1);
      if (!row) return notFound("productId");
      if (row.version !== input.expectedVersion) return versionConflict(row.version);
      const next = nextStatus(row.status, action);
      if (!next.ok) return next;
      const at = now();
      const version = row.version + 1;
      await tx.db
        .update(products)
        .set({ status: next.value, archivedAt: action === "archive" ? at : null, version, updatedAt: at })
        .where(eq(products.id, row.id));
      await tx.events.add(productEvent(action === "archive" ? CATALOG_EVENT_TYPES.productArchived : CATALOG_EVENT_TYPES.productRestored, row.id));
      return valid({ productId: row.id, version, status: next.value });
    });
  }

  return {
    /** A new draft product (no variant axes yet). Persian is required from creation. */
    async create(ctx: RequestContext, input: ProductContentInput): Promise<CatalogResult<{ productId: string; version: number }>> {
      await ctx.authorize(CATALOG_PERMISSIONS.productsManage);
      const content = parseContent(input.translations);
      if (!content.ok) return content;

      return mapUniqueViolations(() =>
        runInTransaction(pool, async (tx) => {
          const assignment = planCategoryAssignment(await categoryStatuses(tx.db, [input.primaryCategoryId, ...(input.categoryIds ?? [])]), input);
          const brand = planBrand(await brandStatuses(tx.db, input.brandId ?? null), input.brandId ?? null);
          const context = await descriptiveContext(tx.db, input.attributes ?? [], null);
          const descriptive = parseDescriptiveValues(context.attributes, context.values, input.attributes ?? []);
          const issues = [...issuesOf(assignment, brand, descriptive), ...(await slugIssues(tx.db, content.value, null))];
          if (issues.length > 0 || !assignment.ok || !brand.ok || !descriptive.ok) return invalid(issues);

          const at = now();
          const [row] = await tx.db
            .insert(products)
            .values({ primaryCategoryId: assignment.value.primaryCategoryId, brandId: brand.value, createdAt: at, updatedAt: at })
            .returning({ id: products.id, version: products.version });
          if (!row) throw new Error("product insert returned no row");
          await tx.db.insert(productCategories).values(assignment.value.categoryIds.map((categoryId) => ({ productId: row.id, categoryId })));
          await replaceTranslations(tx.db, TRANSLATIONS, row.id, content.value);
          await writeAttributes(tx.db, row.id, descriptive.value);
          await tx.events.add(productEvent(CATALOG_EVENT_TYPES.productCreated, row.id));
          return valid({ productId: row.id, version: row.version });
        }),
      );
    },

    /**
     * Edits a draft or active product. Optimistic locking: `expectedVersion` must match, and
     * every successful update increments the version. Archived products are read-only.
     */
    async update(ctx: RequestContext, input: ProductUpdateInput): Promise<CatalogResult<{ productId: string; version: number }>> {
      await ctx.authorize(CATALOG_PERMISSIONS.productsManage);
      const content = input.translations ? parseContent(input.translations) : null;
      if (content && !content.ok) return content;

      return mapUniqueViolations(() =>
        runInTransaction(pool, async (tx) => {
          const [product] = await tx.db.select().from(products).where(eq(products.id, input.productId)).for("update").limit(1);
          if (!product) return notFound("productId");
          if (product.version !== input.expectedVersion) return versionConflict(product.version);
          if (product.status === "archived") return invalid([issue("product_archived", "productId")]);

          const currentCategories = new Set(
            (await tx.db.select({ id: productCategories.categoryId }).from(productCategories).where(eq(productCategories.productId, product.id))).map((r) => r.id),
          );
          const changesCategories = input.primaryCategoryId !== undefined || input.categoryIds !== undefined;
          const primaryCategoryId = input.primaryCategoryId ?? product.primaryCategoryId;
          const requested = input.categoryIds ?? [...currentCategories];
          const assignment = changesCategories
            ? planCategoryAssignment(await categoryStatuses(tx.db, [primaryCategoryId, ...requested]), { primaryCategoryId, categoryIds: requested }, {
                primaryCategoryId: product.primaryCategoryId,
                categoryIds: currentCategories,
              })
            : null;
          const brand = input.brandId !== undefined ? planBrand(await brandStatuses(tx.db, input.brandId), input.brandId, product.brandId) : null;
          const context = input.attributes ? await descriptiveContext(tx.db, input.attributes, product.id) : null;
          const descriptive = input.attributes && context ? parseDescriptiveValues(context.attributes, context.values, input.attributes, context.keepArchived) : null;
          const issues = [...issuesOf(assignment, brand, descriptive), ...(content?.ok ? await slugIssues(tx.db, content.value, product.id) : [])];
          if (issues.length > 0) return invalid(issues);

          // Order matters: new memberships exist before the primary moves, and the old primary
          // membership is removed only after (its RESTRICT foreign key is checked immediately).
          const keep = assignment?.ok ? assignment.value.categoryIds : [...currentCategories];
          const added = keep.filter((id) => !currentCategories.has(id));
          if (added.length > 0) await tx.db.insert(productCategories).values(added.map((categoryId) => ({ productId: product.id, categoryId })));
          if (content?.ok) await replaceTranslations(tx.db, TRANSLATIONS, product.id, content.value);
          if (descriptive?.ok) await writeAttributes(tx.db, product.id, descriptive.value);
          const version = product.version + 1;
          await tx.db
            .update(products)
            .set({
              primaryCategoryId: assignment?.ok ? assignment.value.primaryCategoryId : product.primaryCategoryId,
              brandId: brand?.ok ? brand.value : product.brandId,
              version,
              updatedAt: now(),
            })
            .where(eq(products.id, product.id));
          if (assignment?.ok) {
            await tx.db.delete(productCategories).where(and(eq(productCategories.productId, product.id), notInArray(productCategories.categoryId, [...keep])));
          }
          await tx.events.add(productEvent(CATALOG_EVENT_TYPES.productUpdated, product.id));
          return valid({ productId: product.id, version });
        }),
      );
    },

    /** draft | active -> archived. Never deletes anything. */
    archive: (ctx: RequestContext, input: { productId: string; expectedVersion: number }) => transition(ctx, input, "archive"),
    /** archived -> draft. Publishing again goes through the publication rules. */
    restore: (ctx: RequestContext, input: { productId: string; expectedVersion: number }) => transition(ctx, input, "restore"),

    /** The full admin view of one product, any status. */
    async get(ctx: RequestContext, input: { productId: string }): Promise<CatalogResult<ProductView>> {
      await ctx.authorize(CATALOG_PERMISSIONS.productsRead);
      const data = await runInTransaction(
        pool,
        async (tx) => {
          const [product] = await tx.db.select().from(products).where(eq(products.id, input.productId)).limit(1);
          if (!product) return null;
          return {
            product,
            categories: await tx.db.select({ id: productCategories.categoryId }).from(productCategories).where(eq(productCategories.productId, product.id)),
            translations: await tx.db.select().from(productTranslations).where(eq(productTranslations.productId, product.id)).orderBy(asc(productTranslations.locale)),
            values: await tx.db
              .select({ row: productAttributeValues, attributePosition: attributes.position, valuePosition: attributeValues.position })
              .from(productAttributeValues)
              .innerJoin(attributes, eq(attributes.id, productAttributeValues.attributeId))
              .leftJoin(attributeValues, eq(attributeValues.id, productAttributeValues.valueId))
              .where(eq(productAttributeValues.productId, product.id))
              .orderBy(asc(attributes.position), asc(attributes.key), asc(attributeValues.position)),
            texts: await tx.db
              .select({ id: productAttributeValueTranslations.productAttributeValueId, locale: productAttributeValueTranslations.locale, text: productAttributeValueTranslations.textValue })
              .from(productAttributeValueTranslations)
              .innerJoin(productAttributeValues, eq(productAttributeValues.id, productAttributeValueTranslations.productAttributeValueId))
              .where(eq(productAttributeValues.productId, product.id))
              .orderBy(asc(productAttributeValueTranslations.locale)),
          };
        },
        { isolation: "repeatable read" },
      );
      if (!data) return notFound("productId");
      const { product } = data;

      const textsByRow = new Map<string, Translation[]>();
      for (const t of data.texts) {
        textsByRow.set(t.id, [...(textsByRow.get(t.id) ?? []), { locale: t.locale as Translation["locale"], name: t.text, slug: null, description: "", seoTitle: null, seoDescription: null }]);
      }
      const values: DescriptiveValue[] = [];
      const selects = new Map<string, string[]>();
      for (const { row } of data.values) {
        if (row.valueType === "select" && row.valueId) {
          const list = selects.get(row.attributeId);
          if (list) list.push(row.valueId);
          else {
            const created = [row.valueId];
            selects.set(row.attributeId, created);
            values.push({ attributeId: row.attributeId, valueType: "select", valueIds: created });
          }
        } else if (row.valueType === "number" && row.numberValue !== null) {
          values.push({ attributeId: row.attributeId, valueType: "number", number: parseDecimal(row.numberValue) ?? row.numberValue });
        } else if (row.valueType === "boolean" && row.booleanValue !== null) {
          values.push({ attributeId: row.attributeId, valueType: "boolean", boolean: row.booleanValue });
        } else if (row.valueType === "text") {
          values.push({ attributeId: row.attributeId, valueType: "text", text: textsByRow.get(row.id) ?? [] });
        }
      }

      const others = data.categories.map((c) => c.id).filter((id) => id !== product.primaryCategoryId).sort();
      return valid({
        id: product.id,
        status: product.status,
        version: product.version,
        brandId: product.brandId,
        primaryCategoryId: product.primaryCategoryId,
        categoryIds: [product.primaryCategoryId, ...others],
        axisCount: product.axisCount,
        translations: data.translations.map((t) => ({
          locale: t.locale as Translation["locale"],
          name: t.name,
          slug: t.slug,
          description: t.description,
          seoTitle: t.seoTitle,
          seoDescription: t.seoDescription,
        })),
        attributes: values,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
        publishedAt: product.publishedAt,
        archivedAt: product.archivedAt,
      });
    },
  };
}

export type ProductService = ReturnType<typeof createProductService>;
