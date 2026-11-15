import { describe, expect, it } from "vitest";

import { scanSql } from "./sql-scan";

describe("scanSql", () => {
  it("splits statements and ignores semicolons in strings, comments and dollar quotes", () => {
    const { statements } = scanSql(`
      -- a; comment
      SELECT 'a;b';
      /* block; /* nested; */ still comment; */
      CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN PERFORM 1; END $body$;
      SELECT 2
    `);
    expect(statements.map((s) => s.normalized)).toEqual([
      "select ''",
      "create function f() returns void language plpgsql as ''",
      "select 2",
    ]);
    expect(statements[1]?.hasDollarQuote).toBe(true);
    expect(statements[0]?.hasDollarQuote).toBe(false);
  });

  it("captures string literal contents, including doubled quotes", () => {
    const { statements } = scanSql("SELECT fc_assert_table_empty('it''s'), 'x'");
    expect(statements[0]?.strings).toEqual(["it's", "x"]);
  });

  it("keeps quoted identifiers and lowercases only the normalized form", () => {
    const { statements } = scanSql('DROP TABLE "Public"."Orders"');
    expect(statements[0]?.text).toBe('DROP TABLE "Public"."Orders"');
    expect(statements[0]?.normalized).toBe("drop table public.orders");
  });

  it("collects comment text (policy markers live there)", () => {
    const { comments } = scanSql("-- fc:allow-destructive: drop legacy\nSELECT 1; /* x */");
    expect(comments.join("|")).toContain("fc:allow-destructive: drop legacy");
  });

  it("does not treat $1 parameters as dollar quotes", () => {
    const { statements } = scanSql("SELECT $1, $2");
    expect(statements[0]?.hasDollarQuote).toBe(false);
  });

  it("handles backslash escapes only in E'' strings", () => {
    const e = scanSql("SELECT E'a\\'b;c'; SELECT 1");
    expect(e.statements).toHaveLength(2);
    expect(e.statements[0]?.strings).toEqual(["a'b;c"]);
  });
});
