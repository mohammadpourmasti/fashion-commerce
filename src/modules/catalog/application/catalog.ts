import type { Pool } from "pg";

import { createAttributeService } from "./attributes";
import { createBrandService } from "./brands";
import { createCategoryService } from "./categories";
import { createProductService } from "./products";

export interface CatalogOptions {
  readonly pool: Pool;
  readonly now?: () => Date;
}

/**
 * Composition of the catalog module. Everything is injected, so tests use a throwaway database
 * and a fake clock; the process-wide instance is wired by the composition root (2E).
 * Taxonomy (Step 3) and product core (Step 4); variants, axes and images follow in later steps.
 */
export function createCatalog(options: CatalogOptions) {
  const deps = { pool: options.pool, now: options.now ?? (() => new Date()) };
  return {
    categories: createCategoryService(deps),
    brands: createBrandService(deps),
    attributes: createAttributeService(deps),
    products: createProductService(deps),
  };
}

export type Catalog = ReturnType<typeof createCatalog>;
