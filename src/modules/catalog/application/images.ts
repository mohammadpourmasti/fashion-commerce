import { and, asc, eq, inArray, notInArray, or } from "drizzle-orm";

import { runInTransaction } from "@/shared/db/transaction";
import type { RequestContext } from "@/shared/kernel/authorization";

import type { AttributeRecord } from "../domain/attributes";
import { colorAxisOf } from "../domain/axes";
import { invalid, issue, valid, type CatalogIssue } from "../domain/errors";
import { CATALOG_EVENT_TYPES, productEvent } from "../domain/events";
import { parseTranslations, type Translation } from "../domain/localization";
import { parseAssetMetadata, planImages, type AssetInput, type ColorAxis, type ImageInput, type PlannedImage } from "../domain/media";
import { CATALOG_PERMISSIONS } from "../domain/permissions";
import { attributes, mediaAssets, productImages, productImageTranslations, products } from "../infrastructure/schema";

import { bumpVersion, loadAxes, openProduct } from "./product-lock";
import { mapUniqueViolations, notFound, replaceTranslations, type CatalogDeps, type CatalogResult, type TranslationTable } from "./support";

export interface AssetView {
  readonly id: string;
  readonly storageKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly createdAt: Date;
}

export interface AltText {
  readonly locale: string;
  readonly text: string;
}

export interface ProductImageInput {
  readonly assetId: string;
  readonly view: string;
  /** Optional colour link: a value of the product's colour axis. */
  readonly colorValueId?: string | null;
  /** Optional alt text per locale. */
  readonly alt?: readonly AltText[];
}

export interface ProductImageView {
  readonly id: string;
  readonly assetId: string;
  readonly view: string;
  /** 0 is the primary image. */
  readonly position: number;
  readonly colorValueId: string | null;
  readonly alt: readonly AltText[];
}

export interface ProductImagesView {
  readonly productId: string;
  readonly version: number;
  readonly images: readonly ProductImageView[];
}

export interface ProductImagesResult {
  readonly productId: string;
  readonly version: number;
  readonly images: readonly { imageId: string; assetId: string; position: number }[];
}

const ALT_TABLE: TranslationTable = {
  table: productImageTranslations,
  owner: productImageTranslations.imageId,
  locale: productImageTranslations.locale,
  row: (imageId, t) => ({ imageId, locale: t.locale, altText: t.name }),
  updates: [["altText", "alt_text"]],
};

const altKey = (alt: readonly AltText[]): string =>
  JSON.stringify([...alt].sort((a, b) => a.locale.localeCompare(b.locale)).map((a) => [a.locale, a.text]));

