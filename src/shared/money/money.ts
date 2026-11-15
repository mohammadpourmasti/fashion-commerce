/**
 * Money primitives shared by catalog, commerce, POS and finance.
 *
 * Amounts are integers in the currency's minor unit (cents for USD, rials
 * for IRR) to avoid floating-point drift. Never store or compute prices as
 * floats. Toman is a display convention only (1 toman = 10 rials); the
 * system of record is always ISO 4217 IRR. See docs/DECISIONS.md (ADR-007).
 */

export const currencies = {
  IRR: { minorUnits: 0 },
  USD: { minorUnits: 2 },
  EUR: { minorUnits: 2 },
  AED: { minorUnits: 2 },
} as const;

export type CurrencyCode = keyof typeof currencies;

export type Money = {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
};

export function money(amountMinor: number, currency: CurrencyCode): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError(`Money amount must be a safe integer in minor units, got ${amountMinor}`);
  }
  return { amountMinor, currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export type FormatMoneyOptions = {
  /** BCP 47 locale, e.g. "fa-IR" or "en-US". */
  locale: string;
  /** Show IRR amounts in toman (÷10) with a localized label. */
  irrAsToman?: boolean;
};

export function formatMoney(value: Money, { locale, irrAsToman = true }: FormatMoneyOptions): string {
  const { minorUnits } = currencies[value.currency];
  const major = value.amountMinor / 10 ** minorUnits;

  if (value.currency === "IRR" && irrAsToman) {
    const amount = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(
      Math.round(major / 10),
    );
    return locale.startsWith("fa") ? `${amount} تومان` : `${amount} Toman`;
  }

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: value.currency,
    minimumFractionDigits: minorUnits,
    maximumFractionDigits: minorUnits,
  }).format(major);
}
