import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";

import { runInTransaction } from "@/shared/db/transaction";
import type { Locale } from "@/shared/i18n/config";

import { parseDecimal } from "../domain/attributes";
import { valid } from "../domain/errors";
import { REQUIRED_LOCALE } from "../domain/localization";
import {
  attributes,
  attributeTranslations,
  attributeValues,
  attributeValueTranslations,
  brands,
  brandTranslations,
  categories,
  categoryTranslations,
  mediaAssets,
  productAttributeValues,
  productAttributeValueTranslations,
  productAxes,
  productAxisValues,
  productCategories,
  productImages,
  productImageTranslations,
  products,
  productTranslations,
  variants,
} from "../infrastructure/schema";

import { notFound, type CatalogDeps, type CatalogResult, type Db } from "./support";

/**
 * The public, read-only view of the catalog for the storefront (ADR-031). It needs no
 * permission and shows only what is published: active products, and categories that are active
 * together with all their ancestors. Internal data (SKUs, barcodes, statuses, versions) is never
 * exposed. Text falls back to Persian when a locale has no translation, and every slug is
 * returned for all locales so the language switcher can link to the counterpart page.
 */

export interface CategoryRef {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly slug: string;
}

export interface StorefrontCategory extends CategoryRef {
  readonly slugs: Readonly<Record<string, string>>;
  readonly children: readonly StorefrontCategory[];
}

export interface StorefrontCategoryPage {
  readonly category: CategoryRef & { readonly slugs: Readonly<Record<string, string>>; readonly description: string; readonly seoTitle: string | null; readonly seoDescription: string | null };
  /** Root to parent; the category itself is not included. */
  readonly breadcrumb: readonly CategoryRef[];
  readonly children: readonly StorefrontCategory[];
}

export interface StorefrontImage {
  readonly id: string;
  readonly view: string;
  readonly position: number;
  readonly colorValueId: string | null;
  readonly storageKey: string;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly alt: string | null;
}

export interface StorefrontValue {
  readonly valueId: string;
  readonly key: string;
  readonly label: string;
  readonly swatchHex: string | null;
}

export interface ProductCard {
  readonly id: string;
  readonly slug: string;
  readonly slugs: Readonly<Record<string, string>>;
  readonly name: string;
  readonly brand: { readonly id: string; readonly key: string; readonly name: string } | null;
  /** The primary image, or null when the product has none. */
  readonly image: StorefrontImage | null;
  /** Colours offered by variants that are still active. */
  readonly colors: readonly StorefrontValue[];
  readonly publishedAt: Date;
}

export interface ProductPage {
  readonly items: readonly ProductCard[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface StorefrontAxis {
  readonly attributeId: string;
  readonly key: string;
  readonly name: string;
  readonly kind: "color" | "size" | "other";
  readonly position: number;
  /** Values that an active variant uses, in display order. */
  readonly values: readonly StorefrontValue[];
}

export interface StorefrontVariant {
  readonly id: string;
  readonly position: number;
  /** One value per axis, in axis order. */
  readonly valueIds: readonly string[];
}

export type StorefrontAttribute = { readonly attributeId: string; readonly key: string; readonly name: string; readonly unit: string | null } & (
  | { readonly type: "select"; readonly values: readonly string[] }
  | { readonly type: "number"; readonly number: string }
  | { readonly type: "boolean"; readonly boolean: boolean }
  | { readonly type: "text"; readonly text: string }
);

export interface StorefrontProduct {
  readonly id: string;
  readonly slug: string;
  readonly slugs: Readonly<Record<string, string>>;
  readonly name: string;
  readonly description: string;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  readonly brand: { readonly id: string; readonly key: string; readonly name: string; readonly slug: string } | null;
  /** Root to primary category; empty when any of them is no longer visible. */
  readonly breadcrumb: readonly CategoryRef[];
  readonly axes: readonly StorefrontAxis[];
  readonly variants: readonly StorefrontVariant[];
  readonly images: readonly StorefrontImage[];
  readonly attributes: readonly StorefrontAttribute[];
  readonly publishedAt: Date;
}

const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 60;

/** The row for `locale`, else the Persian one, else any. */
function pick<T extends { locale: string }>(rows: readonly T[] | undefined, locale: string): T | undefined {
  if (!rows || rows.length === 0) return undefined;
  return rows.find((r) => r.locale === locale) ?? rows.find((r) => r.locale === REQUIRED_LOCALE) ?? rows[0];
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const list = map.get(key(row));
    if (list) list.push(row);
    else map.set(key(row), [row]);
  }
  return map;
}

const slugsOf = (rows: readonly { locale: string; slug: string }[]): Record<string, string> => Object.fromEntries(rows.map((r) => [r.locale, r.slug]));

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

interface VisibleCategory {
  readonly id: string;
  readonly parentId: string | null;
  readonly key: string;
  readonly position: number;
  readonly name: string;
  readonly slug: string;
  readonly slugs: Record<string, string>;
  readonly description: string;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
}

/** Active categories whose ancestors are all active, localized. */
async function visibleCategories(db: Db, locale: string): Promise<Map<string, VisibleCategory>> {
  const rows = await db.select({ id: categories.id, parentId: categories.parentId, key: categories.key, position: categories.position, status: categories.status }).from(categories);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const memo = new Map<string, boolean>();
  const visible = (id: string): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const row = byId.get(id);
    const result = !!row && row.status === "active" && (row.parentId === null || visible(row.parentId));
    memo.set(id, result);
    return result;
  };
  const ids = rows.filter((r) => visible(r.id)).map((r) => r.id);
  if (ids.length === 0) return new Map();

