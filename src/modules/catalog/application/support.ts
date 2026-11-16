import { and, eq, notInArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Pool } from "pg";

import { isUniqueViolation, pgErrorConstraint } from "@/shared/db/errors";
import type { Tx } from "@/shared/db/transaction";

import { invalid, issue, type CatalogIssue, type Validation } from "../domain/errors";
import { REQUIRED_LOCALE, type Translation } from "../domain/localization";

/**
 * Shared plumbing for catalog application services. Services follow the identity pattern:
 * `ctx.authorize(...)` first (throws AuthorizationError), then domain validation, then one
 * transaction that writes the change and its outbox event; expected failures come back as a
 * `Validation` with issues, never as exceptions.
 */

export type CatalogResult<T> = Validation<T>;

export interface CatalogDeps {
  readonly pool: Pool;
  readonly now: () => Date;
}

export type Db = Tx["db"];

/** Advisory lock serializing every change to the category tree (structure, positions, status). */
export const CATEGORY_TREE_LOCK = 727450003;

export const notFound = <T = never>(path: string): CatalogResult<T> => invalid([issue("not_found", path)]);

/** Persian is required for taxonomy content from the start (the storefront's default locale). */
export function requireRequiredLocale(translations: readonly Translation[], path = "translations"): CatalogIssue[] {
  return translations.some((t) => t.locale === REQUIRED_LOCALE) ? [] : [issue("missing_required_translation", path, { locale: REQUIRED_LOCALE })];
}

/** Unique constraints a concurrent writer can still trip after the in-transaction checks. */
const UNIQUE_CONSTRAINTS: Readonly<Record<string, CatalogIssue>> = {
  categories_key_unique: issue("key_taken", "key"),
  brands_key_unique: issue("key_taken", "key"),
  attributes_key_unique: issue("key_taken", "key"),
  attribute_values_key_unique: issue("key_taken", "key"),
  category_translations_slug_unique: issue("slug_taken", "translations"),
  brand_translations_slug_unique: issue("slug_taken", "translations"),
  product_translations_slug_unique: issue("slug_taken", "translations"),
};

/** The issue for a known unique violation, or null for anything else (which is rethrown). */
export function uniqueViolationIssue(error: unknown): CatalogIssue | null {
  if (!isUniqueViolation(error)) return null;
  const constraint = pgErrorConstraint(error);
  return constraint ? (UNIQUE_CONSTRAINTS[constraint] ?? null) : null;
}

/** Runs a transactional write and turns a lost uniqueness race into an issue instead of an exception. */
export async function mapUniqueViolations<T>(work: () => Promise<CatalogResult<T>>): Promise<CatalogResult<T>> {
  try {
    return await work();
  } catch (error) {
    const mapped = uniqueViolationIssue(error);
    if (mapped) return invalid([mapped]);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Translations: the given set replaces the stored one (missing locales are removed).
// ---------------------------------------------------------------------------

export interface TranslationTable {
  readonly table: PgTable;
  readonly owner: PgColumn;
  readonly locale: PgColumn;
  /** Maps a translation to the row values for this table (owner and locale included). */
  readonly row: (ownerId: string, t: Translation) => Record<string, unknown>;
  /** Updated on conflict: [Drizzle property, database column], set to `excluded.<column>`. */
  readonly updates: readonly (readonly [string, string])[];
}

export async function replaceTranslations(db: Db, spec: TranslationTable, ownerId: string, translations: readonly Translation[]): Promise<void> {
  const locales = translations.map((t) => t.locale);
  const stale: SQL | undefined = locales.length > 0 ? notInArray(spec.locale, locales) : undefined;
  await db.delete(spec.table).where(and(eq(spec.owner, ownerId), stale));
  if (translations.length === 0) return;
  const set = Object.fromEntries(spec.updates.map(([key, column]) => [key, sql.raw(`excluded."${column}"`)]));
  await db
    .insert(spec.table)
    .values(translations.map((t) => spec.row(ownerId, t)))
    .onConflictDoUpdate({ target: [spec.owner, spec.locale], set });
}