export function createMediaService({ pool, now }: CatalogDeps) {
  return {
    /**
     * Registers an asset's metadata (insert-only; assets never change). The storage key and the
     * SHA-256 are each unique: a clash is an explicit conflict, and a hash conflict names the
     * existing asset so the uploader can reuse it. No file is stored here.
     */
    async registerAsset(ctx: RequestContext, input: AssetInput): Promise<CatalogResult<{ assetId: string }>> {
      await ctx.authorize(CATALOG_PERMISSIONS.mediaManage);
      const parsed = parseAssetMetadata(input);
      if (!parsed.ok) return parsed;
      const asset = parsed.value;

      return mapUniqueViolations(() =>
        runInTransaction(pool, async (tx) => {
          const clashes = await tx.db
            .select({ id: mediaAssets.id, storageKey: mediaAssets.storageKey, sha256: mediaAssets.sha256 })
            .from(mediaAssets)
            .where(or(eq(mediaAssets.storageKey, asset.storageKey), eq(mediaAssets.sha256, asset.sha256)));
          const issues: CatalogIssue[] = [];
          if (clashes.some((c) => c.storageKey === asset.storageKey)) issues.push(issue("storage_key_taken", "storageKey"));
          const sameHash = clashes.find((c) => c.sha256 === asset.sha256);
          if (sameHash) issues.push(issue("asset_hash_taken", "sha256", { assetId: sameHash.id }));
          if (issues.length > 0) return invalid(issues);

          const [row] = await tx.db
            .insert(mediaAssets)
            .values({ ...asset, createdAt: now() })
            .returning({ id: mediaAssets.id });
          if (!row) throw new Error("media asset insert returned no row");
          return valid({ assetId: row.id });
        }),
      );
    },

    /** One asset's metadata. */
    async getAsset(ctx: RequestContext, input: { assetId: string }): Promise<CatalogResult<AssetView>> {
      await ctx.authorize(CATALOG_PERMISSIONS.productsRead);
      return runInTransaction(pool, async (tx) => {
        const [asset] = await tx.db.select().from(mediaAssets).where(eq(mediaAssets.id, input.assetId)).limit(1);
        return asset ? valid(asset as AssetView) : notFound("assetId");
      });
    },

    /**
     * Replaces the product's whole ordered image set: the first image is the primary one.
     * Existing images are matched by asset and keep their IDs; others are added or removed.
     * Requires `expectedVersion`. An identical set changes nothing (no version bump, no event).
     * An active product must keep at least one image; a draft may have none.
     */
    async setProductImages(ctx: RequestContext, input: { productId: string; expectedVersion: number; images: readonly ProductImageInput[] }): Promise<CatalogResult<ProductImagesResult>> {
      await ctx.authorize(CATALOG_PERMISSIONS.mediaManage);

      // Alt text is parsed with the shared localization rules; failures carry the image's path.
      const altIssues: CatalogIssue[] = [];
      const alts: Translation[][] = input.images.map((image, index) => {
        const parsed = parseTranslations("image", (image.alt ?? []).map((a) => ({ locale: a.locale, name: a.text })), `images[${index}].alt`);
        if (parsed.ok) return parsed.value;
        altIssues.push(...parsed.issues);
        return [];
      });

      return runInTransaction(pool, async (tx) => {
        const opened = await openProduct(tx.db, input.productId, input.expectedVersion);
        if ("failure" in opened) return opened.failure;
        const { product } = opened;

        const issues: CatalogIssue[] = [...altIssues];
        if (input.images.length === 0 && product.status === "active") issues.push(issue("no_image", "images"));

        // Assets must exist; FOR SHARE keeps them from changing while we link them.
        const assetIds = [...new Set(input.images.map((i) => i.assetId))];
        const found = assetIds.length ? await tx.db.select({ id: mediaAssets.id }).from(mediaAssets).where(inArray(mediaAssets.id, assetIds)).for("share") : [];
        const known = new Set(found.map((a) => a.id));
        input.images.forEach((image, index) => {
          if (!known.has(image.assetId)) issues.push(issue("asset_not_found", `images[${index}].assetId`));
        });

        // The colour axis and its offered values; axis changes take the product lock too, so they agree.
        const { axes, offered } = await loadAxes(tx.db, product.id);
        const attributeRows = axes.length
          ? await tx.db
              .select({ id: attributes.id, usage: attributes.usage, valueType: attributes.valueType, axisKind: attributes.axisKind, status: attributes.status })
              .from(attributes)
              .where(inArray(attributes.id, axes.map((a) => a.attributeId)))
          : [];
        const colorAxis = colorAxisOf(new Map(attributeRows.map((a) => [a.id, a as AttributeRecord])), axes);
        const color: ColorAxis | null = colorAxis ? { attributeId: colorAxis.attributeId, offeredValueIds: new Set(offered.get(colorAxis.position) ?? []) } : null;

        const imageInputs: ImageInput[] = input.images.map((i) => ({ assetId: i.assetId, view: i.view, colorValueId: i.colorValueId }));
        const planned = planImages(color, imageInputs);
        if (!planned.ok) issues.push(...planned.issues);
        if (issues.length > 0 || !planned.ok) return invalid(issues);

        const current = await tx.db
          .select({ id: productImages.id, assetId: productImages.assetId, view: productImages.view, colorValueId: productImages.colorValueId, position: productImages.position })
          .from(productImages)
          .where(eq(productImages.productId, product.id))
          .orderBy(asc(productImages.position));
        const currentAlt = new Map<string, AltText[]>();
        if (current.length > 0) {
          const rows = await tx.db
            .select({ imageId: productImageTranslations.imageId, locale: productImageTranslations.locale, text: productImageTranslations.altText })
            .from(productImageTranslations)
            .where(inArray(productImageTranslations.imageId, current.map((c) => c.id)));
          for (const r of rows) currentAlt.set(r.imageId, [...(currentAlt.get(r.imageId) ?? []), { locale: r.locale, text: r.text }]);
        }
        const byAsset = new Map(current.map((c) => [c.assetId, c]));
        const wantAlt = (i: number): AltText[] => (alts[i] ?? []).map((t) => ({ locale: t.locale, text: t.name }));

        const unchanged =
          current.length === planned.value.length &&
          planned.value.every((p, i) => {
            const c = current[i];
            return !!c && c.assetId === p.assetId && c.view === p.view && c.colorValueId === p.colorValueId && altKey(currentAlt.get(c.id) ?? []) === altKey(wantAlt(i));
          });
        if (unchanged) {
          return valid({ productId: product.id, version: product.version, images: current.map((c) => ({ imageId: c.id, assetId: c.assetId, position: c.position })) });
        }

        const at = now();
        // Remove images whose asset left the set (their alt text goes with them).
        const keepAssets = planned.value.map((p) => p.assetId);
        await tx.db.delete(productImages).where(and(eq(productImages.productId, product.id), keepAssets.length ? notInArray(productImages.assetId, keepAssets) : undefined));

        const result: { imageId: string; assetId: string; position: number }[] = [];
        for (const [index, plan] of planned.value.entries()) {
          const existing = byAsset.get(plan.assetId);
          const imageId = existing ? existing.id : await insertImage(tx.db, product.id, plan);
          if (existing && (existing.view !== plan.view || existing.colorValueId !== plan.colorValueId || existing.position !== plan.position)) {
            // Positions are unique per product but the constraint is deferred, so reordering in place is safe.
            await tx.db
              .update(productImages)
              .set({ view: plan.view, colorValueId: plan.colorValueId, colorAttributeId: plan.colorAttributeId, position: plan.position })
              .where(eq(productImages.id, existing.id));
          }
          const before = existing ? altKey(currentAlt.get(existing.id) ?? []) : altKey([]);
          if (!existing || before !== altKey(wantAlt(index))) await replaceTranslations(tx.db, ALT_TABLE, imageId, alts[index] ?? []);
          result.push({ imageId, assetId: plan.assetId, position: plan.position });
        }

        const version = await bumpVersion(tx.db, product, at);
        await tx.events.add(productEvent(CATALOG_EVENT_TYPES.productUpdated, product.id));
        return valid({ productId: product.id, version, images: result });
      });
    },

    /** The product's images in display order (the first is primary), with alt text. */
    async listImages(ctx: RequestContext, input: { productId: string }): Promise<CatalogResult<ProductImagesView>> {
      await ctx.authorize(CATALOG_PERMISSIONS.productsRead);
      const data = await runInTransaction(
        pool,
        async (tx) => {
          const [product] = await tx.db.select({ id: products.id, version: products.version }).from(products).where(eq(products.id, input.productId)).limit(1);
          if (!product) return null;
          const images = await tx.db.select().from(productImages).where(eq(productImages.productId, product.id)).orderBy(asc(productImages.position));
          const alt = await tx.db
            .select({ imageId: productImageTranslations.imageId, locale: productImageTranslations.locale, text: productImageTranslations.altText })
            .from(productImageTranslations)
            .innerJoin(productImages, eq(productImages.id, productImageTranslations.imageId))
            .where(eq(productImages.productId, product.id))
            .orderBy(asc(productImageTranslations.locale));
          return { product, images, alt };
        },
        { isolation: "repeatable read" },
      );
      if (!data) return notFound("productId");
      return valid({
        productId: data.product.id,
        version: data.product.version,
        images: data.images.map((i) => ({
          id: i.id,
          assetId: i.assetId,
          view: i.view,
          position: i.position,
          colorValueId: i.colorValueId,
          alt: data.alt.filter((a) => a.imageId === i.id).map((a) => ({ locale: a.locale, text: a.text })),
        })),
      });
    },
  };
}

async function insertImage(db: Parameters<typeof replaceTranslations>[0], productId: string, plan: PlannedImage): Promise<string> {
  const [row] = await db
    .insert(productImages)
    .values({ productId, assetId: plan.assetId, view: plan.view, colorValueId: plan.colorValueId, colorAttributeId: plan.colorAttributeId, position: plan.position })
    .returning({ id: productImages.id });
  if (!row) throw new Error("product image insert returned no row");
  return row.id;
}

export type MediaService = ReturnType<typeof createMediaService>;