  const translations = groupBy(await db.select().from(categoryTranslations).where(inArray(categoryTranslations.categoryId, ids)), (t) => t.categoryId);
  const result = new Map<string, VisibleCategory>();
  for (const id of ids) {
    const row = byId.get(id)!;
    const all = translations.get(id) ?? [];
    const t = pick(all, locale);
    if (!t) continue; // a category without any translation cannot be shown
    result.set(id, {
      id,
      parentId: row.parentId,
      key: row.key,
      position: row.position,
      name: t.name,
      slug: t.slug,
      slugs: slugsOf(all),
      description: t.description,
      seoTitle: t.seoTitle,
      seoDescription: t.seoDescription,
    });
  }
  return result;
}

function childrenOf(all: ReadonlyMap<string, VisibleCategory>, parentId: string | null): StorefrontCategory[] {
  return [...all.values()]
    .filter((c) => c.parentId === parentId)
    .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))
    .map((c) => ({ id: c.id, key: c.key, name: c.name, slug: c.slug, slugs: c.slugs, children: childrenOf(all, c.id) }));
}

const refOf = (c: VisibleCategory): CategoryRef => ({ id: c.id, key: c.key, name: c.name, slug: c.slug });

/** Root to the category's parent; null when an ancestor is not visible. */
function ancestorsOf(all: ReadonlyMap<string, VisibleCategory>, category: VisibleCategory): CategoryRef[] | null {
  const chain: CategoryRef[] = [];
  let parentId = category.parentId;
  while (parentId !== null) {
    const parent = all.get(parentId);
    if (!parent) return null;
    chain.unshift(refOf(parent));
    parentId = parent.parentId;
  }
  return chain;
}

function subtreeIds(all: ReadonlyMap<string, VisibleCategory>, rootId: string): string[] {
  const out = [rootId];
  for (const id of out) for (const c of all.values()) if (c.parentId === id) out.push(c.id);
  return out;
}

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

async function loadImages(db: Db, productIds: readonly string[], locale: string): Promise<Map<string, StorefrontImage[]>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: productImages.id,
      productId: productImages.productId,
      view: productImages.view,
      position: productImages.position,
      colorValueId: productImages.colorValueId,
      storageKey: mediaAssets.storageKey,
      contentType: mediaAssets.contentType,
      width: mediaAssets.width,
      height: mediaAssets.height,
    })
    .from(productImages)
    .innerJoin(mediaAssets, eq(mediaAssets.id, productImages.assetId))
    .where(inArray(productImages.productId, [...productIds]))
    .orderBy(asc(productImages.position));
  const alts = rows.length
    ? groupBy(await db.select().from(productImageTranslations).where(inArray(productImageTranslations.imageId, rows.map((r) => r.id))), (a) => a.imageId)
    : new Map();
  const byProduct = new Map<string, StorefrontImage[]>();
  for (const r of rows) {
    const alt = pick<{ locale: string; altText: string }>(alts.get(r.id), locale)?.altText ?? null;
    const image: StorefrontImage = { id: r.id, view: r.view, position: r.position, colorValueId: r.colorValueId, storageKey: r.storageKey, contentType: r.contentType, width: r.width, height: r.height, alt };
    byProduct.set(r.productId, [...(byProduct.get(r.productId) ?? []), image]);
  }
  return byProduct;
}

