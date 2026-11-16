import { and, asc, count, eq, inArray, ne, or } from "drizzle-orm";

import { runInTransaction } from "@/shared/db/transaction";
import type { RequestContext } from "@/shared/kernel/authorization";

import type { AttributeRecord, ValueRecord } from "../domain/attributes";
import { planAxes, planAxisValues, validateAxisChange, type ProductAxis } from "../domain/axes";
import { parseBarcode } from "../domain/codes";
import { invalid, issue, valid, type CatalogIssue } from "../domain/errors";
import { CATALOG_EVENT_TYPES, productEvent, variantEvent } from "../domain/events";
import { CATALOG_PERMISSIONS } from "../domain/permissions";
import { planVariants, type VariantInput } from "../domain/variants";
import { attributes, attributeValues, productAxes, productAxisValues, productImages, products, variants } from "../infrastructure/schema";

import { mapUniqueViolations, notFound, type CatalogDeps, type CatalogResult, type Db } from "./support";

export interface AxisView {
  readonly position: number;
  readonly attributeId: string;
  /** Offered values in display order. */
  readonly valueIds: readonly string[];
}

export interface VariantView {
  readonly id: string;
  readonly sku: string;
  readonly barcode: string | null;
  readonly status: "active" | "discontinued";
  readonly position: number;
  /** One value per axis, in axis order. */
  readonly valueIds: readonly string[];
  readonly createdAt: Date;
  readonly discontinuedAt: Date | null;
}

export interface ProductVariantsView {
  readonly productId: string;
  readonly version: number;
  readonly axes: readonly AxisView[];
  readonly variants: readonly VariantView[];
}

interface LockedProduct {
  readonly id: string;
  readonly status: "draft" | "active" | "archived";
  readonly version: number;
  readonly axisCount: number;
}

const versionConflict = (current: number): CatalogResult<never> => invalid([issue("version_conflict", "expectedVersion", { current })]);

/** Every Step 5A write starts here: the product row is the lock that serializes its structure. */
async function lockProduct(db: Db, productId: string): Promise<LockedProduct | null> {
  const [row] = await db
    .select({ id: products.id, status: products.status, version: products.version, axisCount: products.axisCount })
    .from(products)
    .where(eq(products.id, productId))
    .for("update")
    .limit(1);
  return row ?? null;
}

/** Locks the product and applies the shared preconditions; `expectedVersion` is checked when given. */
async function openProduct(db: Db, productId: string, expectedVersion?: number): Promise<{ product: LockedProduct } | { failure: CatalogResult<never> }> {
  const product = await lockProduct(db, productId);
  if (!product) return { failure: notFound("productId") };
  if (expectedVersion !== undefined && product.version !== expectedVersion) return { failure: versionConflict(product.version) };
  if (product.status === "archived") return { failure: invalid([issue("product_archived", "productId")]) };
  return { product };
}

async function bumpVersion(db: Db, product: LockedProduct, at: Date, extra: { axisCount?: number } = {}): Promise<number> {
  const version = product.version + 1;
  await db.update(products).set({ ...extra, version, updatedAt: at }).where(eq(products.id, product.id));
  return version;
}

async function loadAxes(db: Db, productId: string): Promise<{ axes: ProductAxis[]; offered: Map<number, string[]> }> {
  const axisRows = await db.select({ position: productAxes.position, attributeId: productAxes.attributeId }).from(productAxes).where(eq(productAxes.productId, productId)).orderBy(asc(productAxes.position));
  const valueRows = await db
    .select({ position: productAxisValues.position, valueId: productAxisValues.valueId })
    .from(productAxisValues)
    .where(eq(productAxisValues.productId, productId))
    .orderBy(asc(productAxisValues.sortOrder), asc(productAxisValues.valueId));
  const offered = new Map<number, string[]>(axisRows.map((a) => [a.position, []]));
  for (const v of valueRows) offered.get(v.position)?.push(v.valueId);
  return { axes: axisRows, offered };
}

