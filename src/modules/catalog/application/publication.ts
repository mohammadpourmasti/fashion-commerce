import { and, count, eq } from "drizzle-orm";

import { runInTransaction } from "@/shared/db/transaction";
import type { RequestContext } from "@/shared/kernel/authorization";

import { invalid, valid } from "../domain/errors";
import { CATALOG_EVENT_TYPES, productEvent } from "../domain/events";
import { CATALOG_PERMISSIONS } from "../domain/permissions";
import { checkPublishable, nextStatus, type ProductStatus, type PublicationSnapshot } from "../domain/publication";
import { brands, categories, productAxes, productImages, products, productTranslations, variants } from "../infrastructure/schema";

import { openProduct, type LockedProduct } from "./product-lock";
import type { CatalogDeps, CatalogResult, Db } from "./support";

type Referenced = "active" | "archived";

/**
 * Everything the publication rules need, read under the product lock. The primary category and
 * the brand are read `FOR SHARE`, so a concurrent archive of either waits for this transaction.
 */
async function snapshotOf(db: Db, product: LockedProduct): Promise<PublicationSnapshot> {
  const [row] = await db.select({ brandId: products.brandId, primaryCategoryId: products.primaryCategoryId }).from(products).where(eq(products.id, product.id)).limit(1);
  if (!row) throw new Error("locked product disappeared");

  const locales = await db.select({ locale: productTranslations.locale }).from(productTranslations).where(eq(productTranslations.productId, product.id));
  const [category] = await db.select({ status: categories.status }).from(categories).where(eq(categories.id, row.primaryCategoryId)).for("share").limit(1);
  const [brand] = row.brandId ? await db.select({ status: brands.status }).from(brands).where(eq(brands.id, row.brandId)).for("share").limit(1) : [];
  const [axes] = await db.select({ n: count() }).from(productAxes).where(eq(productAxes.productId, product.id));
  const [active] = await db.select({ n: count() }).from(variants).where(and(eq(variants.productId, product.id), eq(variants.status, "active")));
  const [images] = await db.select({ n: count() }).from(productImages).where(eq(productImages.productId, product.id));

  return {
    status: product.status,
    translatedLocales: locales.map((l) => l.locale),
    primaryCategoryStatus: (category?.status ?? "archived") as Referenced,
    brandStatus: row.brandId ? ((brand?.status ?? "archived") as Referenced) : null,
    axisCount: product.axisCount,
    axesDefined: axes?.n ?? 0,
    activeVariants: active?.n ?? 0,
    images: images?.n ?? 0,
  };
}

export function createPublicationService({ pool, now }: CatalogDeps) {
  async function change(
    ctx: RequestContext,
    input: { productId: string; expectedVersion: number },
    action: "publish" | "unpublish",
  ): Promise<CatalogResult<{ productId: string; version: number; status: ProductStatus }>> {
    await ctx.authorize(CATALOG_PERMISSIONS.productsPublish);
    return runInTransaction(pool, async (tx) => {
      const opened = await openProduct(tx.db, input.productId, input.expectedVersion);
      if ("failure" in opened) return opened.failure;
      const { product } = opened;

      const next = action === "publish" ? checkPublishable(await snapshotOf(tx.db, product)) : nextStatus(product.status, "unpublish");
      if (!next.ok) return invalid(next.issues);

      const at = now();
      const version = product.version + 1;
      // publishedAt records the latest publication; unpublishing keeps it.
      await tx.db
        .update(products)
        .set({ status: next.value, ...(action === "publish" ? { publishedAt: at } : {}), version, updatedAt: at })
        .where(eq(products.id, product.id));
      await tx.events.add(productEvent(action === "publish" ? CATALOG_EVENT_TYPES.productPublished : CATALOG_EVENT_TYPES.productUnpublished, product.id));
      return valid({ productId: product.id, version, status: next.value });
    });
  }

  return {
    /**
     * draft -> active once the publication rules hold (Persian translation, active primary
     * category and brand, complete axes, an active variant and an image); every blocking issue is
     * reported together. Not idempotent: a repeat is `invalid_transition`.
     */
    publish: (ctx: RequestContext, input: { productId: string; expectedVersion: number }) => change(ctx, input, "publish"),
    /** active -> draft. The product disappears from the storefront; nothing is deleted. */
    unpublish: (ctx: RequestContext, input: { productId: string; expectedVersion: number }) => change(ctx, input, "unpublish"),
  };
}

export type PublicationService = ReturnType<typeof createPublicationService>;
