import { getDictionary, getLocale } from "@/shared/i18n/server";
import { ButtonLink, Container, Eyebrow, Heading } from "@/shared/ui";

/** Rendered when `notFound()` is called inside a localized route. */
export default async function LocaleNotFound() {
  const [locale, dict] = await Promise.all([getLocale(), getDictionary()]);

  return (
    <Container className="flex flex-1 flex-col justify-center py-24">
      <Eyebrow>{dict.errors.notFoundCode}</Eyebrow>
      <Heading as="h1" className="mt-6 max-w-2xl">
        {dict.errors.notFoundTitle}
      </Heading>
      <p className="mt-6 max-w-prose text-lead text-muted">{dict.errors.notFoundBody}</p>
      <div className="mt-10">
        <ButtonLink href={`/${locale}`}>{dict.errors.backHome}</ButtonLink>
      </div>
    </Container>
  );
}