async function valueLabels(db: Db, valueIds: readonly string[], locale: string): Promise<Map<string, string>> {
  if (valueIds.length === 0) return new Map();
  const rows = groupBy(await db.select().from(attributeValueTranslations).where(inArray(attributeValueTranslations.valueId, [...valueIds])), (r) => r.valueId);
  return new Map([...rows].map(([id, list]) => [id, pick(list, locale)?.label ?? ""]));
}

/** Values of each product's axes that an active variant uses, with the axis they belong to. */
async function usedAxisValues(db: Db, productIds: readonly string[], locale: string) {
  if (productIds.length === 0) return new Map<string, { attributeId: string; position: number; kind: string; values: StorefrontValue[] }[]>();
  const active = await db
    .select({ productId: variants.productId, v1: variants.value1, v2: variants.value2, v3: variants.value3 })
    .from(variants)
    .where(and(inArray(variants.productId, [...productIds]), eq(variants.status, "active")));
  const used = new Set(active.flatMap((v) => [v.v1, v.v2, v.v3].filter((x): x is string => x !== null)));
  const offered = await db
    .select({
      productId: productAxisValues.productId,
      valueId: productAxisValues.valueId,
      attributeId: productAxisValues.attributeId,
      position: productAxisValues.position,
      sortOrder: productAxisValues.sortOrder,
      kind: attributes.axisKind,
      key: attributeValues.key,
      swatchHex: attributeValues.swatchHex,
      valuePosition: attributeValues.position,
    })
    .from(productAxisValues)
    .innerJoin(attributes, eq(attributes.id, productAxisValues.attributeId))
    .innerJoin(attributeValues, eq(attributeValues.id, productAxisValues.valueId))
    .where(inArray(productAxisValues.productId, [...productIds]))
    .orderBy(asc(productAxisValues.position), asc(productAxisValues.sortOrder), asc(attributeValues.position));
  const usedRows = offered.filter((o) => used.has(o.valueId));
  const labels = await valueLabels(db, [...new Set(usedRows.map((o) => o.valueId))], locale);

  const result = new Map<string, { attributeId: string; position: number; kind: string; values: StorefrontValue[] }[]>();
  for (const [productId, rows] of groupBy(usedRows, (o) => o.productId)) {
    const axes = groupBy(rows, (o) => o.position);
    result.set(
      productId,
      [...axes].map(([position, list]) => ({
        attributeId: list[0]!.attributeId,
        position,
        kind: list[0]!.kind ?? "other",
        values: list.map((o) => ({ valueId: o.valueId, key: o.key, label: labels.get(o.valueId) ?? o.key, swatchHex: o.swatchHex })),
      })),
    );
  }
  return result;
}

