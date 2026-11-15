/**
 * Locale configuration. Client-safe: no server-only imports here.
 *
 * Persian is the primary market language and the default locale.
 * Adding a locale = add it here + add a dictionary in ./dictionaries.
 */

export const locales = ["fa", "en"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "fa";

export const LOCALE_COOKIE = "NEXT_LOCALE";

type LocaleMeta = {
  /** Text direction for <html dir>. */
  dir: "rtl" | "ltr";
  /** BCP 47 tag for Intl formatting (numbers, dates, currency). */
  intl: string;
  /** Native display name used in the locale switcher. */
  nativeName: string;
};

export const localeMeta: Record<Locale, LocaleMeta> = {
  fa: { dir: "rtl", intl: "fa-IR", nativeName: "فارسی" },
  en: { dir: "ltr", intl: "en-US", nativeName: "English" },
};

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

export function getDirection(locale: Locale): "rtl" | "ltr" {
  return localeMeta[locale].dir;
}

/** Replace (or add) the leading locale segment of a pathname. */
export function switchLocalePath(pathname: string, target: Locale): string {
  const segments = pathname.split("/");
  if (segments[1] && isLocale(segments[1])) {
    segments[1] = target;
    return segments.join("/") || `/${target}`;
  }
  return `/${target}${pathname === "/" ? "" : pathname}`;
}
