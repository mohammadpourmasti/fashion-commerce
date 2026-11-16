/**
 * Image metadata and product image sets (ADR-025). Assets are metadata only; storage and
 * upload come later. An image may be tied to a value of the product's colour axis only —
 * never a size or other axis (the database enforces the same).
 */

import { invalid, issue, valid, type CatalogIssue, type Validation } from "./errors";

export const MEDIA_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"] as const;
export const PRODUCT_IMAGE_VIEWS = ["front", "back", "detail", "gallery"] as const;
export const MAX_ASSET_BYTES = 52_428_800; // 50 MiB
export const MAX_IMAGE_DIMENSION = 20_000;

export type MediaContentType = (typeof MEDIA_CONTENT_TYPES)[number];
export type ProductImageView = (typeof PRODUCT_IMAGE_VIEWS)[number];

const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9/_.-]{0,254}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface AssetInput {
  readonly storageKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}

export interface AssetMetadata {
  readonly storageKey: string;
  readonly contentType: MediaContentType;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}

const isIntIn = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;

/** Mirrors the media_assets CHECK constraints; the hash is lower-cased. */
export function parseAssetMetadata(input: AssetInput): Validation<AssetMetadata> {
  const issues: CatalogIssue[] = [];
  const bad = (path: string) => issues.push(issue("invalid_asset", path));
  const storageKey = input.storageKey.trim();
  const sha256 = input.sha256.trim().toLowerCase();

  if (!STORAGE_KEY_PATTERN.test(storageKey) || storageKey.includes("..") || storageKey.includes("//")) bad("storageKey");
  if (!(MEDIA_CONTENT_TYPES as readonly string[]).includes(input.contentType)) bad("contentType");
  if (!isIntIn(input.byteSize, 1, MAX_ASSET_BYTES)) bad("byteSize");
  if (!isIntIn(input.width, 1, MAX_IMAGE_DIMENSION)) bad("width");
  if (!isIntIn(input.height, 1, MAX_IMAGE_DIMENSION)) bad("height");
  if (!SHA256_PATTERN.test(sha256)) bad("sha256");

  if (issues.length > 0) return invalid(issues);
  return valid({ storageKey, contentType: input.contentType as MediaContentType, byteSize: input.byteSize, width: input.width, height: input.height, sha256 });
}

/** The product's colour axis and the colour values it offers, or null when it has none. */
export interface ColorAxis {
  readonly attributeId: string;
  readonly offeredValueIds: ReadonlySet<string>;
}

export interface ImageInput {
  readonly assetId: string;
  readonly view: string;
  /** Optional colour link: a value of the product's colour axis. */
  readonly colorValueId?: string | null;
}

export interface PlannedImage {
  readonly assetId: string;
  readonly view: ProductImageView;
  readonly position: number;
  readonly colorValueId: string | null;
  readonly colorAttributeId: string | null;
}

/** Views of which a colour group may hold at most one image; detail and gallery are unrestricted. */
const SINGLE_VIEWS: readonly string[] = ["front", "back"];

/**
 * Validates a product's complete, ordered image list and assigns positions 0..n-1 (the first
 * image is the primary one). Each asset appears once; colour links must use the colour axis.
 * Each colour group (the images sharing one colour value, and the unlinked images as one group)
 * has at most one front and one back image.
 */
export function planImages(colorAxis: ColorAxis | null, images: readonly ImageInput[]): Validation<PlannedImage[]> {
  const issues: CatalogIssue[] = [];
  const assets = new Set<string>();
  const singles = new Set<string>();
  const planned: PlannedImage[] = [];

  images.forEach((image, position) => {
    const path = `images[${position}]`;
    const before = issues.length;
    if (!(PRODUCT_IMAGE_VIEWS as readonly string[]).includes(image.view)) issues.push(issue("invalid_view", `${path}.view`));
    if (assets.has(image.assetId)) issues.push(issue("duplicate_asset", `${path}.assetId`));
    assets.add(image.assetId);

    const colorValueId = image.colorValueId ?? null;
    if (colorValueId !== null) {
      if (!colorAxis) issues.push(issue("not_a_color_axis", `${path}.colorValueId`));
      else if (!colorAxis.offeredValueIds.has(colorValueId)) issues.push(issue("color_not_offered", `${path}.colorValueId`));
    }
    if (SINGLE_VIEWS.includes(image.view)) {
      const group = `${colorValueId ?? ""}|${image.view}`;
      if (singles.has(group)) issues.push(issue("duplicate_view", `${path}.view`, { view: image.view }));
      singles.add(group);
    }
    if (issues.length > before) return;
    planned.push({
      assetId: image.assetId,
      view: image.view as ProductImageView,
      position,
      colorValueId,
      colorAttributeId: colorValueId === null ? null : (colorAxis?.attributeId ?? null),
    });
  });

  return issues.length > 0 ? invalid(issues) : valid(planned);
}
