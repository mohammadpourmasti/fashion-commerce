import { NextResponse, type NextRequest } from "next/server";
import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from "@/shared/i18n/config";

/**
 * Locale routing: every page lives under /{locale}. Requests without a
 * locale prefix are redirected using, in order: the saved cookie, the
 * Accept-Language header, then the default locale (fa).
 */

function preferredLocale(request: NextRequest): Locale {
  const cookie = request.cookies.get(LOCALE_COOKIE)?.value;
  if (cookie && isLocale(cookie)) return cookie;

  const header = request.headers.get("accept-language") ?? "";
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag = "", q] = part.trim().split(";q=");
      return { lang: tag.toLowerCase().split("-")[0] ?? "", q: q ? Number(q) : 1 };
    })
    .filter((entry) => entry.lang && !Number.isNaN(entry.q))
    .sort((a, b) => b.q - a.q);

  return ranked.map((entry) => entry.lang).find(isLocale) ?? defaultLocale;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const first = pathname.split("/")[1] ?? "";

  if (isLocale(first)) {
    const response = NextResponse.next();
    if (request.cookies.get(LOCALE_COOKIE)?.value !== first) {
      response.cookies.set(LOCALE_COOKIE, first, {
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
        sameSite: "lax",
      });
    }
    return response;
  }

  const url = request.nextUrl.clone();
  url.pathname = `/${preferredLocale(request)}${pathname === "/" ? "" : pathname}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Skip Next internals, API routes and any path with a file extension.
  matcher: ["/((?!_next/|api/|.*\\..*).*)"],
};
