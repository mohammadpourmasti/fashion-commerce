"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { localeMeta, locales, switchLocalePath, type Locale } from "@/shared/i18n/config";
import { cn } from "@/shared/lib/cn";

export function LocaleSwitcher({ current, label }: { current: Locale; label: string }) {
  const pathname = usePathname() ?? `/${current}`;

  return (
    <nav aria-label={label}>
      <ul className="flex items-center gap-4 text-sm">
        {locales.map((locale) => {
          const active = locale === current;
          return (
            <li key={locale}>
              <Link
                href={switchLocalePath(pathname, locale)}
                hrefLang={localeMeta[locale].intl}
                lang={locale}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "link-underline py-1",
                  active ? "text-ink" : "text-muted hover:text-ink",
                )}
              >
                {localeMeta[locale].nativeName}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
