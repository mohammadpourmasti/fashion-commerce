import type { Metadata, Viewport } from "next";
import { publicEnv } from "@/config/env";
import { getDirection, localeMeta, locales } from "@/shared/i18n/config";
import { getDictionary, getLocale } from "@/shared/i18n/server";
import { fontVariables } from "@/shared/ui/fonts";
import { SiteFooter } from "./_components/site-footer";
import { SiteHeader } from "./_components/site-header";
import "../globals.css";

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export async function generateMetadata(): Promise<Metadata> {
  const [locale, dict] = await Promise.all([getLocale(), getDictionary()]);
  return {
    metadataBase: new URL(publicEnv.NEXT_PUBLIC_SITE_URL),
    title: { default: dict.meta.title, template: `%s — ${dict.meta.title}` },
    description: dict.meta.description,
    alternates: {
      canonical: `/${locale}`,
      languages: Object.fromEntries(locales.map((l) => [localeMeta[l].intl, `/${l}`])),
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#f6f3ee",
};

export default async function LocaleLayout({ children }: LayoutProps<"/[locale]">) {
  const locale = await getLocale();

  return (
    <html lang={locale} dir={getDirection(locale)} className={fontVariables}>
      <body className="flex min-h-dvh flex-col">
        <SiteHeader />
        <main id="main" className="flex flex-1 flex-col">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
