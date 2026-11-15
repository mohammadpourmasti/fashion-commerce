/**
 * Product lifecycle and publishing rules (ADR-024, ADR-026).
 *
 *   draft --publish--> active --unpublish--> draft
 *   draft | active --archive--> archived --restore--> draft
 *
 * Publishing requires a Persian translation (English is optional), an active primary category,
 * an active brand when one is set, complete axes, at least one active variant and at least one
 * image. Nothing is ever deleted; archiving is the end of a product's life.
 */

import { invalid, issue, valid, type CatalogIssue, type Validation } from "./errors";
import { REQUIRED_LOCALE } from "./localization";

export const PRODUCT_STATUSES = ["draft", "active", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export type ProductAction = "publish" | "unpublish" | "archive" | "restore";

const TRANSITIONS: Readonly<Record<ProductAction, { from: readonly ProductStatus[]; to: ProductStatus }>> = {
  publish: { from: ["draft"], to: "active" },
  unpublish: { from: ["active"], to: "draft" },
  archive: { from: ["draft", "active"], to: "archived" },
  restore: { from: ["archived"], to: "draft" },
};

/** The status an action leads to, or invalid_transition. */
export function nextStatus(current: ProductStatus, action: ProductAction): Validation<ProductStatus> {
  const rule = TRANSITIONS[action];
  return rule.from.includes(current) ? valid(rule.to) : invalid([issue("invalid_transition", "status", { from: current, action })]);
}

/** What the application loads about a product before publishing it. */
export interface PublicationSnapshot {
  readonly status: ProductStatus;
  /** Locales with a complete translation (name and slug). */
  readonly translatedLocales: readonly string[];
  readonly primaryCategoryStatus: "active" | "archived";
  /** null when the product has no brand. */
  readonly brandStatus: "active" | "archived" | null;
  readonly axisCount: number;
  /** Number of product_axes rows. */
  readonly axesDefined: number;
  readonly activeVariants: number;
  readonly images: number;
}

/** Every reason the product cannot be published right now (empty when it can). */
export function publicationIssues(product: PublicationSnapshot): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const transition = nextStatus(product.status, "publish");
  if (!transition.ok) issues.push(...transition.issues);
  if (!product.translatedLocales.includes(REQUIRED_LOCALE)) {
    issues.push(issue("missing_required_translation", `translations.${REQUIRED_LOCALE}`, { locale: REQUIRED_LOCALE }));
  }
  if (product.primaryCategoryStatus !== "active") issues.push(issue("category_archived", "primaryCategoryId"));
  if (product.brandStatus === "archived") issues.push(issue("brand_archived", "brandId"));
  if (product.axesDefined !== product.axisCount) issues.push(issue("axes_incomplete", "axes", { expected: product.axisCount }));
  if (product.activeVariants < 1) issues.push(issue("no_active_variant", "variants"));
  if (product.images < 1) issues.push(issue("no_image", "images"));
  return issues;
}

/** valid("active") when the product may be published, otherwise every blocking issue. */
export function checkPublishable(product: PublicationSnapshot): Validation<ProductStatus> {
  const issues = publicationIssues(product);
  return issues.length > 0 ? invalid(issues) : valid("active");
}