export function createStorefrontService({ pool }: CatalogDeps) {
  const read = <T>(work: (db: Db) => Promise<T>): Promise<T> => runInTransaction(pool, (tx) => work(tx.db), { isolation: "repeatable read" });

  /** Maps a product row set to cards (primary image, brand, colours). */
  async function cards(db: Db, rows: readonly { id: string; publishedAt: Date | null; brandId: string | null }[], locale: string): Promise<ProductCard[]> {
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return [];
    const translations = groupBy(await db.select().from(productTranslations).where(inArray(productTranslations.productId, ids)), (t) => t.productId);
    const images = await loadImages(db, ids, locale);
    const axes = await usedAxisValues(db, ids, locale);
    const brandIds = [...new Set(rows.flatMap((r) => (r.brandId ? [r.brandId] : [])))];
    const brandRows = brandIds.length ? await db.select({ id: brands.id, key: brands.key }).from(brands).where(inArray(brands.id, brandIds)) : [];
    const brandNames = brandIds.length ? groupBy(await db.select().from(brandTranslations).where(inArray(brandTranslations.brandId, brandIds)), (t) => t.brandId) : new Map();
    const brandOf = new Map(brandRows.map((b) => [b.id, { id: b.id, key: b.key, name: pick<{ locale: string; name: string }>(brandNames.get(b.id), locale)?.name ?? b.key }]));

    return rows.flatMap((r) => {
      const all = translations.get(r.id) ?? [];
      const t = pick(all, locale);
      if (!t || !r.publishedAt) return [];
      return [
        {
          id: r.id,
          slug: t.slug,
          slugs: slugsOf(all),
          name: t.name,
          brand: r.brandId ? (brandOf.get(r.brandId) ?? null) : null,
          image: images.get(r.id)?.[0] ?? null,
          colors: axes.get(r.id)?.find((a) => a.kind === "color")?.values ?? [],
          publishedAt: r.publishedAt,
        },
      ];
    });
  }

  return {
    /** The visible category tree, ordered by position then key. */
    async categoryTree(input: { locale: Locale }): Promise<CatalogResult<readonly StorefrontCategory[]>> {
      return valid(await read(async (db) => childrenOf(await visibleCategories(db, input.locale), null)));
    },

    /** One visible category by slug (in `locale`, or any locale's slug), with its ancestors and children. */
    async getCategory(input: { locale: Locale; slug: string }): Promise<CatalogResult<StorefrontCategoryPage>> {
      const page = await read(async (db) => {
        const all = await visibleCategories(db, input.locale);
        const found = [...all.values()].find((c) => c.slugs[input.locale] === input.slug) ?? [...all.values()].find((c) => Object.values(c.slugs).includes(input.slug));
        if (!found) return null;
        const breadcrumb = ancestorsOf(all, found);
        if (!breadcrumb) return null;
        const { id, key, name, slug, slugs, description, seoTitle, seoDescription } = found;
        return { category: { id, key, name, slug, slugs, description, seoTitle, seoDescription }, breadcrumb, children: childrenOf(all, found.id) };
      });
      return page ? valid(page) : notFound("slug");
    },

    /**
     * Published products, newest first, optionally within a visible category and its visible
     * subcategories. Draft, unpublished and archived products never appear.
     */
    async listProducts(input: { locale: Locale; categoryId?: string; page?: number; pageSize?: number }): Promise<CatalogResult<ProductPage>> {
      // Non-finite input (NaN, Infinity) falls back to the defaults instead of reaching SQL.
      const wanted = (n: number | undefined, fallback: number) => (n !== undefined && Number.isFinite(n) ? Math.trunc(n) : fallback);
      const pageSize = Math.min(Math.max(wanted(input.pageSize, DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
      const page = Math.max(wanted(input.page, 1), 1);
      const result = await read(async (db) => {
        let scope = sql`true`;
        if (input.categoryId !== undefined) {
          const all = await visibleCategories(db, input.locale);
          if (!all.has(input.categoryId)) return null;
          scope = sql`${products.id} IN (SELECT ${productCategories.productId} FROM ${productCategories} WHERE ${inArray(productCategories.categoryId, subtreeIds(all, input.categoryId))})`;
        }
        const where = and(eq(products.status, "active"), scope);
        const [total] = await db.select({ n: count() }).from(products).where(where);
        const rows = await db
          .select({ id: products.id, publishedAt: products.publishedAt, brandId: products.brandId })
          .from(products)
          .where(where)
          .orderBy(desc(products.publishedAt), desc(products.id))
          .limit(pageSize)
          .offset((page - 1) * pageSize);
        return { items: await cards(db, rows, input.locale), total: total?.n ?? 0 };
      });
      if (!result) return notFound("categoryId");
      return valid({ ...result, page, pageSize });
    },

    /**
     * One published product by slug. The slug is looked up in `locale` first, then in any
     * locale, so a link in the other language still resolves; compare `slug` with the requested
     * one to redirect to the canonical URL.
     */
    async getProduct(input: { locale: Locale; slug: string }): Promise<CatalogResult<StorefrontProduct>> {
      const product = await read(async (db): Promise<StorefrontProduct | null> => {
        const [match] = await db
          .select({ id: products.id, brandId: products.brandId, primaryCategoryId: products.primaryCategoryId, publishedAt: products.publishedAt })
          .from(productTranslations)
          .innerJoin(products, eq(products.id, productTranslations.productId))
          .where(and(eq(productTranslations.slug, input.slug), eq(products.status, "active")))
          .orderBy(desc(sql`${productTranslations.locale} = ${input.locale}`))
          .limit(1);
        if (!match || !match.publishedAt) return null;

        const translations = await db.select().from(productTranslations).where(eq(productTranslations.productId, match.id));
        const t = pick(translations, input.locale);
        if (!t) return null;

        const images = (await loadImages(db, [match.id], input.locale)).get(match.id) ?? [];
        const usedAxes = (await usedAxisValues(db, [match.id], input.locale)).get(match.id) ?? [];

        const axisRows = await db
          .select({ attributeId: productAxes.attributeId, position: productAxes.position, key: attributes.key })
          .from(productAxes)
          .innerJoin(attributes, eq(attributes.id, productAxes.attributeId))
          .where(eq(productAxes.productId, match.id))
          .orderBy(asc(productAxes.position));
        const axisNames = groupBy(
          axisRows.length ? await db.select().from(attributeTranslations).where(inArray(attributeTranslations.attributeId, axisRows.map((a) => a.attributeId))) : [],
          (n) => n.attributeId,
        );
        const axes: StorefrontAxis[] = axisRows.flatMap((a) => {
          const used = usedAxes.find((u) => u.position === a.position);
          if (!used || used.values.length === 0) return [];
          return [{ attributeId: a.attributeId, key: a.key, name: pick(axisNames.get(a.attributeId), input.locale)?.name ?? a.key, kind: used.kind as StorefrontAxis["kind"], position: a.position, values: used.values }];
        });

        const variantRows = await db
          .select({ id: variants.id, position: variants.position, v1: variants.value1, v2: variants.value2, v3: variants.value3 })
          .from(variants)
          .where(and(eq(variants.productId, match.id), eq(variants.status, "active")))
          .orderBy(asc(variants.position), asc(variants.id));

        let brand: StorefrontProduct["brand"] = null;
        if (match.brandId) {
          const [row] = await db.select({ id: brands.id, key: brands.key }).from(brands).where(eq(brands.id, match.brandId)).limit(1);
          const names = await db.select().from(brandTranslations).where(eq(brandTranslations.brandId, match.brandId));
          const n = pick(names, input.locale);
          if (row && n) brand = { id: row.id, key: row.key, name: n.name, slug: n.slug };
        }

        const all = await visibleCategories(db, input.locale);
        const primary = all.get(match.primaryCategoryId);
        const ancestors = primary ? ancestorsOf(all, primary) : null;
        const breadcrumb = primary && ancestors ? [...ancestors, refOf(primary)] : [];

        return {
          id: match.id,
          slug: t.slug,
          slugs: slugsOf(translations),
          name: t.name,
          description: t.description,
          seoTitle: t.seoTitle,
          seoDescription: t.seoDescription,
          brand,
          breadcrumb,
          axes,
          variants: variantRows.map((v) => ({ id: v.id, position: v.position, valueIds: [v.v1, v.v2, v.v3].filter((x): x is string => x !== null) })),
          images,
          attributes: await descriptiveAttributes(db, match.id, input.locale),
          publishedAt: match.publishedAt,
        };
      });
      return product ? valid(product) : notFound("slug");
    },
  };
}

async function descriptiveAttributes(db: Db, productId: string, locale: string): Promise<StorefrontAttribute[]> {
  const rows = await db.select().from(productAttributeValues).where(eq(productAttributeValues.productId, productId));
  if (rows.length === 0) return [];
  const attributeIds = [...new Set(rows.map((r) => r.attributeId))];
  const defs = await db
    .select({ id: attributes.id, key: attributes.key, unit: attributes.unit, position: attributes.position })
    .from(attributes)
    .where(inArray(attributes.id, attributeIds));
  const names = groupBy(await db.select().from(attributeTranslations).where(inArray(attributeTranslations.attributeId, attributeIds)), (n) => n.attributeId);
  const labels = await valueLabels(db, rows.flatMap((r) => (r.valueId ? [r.valueId] : [])), locale);
  const textRows = rows.filter((r) => r.valueType === "text").map((r) => r.id);
  const texts = textRows.length
    ? groupBy(await db.select().from(productAttributeValueTranslations).where(inArray(productAttributeValueTranslations.productAttributeValueId, textRows)), (t) => t.productAttributeValueId)
    : new Map();

  const out: StorefrontAttribute[] = [];
  for (const def of [...defs].sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))) {
    const mine = rows.filter((r) => r.attributeId === def.id);
    const base = { attributeId: def.id, key: def.key, name: pick(names.get(def.id), locale)?.name ?? def.key, unit: def.unit };
    const first = mine[0];
    if (!first) continue;
    if (first.valueType === "select") out.push({ ...base, type: "select", values: mine.flatMap((r) => (r.valueId ? [labels.get(r.valueId) ?? ""] : [])).filter((l) => l !== "") });
    else if (first.valueType === "number" && first.numberValue !== null) out.push({ ...base, type: "number", number: parseDecimal(first.numberValue) ?? first.numberValue });
    else if (first.valueType === "boolean" && first.booleanValue !== null) out.push({ ...base, type: "boolean", boolean: first.booleanValue });
    else if (first.valueType === "text") {
      const text = pick<{ locale: string; textValue: string }>(texts.get(first.id), locale)?.textValue;
      if (text) out.push({ ...base, type: "text", text });
    }
  }
  return out;
}

export type StorefrontService = ReturnType<typeof createStorefrontService>;
