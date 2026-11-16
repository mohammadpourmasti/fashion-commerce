/**
 * Product-level references (ADR-024, ADR-028): category assignment and brand choice.
 * Newly chosen categories and brands must be active; ones a product already has may stay even
 * after being archived (publishing then refuses until they are replaced).
 */

import { invalid, issue, valid, type CatalogIssue, type Validation } from "./errors";

export type ReferenceStatus = "active" | "archived";

export interface CategoryAssignment {
  readonly primaryCategoryId: string;
  /** Every category of the product, primary included, without duplicates, primary first. */
  readonly categoryIds: readonly string[];
}

/**
 * Plans a product's complete category set. The primary is added to the set when missing.
 * `statuses` holds every referenced category that exists; `current` the product's existing ones.
 */
export function planCategoryAssignment(
  statuses: ReadonlyMap<string, ReferenceStatus>,
  input: { primaryCategoryId: string; categoryIds?: readonly string[] },
  current: { primaryCategoryId: string | null; categoryIds: ReadonlySet<string> } = { primaryCategoryId: null, categoryIds: new Set() },
): Validation<CategoryAssignment> {
  const issues: CatalogIssue[] = [];
  const ordered = [input.primaryCategoryId, ...(input.categoryIds ?? [])];
  const categoryIds = [...new Set(ordered)];

  categoryIds.forEach((id, index) => {
    const path = index === 0 ? "primaryCategoryId" : `categoryIds[${index - 1}]`;
    const status = statuses.get(id);
    if (!status) return void issues.push(issue("category_not_found", path));
    if (status === "active") return;
    // An archived category may only stay where it already was (the primary only as primary).
    const kept = index === 0 ? current.primaryCategoryId === id : current.categoryIds.has(id);
    if (!kept) issues.push(issue("category_archived", path));
  });

  return issues.length > 0 ? invalid(issues) : valid({ primaryCategoryId: input.primaryCategoryId, categoryIds });
}

/** A brand choice: null clears it; a new brand must exist and be active, the current one may stay. */
export function planBrand(statuses: ReadonlyMap<string, ReferenceStatus>, brandId: string | null, currentBrandId: string | null = null): Validation<string | null> {
  if (brandId === null) return valid(null);
  const status = statuses.get(brandId);
  if (!status) return invalid([issue("brand_not_found", "brandId")]);
  if (status === "archived" && brandId !== currentBrandId) return invalid([issue("brand_archived", "brandId")]);
  return valid(brandId);
}
