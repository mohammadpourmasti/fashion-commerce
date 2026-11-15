import { localeMeta } from "@/shared/i18n/config";
import { getDictionary, getLocale } from "@/shared/i18n/server";
import { ButtonLink, Container, Eyebrow, Heading, Rule } from "@/shared/ui";

export default async function HomePage() {
  const [locale, dict] = await Promise.all([getLocale(), getDictionary()]);
  const index = new Intl.NumberFormat(localeMeta[locale].intl, { minimumIntegerDigits: 2 });

  const categories = [
    { name: dict.nav.women, body: dict.home.categories.women },
    { name: dict.nav.children, body: dict.home.categories.children },
    { name: dict.nav.accessories, body: dict.home.categories.accessories },
    { name: dict.nav.underwear, body: dict.home.categories.underwear },
  ];
  const services = [dict.home.services.stylist, dict.home.services.boutique, dict.home.services.care];

  return (
    <>
      <section aria-labelledby="hero-title">
        <Container className="grid gap-12 py-16 sm:py-24 lg:grid-cols-12 lg:items-end lg:gap-16 lg:py-32">
          <div className="lg:col-span-7">
            <Eyebrow>{dict.home.eyebrow}</Eyebrow>
            <Heading as="h1" id="hero-title" level="display" className="mt-6">
              {dict.home.title}
            </Heading>
            <p className="mt-8 max-w-prose text-lead text-muted">{dict.home.lead}</p>
            <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-4">
              <ButtonLink href="#house" size="lg">
                {dict.home.primaryCta}
              </ButtonLink>
              <ButtonLink href="#services" variant="quiet">
                {dict.home.secondaryCta}
              </ButtonLink>
            </div>
          </div>

          {/* Arched frame: reserved for campaign imagery from the media module. */}
          <div aria-hidden className="lg:col-span-5">
            <div className="relative mx-auto aspect-[4/5] w-full max-w-md overflow-hidden rounded-t-full bg-ivory-deep">
              <div className="absolute inset-4 rounded-t-full border border-champagne/60" />
              <div className="absolute inset-x-0 bottom-10 flex justify-center">
                <span className="h-px w-16 bg-champagne" />
              </div>
            </div>
          </div>
        </Container>
      </section>

      <section id="house" aria-labelledby="house-title" className="scroll-mt-8">
        <Container>
          <Rule />
          <div className="flex items-baseline justify-between gap-6 py-10">
            <Heading id="house-title">{dict.home.categoriesTitle}</Heading>
            <Eyebrow>{dict.home.comingSoon}</Eyebrow>
          </div>
          <ul className="grid border-t border-line sm:grid-cols-2 lg:grid-cols-4">
            {categories.map((category, i) => (
              <li
                key={category.name}
                className="flex min-h-56 flex-col justify-between gap-10 border-b border-line py-8 sm:pe-6 sm:even:ps-6 lg:border-e lg:not-first:ps-6 lg:last:border-e-0"
              >
                <span className="font-display text-sm text-stone">{index.format(i + 1)}</span>
                <div>
                  <h3 className="font-display text-title">{category.name}</h3>
                  <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted">{category.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </Container>
      </section>

      <section id="services" aria-labelledby="services-title" className="mt-24 scroll-mt-8 bg-charcoal text-ivory sm:mt-32">
        <Container className="py-20 sm:py-28">
          <Heading id="services-title" className="text-ivory">
            {dict.home.servicesTitle}
          </Heading>
          <ul className="mt-14 grid gap-12 sm:grid-cols-3 sm:gap-10">
            {services.map((service) => (
              <li key={service.title} className="border-t border-champagne/50 pt-6">
                <h3 className="text-base font-medium text-champagne">{service.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-ivory/80">{service.body}</p>
              </li>
            ))}
          </ul>
        </Container>
      </section>
    </>
  );
}
