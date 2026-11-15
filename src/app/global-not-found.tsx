import type { Metadata } from "next";
import Link from "next/link";
import { defaultLocale } from "@/shared/i18n/config";
import { dictionaries } from "@/shared/i18n/dictionaries";
import { buttonClasses } from "@/shared/ui";
import { fontVariables } from "@/shared/ui/fonts";
import "./globals.css";

/**
 * 404 for URLs that match no route at all. It bypasses the localized root
 * layout, so the locale is unknown: show both languages, Persian first.
 */
export const metadata: Metadata = {
  title: `404 — ${dictionaries.en.meta.title}`,
};

export default function GlobalNotFound() {
  const { fa, en } = dictionaries;

  return (
    <html lang={defaultLocale} dir="rtl" className={fontVariables}>
      <body className="flex min-h-dvh items-center">
        <main className="mx-auto grid w-full max-w-page gap-16 px-4 py-24 sm:px-8 md:grid-cols-2 lg:px-12">
          <section>
            <p className="eyebrow">{fa.errors.notFoundCode}</p>
            <h1 className="mt-6 font-display text-headline font-light">{fa.errors.notFoundTitle}</h1>
            <p className="mt-6 text-muted">{fa.errors.notFoundBody}</p>
            <Link href="/fa" className={`${buttonClasses()} mt-10`}>
              {fa.errors.backHome}
            </Link>
          </section>
          <section lang="en" dir="ltr" className="font-[family-name:var(--font-latin-sans)]">
            <p className="eyebrow">{en.errors.notFoundCode}</p>
            <h1 className="mt-6 font-[family-name:var(--font-latin-display)] text-headline font-light">
              {en.errors.notFoundTitle}
            </h1>
            <p className="mt-6 text-muted">{en.errors.notFoundBody}</p>
            <Link href="/en" className={`${buttonClasses()} mt-10`}>
              {en.errors.backHome}
            </Link>
          </section>
        </main>
      </body>
    </html>
  );
}
