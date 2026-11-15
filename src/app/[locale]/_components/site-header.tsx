import Link from "next/link";
import { getDictionary, getLocale } from "@/shared/i18n/server";
import { Container } from "@/shared/ui";
import { LocaleSwitcher } from "./locale-switcher";

export async function SiteHeader() {
  const [locale, dict] = await Promise.all([getLocale(), getDictionary()]);
  const nav = [dict.nav.women, dict.nav.children, dict.nav.accessories, dict.nav.underwear];

  return (
    <header className="border-b border-line">
      <Container className="flex h-16 items-center justify-between gap-6 sm:h-20">
        <Link
          href={`/${locale}`}
          className="font-display text-xl font-normal tracking-display sm:text-2xl"
        >
          {dict.brand.name}
        </Link>

        <nav aria-label={dict.nav.label} className="hidden md:block">
          {/* Category routes arrive with the catalog module; labels only for now. */}
          <ul className="flex items-center gap-8 text-sm text-muted">
            {nav.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        </nav>

        <LocaleSwitcher current={locale} label={dict.nav.languageSwitch} />
      </Container>
    </header>
  );
}
