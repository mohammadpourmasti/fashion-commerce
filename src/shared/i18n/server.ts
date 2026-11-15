import { notFound } from "next/navigation";
import { locale as localeParam } from "next/root-params";
import { isLocale, type Locale } from "./config";
import { dictionaries, type Dictionary } from "./dictionaries";

/**
 * Server-only helpers. `next/root-params` fails the build if this file is
 * imported from a Client Component.
 */

/** Current request locale from the `[locale]` root segment. 404s if unsupported. */
export async function getLocale(): Promise<Locale> {
  const value = await localeParam();
  if (!value || !isLocale(value)) notFound();
  return value;
}

export async function getDictionary(): Promise<Dictionary> {
  return dictionaries[await getLocale()];
}
