import { describe, expect, it } from "vitest";
import {
  addMoney,
  currencies,
  formatMoney,
  money,
  subtractMoney,
  type CurrencyCode,
} from "./money";

describe("currencies", () => {
  it("declares minor units per ISO 4217 currency", () => {
    expect(currencies.IRR.minorUnits).toBe(0);
    expect(currencies.USD.minorUnits).toBe(2);
    expect(currencies.EUR.minorUnits).toBe(2);
    expect(currencies.AED.minorUnits).toBe(2);
  });
});

describe("money()", () => {
  it("creates a value from integer minor units", () => {
    expect(money(1999, "USD")).toEqual({ amountMinor: 1999, currency: "USD" });
    expect(money(0, "IRR")).toEqual({ amountMinor: 0, currency: "IRR" });
    expect(money(-500, "EUR")).toEqual({ amountMinor: -500, currency: "EUR" });
  });

  it.each([19.99, 0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects non-integer or unsafe amount %s",
    (amount) => {
      expect(() => money(amount, "USD")).toThrow(RangeError);
    },
  );
});

describe("addMoney / subtractMoney", () => {
  it("adds and subtracts in the same currency without float drift", () => {
    // 0.1 + 0.2 style drift cannot occur with integer minor units.
    expect(addMoney(money(10, "USD"), money(20, "USD"))).toEqual(money(30, "USD"));
    expect(subtractMoney(money(1000, "EUR"), money(1, "EUR"))).toEqual(money(999, "EUR"));
  });

  it("can go negative when subtracting", () => {
    expect(subtractMoney(money(100, "AED"), money(250, "AED")).amountMinor).toBe(-150);
  });

  it("refuses to mix currencies", () => {
    expect(() => addMoney(money(1, "USD"), money(1, "EUR"))).toThrow(TypeError);
    expect(() => subtractMoney(money(1, "IRR"), money(1, "USD"))).toThrow(/mismatch/i);
  });

  it("throws if the result leaves the safe integer range", () => {
    expect(() => addMoney(money(Number.MAX_SAFE_INTEGER, "IRR"), money(1, "IRR"))).toThrow(
      RangeError,
    );
  });
});

describe("formatMoney", () => {
  it("shows IRR as toman by default (rials ÷ 10)", () => {
    expect(formatMoney(money(1_250_000, "IRR"), { locale: "en-US" })).toBe("125,000 Toman");
  });

  it("rounds toman to whole units", () => {
    expect(formatMoney(money(15, "IRR"), { locale: "en-US" })).toBe("2 Toman");
    expect(formatMoney(money(14, "IRR"), { locale: "en-US" })).toBe("1 Toman");
  });

  it("uses the Persian label and Persian digits for fa-IR", () => {
    const text = formatMoney(money(1_250_000, "IRR"), { locale: "fa-IR" });
    expect(text.endsWith(" تومان")).toBe(true);
    expect(text).toMatch(/^[۰-۹٬٫\s]+/); // Persian digits and separators
    expect(text).not.toMatch(/[0-9]/);
  });

  it("can show IRR in rials", () => {
    expect(formatMoney(money(1000, "IRR"), { locale: "en-US", irrAsToman: false })).toMatch(
      /^IRR\s1,000$/,
    );
  });

  it("formats decimal currencies with their minor units", () => {
    expect(formatMoney(money(12_345, "USD"), { locale: "en-US" })).toBe("$123.45");
    expect(formatMoney(money(1000, "EUR"), { locale: "en-US" })).toBe("€10.00");
    expect(formatMoney(money(500, "AED"), { locale: "en-US" })).toMatch(/^AED\s5\.00$/);
  });

  it("always shows the fixed number of fraction digits", () => {
    expect(formatMoney(money(5, "USD"), { locale: "en-US" })).toBe("$0.05");
    expect(formatMoney(money(100, "USD"), { locale: "en-US" })).toBe("$1.00");
  });

  it("formats every supported currency without throwing", () => {
    for (const code of Object.keys(currencies) as CurrencyCode[]) {
      for (const locale of ["fa-IR", "en-US"]) {
        expect(formatMoney(money(123_456, code), { locale }).length).toBeGreaterThan(0);
      }
    }
  });
});
