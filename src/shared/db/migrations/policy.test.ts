import { describe, expect, it } from "vitest";

import { lintDownSql, lintUpSql, normalizeTableName } from "./policy";

const messages = (violations: { message: string }[]) => violations.map((v) => v.message).join(" | ");

describe("lintDownSql", () => {
  it("accepts guarded drops and plain object drops", () => {
    const sql = `
      SELECT fc_assert_table_empty('orders');
      DROP TABLE orders;
      SELECT fc_assert_column_empty('products', 'legacy_code');
      ALTER TABLE products DROP COLUMN legacy_code;
      DROP INDEX orders_idx;
      DROP FUNCTION f(int);
    `;
    expect(lintDownSql(sql)).toEqual([]);
  });

  it("matches guards case-insensitively and across schema qualification and quoting", () => {
    expect(
      lintDownSql(`SELECT fc_assert_table_empty('public."Orders"'); DROP TABLE IF EXISTS public.orders CASCADE;`),
    ).toEqual([]);
  });

  it("rejects DROP TABLE without a guard, and a guard for a different table", () => {
    expect(messages(lintDownSql("DROP TABLE orders"))).toMatch(/needs a preceding SELECT fc_assert_table_empty\('orders'\)/);
    expect(lintDownSql("SELECT fc_assert_table_empty('other'); DROP TABLE orders")).toHaveLength(1);
  });

  it("requires a guard for every table in a multi-table DROP", () => {
    const v = lintDownSql("SELECT fc_assert_table_empty('a'); DROP TABLE a, b");
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("b");
  });

  it("requires the guard to come first", () => {
    expect(lintDownSql("DROP TABLE a; SELECT fc_assert_table_empty('a')").length).toBeGreaterThan(0);
  });

  it("rejects an unguarded DROP COLUMN, including several in one ALTER", () => {
    const v = lintDownSql("SELECT fc_assert_column_empty('t', 'a'); ALTER TABLE t DROP COLUMN a, DROP COLUMN b");
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("t.b");
  });

  it.each([
    ["TRUNCATE orders"],
    ["DELETE FROM orders"],
    ["UPDATE orders SET x = NULL"],
    ["INSERT INTO t VALUES (1)"],
    ["DO 'BEGIN END'"],
    ["CALL purge()"],
    ["COPY t TO '/tmp/x'"],
    ["VACUUM FULL"],
  ])("rejects data-changing or opaque statements: %s", (sql) => {
    expect(lintDownSql(sql).length).toBeGreaterThan(0);
  });

  it("rejects dollar-quoted bodies, which would hide statements", () => {
    const v = lintDownSql("CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ DELETE FROM t $$");
    expect(messages(v)).toMatch(/dollar-quoted/);
  });

  it("rejects SELECT other than the guard calls", () => {
    expect(messages(lintDownSql("SELECT pg_terminate_backend(1)"))).toMatch(/only fc_assert/);
    expect(lintDownSql("SELECT fc_assert_table_empty('a'), 1")).not.toEqual([]);
  });

  it("is not fooled by destructive words inside strings and comments", () => {
    const sql = `-- DROP TABLE x\nCOMMENT ON TABLE a IS 'DROP TABLE b; DELETE FROM c'`;
    expect(lintDownSql(sql)).toEqual([]);
  });

  it("rejects schema/database/role drops, column type changes and transaction control", () => {
    for (const sql of [
      "DROP SCHEMA public CASCADE",
      "DROP DATABASE x",
      "DROP ROLE r",
      "ALTER TABLE t ALTER COLUMN c TYPE smallint",
      "COMMIT",
      "BEGIN",
    ]) {
      expect(lintDownSql(sql), sql).not.toEqual([]);
    }
  });

  it("rejects an empty file", () => {
    expect(messages(lintDownSql("-- nothing\n"))).toMatch(/no statements/);
  });
});

describe("lintUpSql", () => {
  it("accepts additive changes", () => {
    expect(lintUpSql("CREATE TABLE t (id int); ALTER TABLE t ADD COLUMN c text; CREATE INDEX i ON t (c);")).toEqual([]);
  });

  it.each([
    ["DROP TABLE t"],
    ["ALTER TABLE t DROP COLUMN c"],
    ["TRUNCATE t"],
    ["DELETE FROM t"],
    ["ALTER TABLE t ALTER COLUMN c TYPE bigint"],
    ["DROP SCHEMA s"],
  ])("requires the allow-destructive marker for: %s", (sql) => {
    expect(messages(lintUpSql(sql))).toMatch(/destructive change/);
    expect(lintUpSql(`-- fc:allow-destructive: reviewed, table unused since v2\n${sql}`)).toEqual([]);
  });

  it("does not accept an empty marker reason", () => {
    expect(lintUpSql("-- fc:allow-destructive:\nDROP TABLE t")).not.toEqual([]);
  });

  it("rejects transaction control and CONCURRENTLY, which clash with the runner", () => {
    expect(messages(lintUpSql("BEGIN; CREATE TABLE t (id int); COMMIT"))).toMatch(/transaction/);
    expect(messages(lintUpSql("CREATE INDEX CONCURRENTLY i ON t (c)"))).toMatch(/CONCURRENTLY/);
  });

  it("ignores destructive words in strings and comments", () => {
    expect(lintUpSql("-- DROP TABLE x\nCOMMENT ON TABLE t IS 'TRUNCATE me'")).toEqual([]);
  });
});

describe("normalizeTableName", () => {
  it("strips the public schema, quotes and case", () => {
    expect(normalizeTableName('public."Orders"')).toBe("orders");
    expect(normalizeTableName("shop.orders")).toBe("shop.orders");
  });
});
