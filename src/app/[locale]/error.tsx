"use client";

import { useParams } from "next/navigation";
import { defaultLocale, isLocale } from "@/shared/i18n/config";
import { dictionaries } from "@/shared/i18n/dictionaries";
import { Button, Container, Eyebrow, Heading } from "@/shared/ui";

export default function LocaleError({ error, retry }: { error: unknown; retry: () => void }) {
  const params = useParams<{ locale: string }>();
  const locale = params?.locale && isLocale(params.locale) ? params.locale : defaultLocale;
  const dict = dictionaries[locale];
  const digest =
    error instanceof Error && "digest" in error && typeof error.digest === "string"
      ? error.digest
      : undefined;

  return (
    <Container className="flex flex-1 flex-col justify-center py-24">
      <Eyebrow>{dict.brand.name}</Eyebrow>
      <Heading as="h1" className="mt-6 max-w-2xl">
        {dict.errors.errorTitle}
      </Heading>
      <p className="mt-6 max-w-prose text-lead text-muted">{dict.errors.errorBody}</p>
      <div className="mt-10 flex flex-wrap items-center gap-6">
        <Button onClick={() => retry()}>{dict.errors.retry}</Button>
        {digest ? (
          <p className="text-xs text-muted">
            {dict.errors.reference}: <code dir="ltr">{digest}</code>
          </p>
        ) : null}
      </div>
    </Container>
  );
}
