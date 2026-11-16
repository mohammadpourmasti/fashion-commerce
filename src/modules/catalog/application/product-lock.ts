import { asc, eq } from "drizzle-orm";

import type { ProductAxis } from "../domain/axes";
import { invalid, issue } from "../domain/errors";
import { productAxes, productAxisValues, products } from "../infrastructure/schema";

import { notFound, type CatalogResult, type Db } from "./support";

/**
 * Plumbing shared by the services that change a product's structure (axes, variants, images):
 * the product row is the lock that serializes them (ADR-028, ADR-029, ADR-030).
 */

export interface LockedProduct {
  readonly id: string;
  readonly status: "draft" | "active" | "archived";
  readonly version: number;
  readonly axisCount: number;
}

export const versionConflict = (current: number): CatalogResult<never> => invalid([issue("version_conflict", "expectedVersion", { current })]);

/** Locks the product row `FOR UPDATE`, or null when it does not exist. */
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
export async function openProduct(db: Db, productId: string, expectedVersion?: number): Promise<{ product: LockedProduct } | { failure: CatalogResult<never> }> {
  const product = await lockProduct(db, productId);
  if (!product) return { failure: notFound("productId") };
  if (expectedVersion !== undefined && product.version !== expectedVersion) return { failure: versionConflict(product.version) };
  if (product.status === "archived") return { failure: invalid([issue("product_archived", "productId")]) };
  return { product };
}

/** Increments the product's version exactly once for a real change. */
export async function bumpVersion(db: Db, product: LockedProduct, at: Date, extra: { axisCount?: number } = {}): Promise<number> {
  const version = product.version + 1;
  await db.update(products).set({ ...extra, version, updatedAt: at }).where(eq(products.id, product.id));
  return version;
}

export async function loadAxes(db: Db, productId: string): Promise<{ axes: ProductAxis[]; offered: Map<number, string[]> }> {
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