async function variantCount(db: Db, productId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(variants).where(eq(variants.productId, productId));
  return row?.n ?? 0;
}

const valueColumns = [variants.value1, variants.value2, variants.value3] as const;

export function createVariantService({ pool, now }: CatalogDeps) {
  return {
    /**
     * Replaces the product's axes (an ordered list of variant-axis attributes). Allowed while the
     * product has no variants, or when the structure does not change. Axes that keep their
     * attribute and position keep their offered values; removed axes lose theirs.
     */
    async setAxes(ctx: RequestContext, input: { productId: string; expectedVersion: number; attributeIds: readonly string[] }): Promise<CatalogResult<{ productId: string; version: number }>> {
      await ctx.authorize(CATALOG_PERMISSIONS.productsManage);
      return mapUniqueViolations(() =>
        runInTransaction(pool, async (tx) => {
          const opened = await openProduct(tx.db, input.productId, input.expectedVersion);
          if ("failure" in opened) return opened.failure;
          const { product } = opened;

          const ids = [...new Set(input.attributeIds)];
          const rows = ids.length
            ? await tx.db
                .select({ id: attributes.id, usage: attributes.usage, valueType: attributes.valueType, axisKind: attributes.axisKind, status: attributes.status })
                .from(attributes)
                .where(inArray(attributes.id, ids))
                .for("share")
            : [];
          const planned = planAxes(new Map(rows.map((a) => [a.id, a as AttributeRecord])), input.attributeIds);
          if (!planned.ok) return planned;

          const current = await loadAxes(tx.db, product.id);
          const changed = validateAxisChange(current.axes, planned.value, await variantCount(tx.db, product.id));
          if (!changed.ok) return changed;
          // A list identical to the stored one changes nothing: no version bump, no event.
          if (current.axes.length === planned.value.length && planned.value.every((a, i) => current.axes[i]?.attributeId === a.attributeId && current.axes[i]?.position === a.position)) {
            return valid({ productId: product.id, version: product.version });
          }

          const keeps = (a: ProductAxis) => planned.value.some((n) => n.attributeId === a.attributeId && n.position === a.position);
          const removed = current.axes.filter((a) => !keeps(a)).map((a) => a.attributeId);
          const added = planned.value.filter((n) => !current.axes.some((a) => a.attributeId === n.attributeId && a.position === n.position));

          if (removed.length > 0) {
            const [linked] = await tx.db
              .select({ n: count() })
              .from(productImages)
              .where(and(eq(productImages.productId, product.id), inArray(productImages.colorAttributeId, removed)));
            if ((linked?.n ?? 0) > 0) return invalid([issue("axis_in_use", "axes", { images: linked?.n ?? 0 })]);
            await tx.db.delete(productAxisValues).where(and(eq(productAxisValues.productId, product.id), inArray(productAxisValues.attributeId, removed)));
            await tx.db.delete(productAxes).where(and(eq(productAxes.productId, product.id), inArray(productAxes.attributeId, removed)));
          }
          if (added.length > 0) await tx.db.insert(productAxes).values(added.map((a) => ({ productId: product.id, position: a.position, attributeId: a.attributeId })));

          const version = await bumpVersion(tx.db, product, now(), { axisCount: planned.value.length });
          await tx.events.add(productEvent(CATALOG_EVENT_TYPES.productUpdated, product.id));
          return valid({ productId: product.id, version });
        }),
      );
    },

    /** Offers more values on one of the product's axes. Values already offered are skipped. */
    async offerValues(ctx: RequestContext, input: { productId: string; expectedVersion: number; attributeId: string; valueIds: readonly string[] }): Promise<CatalogResult<{ productId: string; version: number }>> {
      await ctx.authorize(CATALOG_PERMISSIONS.productsManage);
      return runInTransaction(pool, async (tx) => {
        const opened = await openProduct(tx.db, input.productId, input.expectedVersion);
        if ("failure" in opened) return opened.failure;
        const { product } = opened;

        const current = await loadAxes(tx.db, product.id);
        const axis = current.axes.find((a) => a.attributeId === input.attributeId);
        if (!axis) return invalid([issue("not_an_axis_attribute", "attributeId")]);

        const ids = [...new Set(input.valueIds)];
        const rows = ids.length
          ? await tx.db.select({ id: attributeValues.id, attributeId: attributeValues.attributeId, status: attributeValues.status }).from(attributeValues).where(inArray(attributeValues.id, ids)).for("share")
          : [];
        const offered = current.offered.get(axis.position) ?? [];
        const planned = planAxisValues(axis, new Map(rows.map((v) => [v.id, v as ValueRecord])), new Set(offered), input.valueIds);
        if (!planned.ok) return planned;

        // Every value was already offered: nothing changes, so no version bump and no event.
        if (planned.value.length === 0) return valid({ productId: product.id, version: product.version });

        await tx.db.insert(productAxisValues).values(
          planned.value.map((valueId, i) => ({ productId: product.id, valueId, attributeId: axis.attributeId, position: axis.position, sortOrder: offered.length + i })),
        );
        const version = await bumpVersion(tx.db, product, now());
        await tx.events.add(productEvent(CATALOG_EVENT_TYPES.productUpdated, product.id));
        return valid({ productId: product.id, version });
      });
    },

    /** Withdraws offered values that no variant and no image uses. */
    async withdrawValues(ctx: RequestContext, input: { productId: string; expectedVersion: number; attributeId: string; valueIds: readonly string[] }): Promise<CatalogResult<{ productId: string; version: number }>> {
      await ctx.authorize(CATALOG_PERMISSIONS.productsManage);
      return runInTransaction(pool, async (tx) => {
        const opened = await openProduct(tx.db, input.productId, input.expectedVersion);
        if ("failure" in opened) return opened.failure;
        const { product } = opened;

        const current = await loadAxes(tx.db, product.id);
        const axis = current.axes.find((a) => a.attributeId === input.attributeId);
        if (!axis) return invalid([issue("not_an_axis_attribute", "attributeId")]);

        const offered = new Set(current.offered.get(axis.position) ?? []);
        const ids = [...new Set(input.valueIds)];
        const usedByVariants = ids.length
          ? await tx.db
              .select({ v1: variants.value1, v2: variants.value2, v3: variants.value3 })
              .from(variants)
              .where(and(eq(variants.productId, product.id), or(...valueColumns.map((c) => inArray(c, ids)))))
          : [];
        const usedByImages = ids.length
          ? await tx.db.select({ id: productImages.colorValueId }).from(productImages).where(and(eq(productImages.productId, product.id), inArray(productImages.colorValueId, ids)))
          : [];
        const used = new Set<string>([...usedByVariants.flatMap((r) => [r.v1, r.v2, r.v3]), ...usedByImages.map((r) => r.id)].filter((v): v is string => v !== null));

        const issues: CatalogIssue[] = [];
        const seen = new Set<string>();
        input.valueIds.forEach((valueId, index) => {
          const path = `values[${index}]`;
          if (seen.has(valueId)) return void issues.push(issue("duplicate_value", path));
          seen.add(valueId);
          if (!offered.has(valueId)) issues.push(issue("value_not_offered", path, { position: axis.position }));
          else if (used.has(valueId)) issues.push(issue("value_in_use", path));
        });
        if (issues.length > 0) return invalid(issues);

        // An empty list withdraws nothing: no version bump and no event.
        if (ids.length === 0) return valid({ productId: product.id, version: product.version });

        await tx.db.delete(productAxisValues).where(and(eq(productAxisValues.productId, product.id), inArray(productAxisValues.valueId, ids)));
        const version = await bumpVersion(tx.db, product, now());
        await tx.events.add(productEvent(CATALOG_EVENT_TYPES.productUpdated, product.id));
        return valid({ productId: product.id, version });
      });
    },

    /**
     * Adds variants (one offered value per axis each). Locks the product and increments its
     * version, without requiring `expectedVersion`. Variants are never deleted.
     */
    async create(ctx: RequestContext, input: { productId: string; variants: readonly VariantInput[] }): Promise<CatalogResult<{ productId: string; version: number; variants: readonly { variantId: string; sku: string }[] }>> {
      await ctx.authorize(CATALOG_PERMISSIONS.productsManage);
      return mapUniqueViolations(() =>
        runInTransaction(pool, async (tx) => {
          const opened = await openProduct(tx.db, input.productId);
          if ("failure" in opened) return opened.failure;
          const { product } = opened;

          const { axes, offered } = await loadAxes(tx.db, product.id);
          const existing = await tx.db
            .select({ sku: variants.sku, barcode: variants.barcode, v1: variants.value1, v2: variants.value2, v3: variants.value3 })
            .from(variants)
            .where(eq(variants.productId, product.id));
          const planned = planVariants(
            axes.map((a) => new Set(offered.get(a.position) ?? [])),
            existing.map((v) => ({ sku: v.sku, barcode: v.barcode, values: [v.v1, v.v2, v.v3].filter((x): x is string => x !== null) })),
            input.variants,
          );
          if (!planned.ok) return planned;
          if (planned.value.length === 0) return valid({ productId: product.id, version: product.version, variants: [] });

          // SKU and barcode are unique across the catalog; report clashes with other products per row.
          const skus = planned.value.map((v) => v.sku);
          const barcodes = planned.value.flatMap((v) => (v.barcode ? [v.barcode] : []));
          const taken = await tx.db
            .select({ sku: variants.sku, barcode: variants.barcode })
            .from(variants)
            .where(or(inArray(variants.sku, skus), barcodes.length ? inArray(variants.barcode, barcodes) : undefined));
          const takenSkus = new Set(taken.map((t) => t.sku));
          const takenBarcodes = new Set(taken.flatMap((t) => (t.barcode ? [t.barcode] : [])));
          const clashes = planned.value.flatMap((v, i) => [
            ...(takenSkus.has(v.sku) ? [issue("duplicate_sku", `variants[${i}].sku`)] : []),
            ...(v.barcode && takenBarcodes.has(v.barcode) ? [issue("duplicate_barcode", `variants[${i}].barcode`)] : []),
          ]);
          if (clashes.length > 0) return invalid(clashes);

          const at = now();
          const created = await tx.db
            .insert(variants)
            .values(
              planned.value.map((v, i) => ({
                productId: product.id,
                axisCount: product.axisCount,
                sku: v.sku,
                barcode: v.barcode,
                position: existing.length + i,
                value1: v.values[0] ?? null,
                value2: v.values[1] ?? null,
                value3: v.values[2] ?? null,
                createdAt: at,
                updatedAt: at,
              })),
            )
            .returning({ id: variants.id, sku: variants.sku });
          const version = await bumpVersion(tx.db, product, at);
          for (const row of created) await tx.events.add(variantEvent(CATALOG_EVENT_TYPES.variantCreated, product.id, row.id));
          return valid({ productId: product.id, version, variants: created.map((r) => ({ variantId: r.id, sku: r.sku })) });
        }),
      );
    },

    /** Sets or clears a variant's barcode. The SKU never changes. Locks the product and increments its version. */
    async updateBarcode(ctx: RequestContext, input: { variantId: string; barcode: string | null }): Promise<CatalogResult<{ variantId: string; productId: string; version: number }>> {
      await ctx.authorize(CATALOG_PERMISSIONS.productsManage);
      const parsed = parseBarcode(input.barcode, "barcode");
      if (!parsed.ok) return parsed;
      return mapUniqueViolations(() =>
        runInTransaction(pool, async (tx) => {
          const found = await locateVariant(tx.db, input.variantId);
          if (!found) return notFound("variantId");
          const opened = await openProduct(tx.db, found.productId);
          if ("failure" in opened) return opened.failure;
          const { product } = opened;

          const [variant] = await tx.db.select({ barcode: variants.barcode }).from(variants).where(eq(variants.id, input.variantId)).for("update").limit(1);
          if (!variant) return notFound("variantId");
          // The same barcode (or none, still none) changes nothing: no version bump, no event.
          if (variant.barcode === parsed.value) return valid({ variantId: input.variantId, productId: product.id, version: product.version });

          if (parsed.value !== null) {
            const clash = await tx.db.select({ id: variants.id }).from(variants).where(and(eq(variants.barcode, parsed.value), ne(variants.id, input.variantId))).limit(1);
            if (clash.length > 0) return invalid([issue("duplicate_barcode", "barcode")]);
          }
          const at = now();
          await tx.db.update(variants).set({ barcode: parsed.value, updatedAt: at }).where(eq(variants.id, input.variantId));
          const version = await bumpVersion(tx.db, product, at);
          await tx.events.add(productEvent(CATALOG_EVENT_TYPES.productUpdated, product.id));
          return valid({ variantId: input.variantId, productId: product.id, version });
        }),
      );
    },

    /** active -> discontinued, one way. A repeat is `invalid_transition`. Locks the product and increments its version. */
    async discontinue(ctx: RequestContext, input: { variantId: string }): Promise<CatalogResult<{ variantId: string; productId: string; version: number }>> {
      await ctx.authorize(CATALOG_PERMISSIONS.productsManage);
      return runInTransaction(pool, async (tx) => {
        const found = await locateVariant(tx.db, input.variantId);
        if (!found) return notFound("variantId");
        const opened = await openProduct(tx.db, found.productId);
        if ("failure" in opened) return opened.failure;
        const { product } = opened;

        const [variant] = await tx.db.select({ status: variants.status }).from(variants).where(eq(variants.id, input.variantId)).for("update").limit(1);
        if (!variant) return notFound("variantId");
        if (variant.status !== "active") return invalid([issue("invalid_transition", "status", { from: variant.status, action: "discontinue" })]);

        const at = now();
        await tx.db.update(variants).set({ status: "discontinued", discontinuedAt: at, updatedAt: at }).where(eq(variants.id, input.variantId));
        const version = await bumpVersion(tx.db, product, at);
        await tx.events.add(variantEvent(CATALOG_EVENT_TYPES.variantDiscontinued, product.id, input.variantId));
        return valid({ variantId: input.variantId, productId: product.id, version });
      });
    },

    /** Axes, offered values and every variant (discontinued included) of one product. */
    async list(ctx: RequestContext, input: { productId: string }): Promise<CatalogResult<ProductVariantsView>> {
      await ctx.authorize(CATALOG_PERMISSIONS.productsRead);
      const data = await runInTransaction(
        pool,
        async (tx) => {
          const [product] = await tx.db.select({ id: products.id, version: products.version }).from(products).where(eq(products.id, input.productId)).limit(1);
          if (!product) return null;
          const { axes, offered } = await loadAxes(tx.db, product.id);
          const rows = await tx.db.select().from(variants).where(eq(variants.productId, product.id)).orderBy(asc(variants.position), asc(variants.sku));
          return { product, axes, offered, rows };
        },
        { isolation: "repeatable read" },
      );
      if (!data) return notFound("productId");
      return valid({
        productId: data.product.id,
        version: data.product.version,
        axes: data.axes.map((a) => ({ position: a.position, attributeId: a.attributeId, valueIds: data.offered.get(a.position) ?? [] })),
        variants: data.rows.map((v) => ({
          id: v.id,
          sku: v.sku,
          barcode: v.barcode,
          status: v.status,
          position: v.position,
          valueIds: [v.value1, v.value2, v.value3].filter((x): x is string => x !== null),
          createdAt: v.createdAt,
          discontinuedAt: v.discontinuedAt,
        })),
      });
    },
  };
}

/** The owning product of a variant (unlocked read; the caller then locks the product first, then re-reads the variant). */
async function locateVariant(db: Db, variantId: string): Promise<{ productId: string } | null> {
  const [row] = await db.select({ productId: variants.productId }).from(variants).where(eq(variants.id, variantId)).limit(1);
  return row ?? null;
}

export type VariantService = ReturnType<typeof createVariantService>;
