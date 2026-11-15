"use client";

import { dictionaries } from "@/shared/i18n/dictionaries";
import { Button } from "@/shared/ui";
import "./globals.css";

/**
 * Last-resort boundary for errors thrown in the root layout itself. It
 * replaces the whole document, so it cannot rely on the localized layout,
 * fonts or locale: bilingual copy with system fonts.
 */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  const { fa, en } = dictionaries;

  return (
    <html lang="fa" dir="rtl">
      <body className="flex min-h-dvh items-center">
        <title>{`${en.errors.errorTitle} — ${en.meta.title}`}</title>
        <main className="mx-auto grid w-full max-w-page gap-16 px-4 py-24 sm:px-8 md:grid-cols-2 lg:px-12">
          <section>
            <h1 className="text-headline font-light">{fa.errors.errorTitle}</h1>
            <p className="mt-6 text-muted">{fa.errors.errorBody}</p>
          </section>
          <section lang="en" dir="ltr">
            <h1 className="text-headline font-light">{en.errors.errorTitle}</h1>
            <p className="mt-6 text-muted">{en.errors.errorBody}</p>
          </section>
          <div className="md:col-span-2">
            <Button onClick={() => retry()}>
              {fa.errors.retry} / {en.errors.retry}
            </Button>
          </div>
        </main>
      </body>
    </html>
  );
}
