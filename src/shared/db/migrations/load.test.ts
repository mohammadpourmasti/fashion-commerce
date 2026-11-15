import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MigrationLayoutError } from "./errors";
import { checksumOf, loadMigrations } from "./load";

const created: string[] = [];

function layout(entries: Record<string, { up?: string; down?: string } | "file">): string {
  const dir = mkdtempSync(join(tmpdir(), "fc-mig-"));
  created.push(dir);
  for (const [name, content] of Object.entries(entries)) {
    if (content === "file") {
      writeFileSync(join(dir, name), "x");
      continue;
    }
    mkdirSync(join(dir, name));
    if (content.up !== undefined) writeFileSync(join(dir, name, "migration.sql"), content.up);
    if (content.down !== undefined) writeFileSync(join(dir, name, "down.sql"), content.down);
  }
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("checksumOf", () => {
  it("is stable across CRLF and LF checkouts", () => {
    expect(checksumOf("SELECT 1;\r\nSELECT 2;\r\n")).toBe(checksumOf("SELECT 1;\nSELECT 2;\n"));
  });

  it("changes when the content changes", () => {
    expect(checksumOf("SELECT 1;")).not.toBe(checksumOf("SELECT 2;"));
  });
});

describe("loadMigrations", () => {
  it("loads migrations in numeric order and ignores scratch directories", () => {
    const dir = layout({
      "0002_second": { up: "SELECT 2;", down: "SELECT 2;" },
      "0001_first": { up: "SELECT 1;", down: "SELECT 1;" },
      _generated: { up: "x" },
      ".cache": {},
    });
    expect(loadMigrations(dir).map((m) => [m.id, m.number, m.name])).toEqual([
      ["0001_first", 1, "first"],
      ["0002_second", 2, "second"],
    ]);
  });

  it("rejects gaps, bad names, loose files and missing files", () => {
    expect(() => loadMigrations(layout({ "0002_x": { up: "a", down: "b" } }))).toThrow(/contiguous/);
    expect(() => loadMigrations(layout({ "1_x": { up: "a", down: "b" } }))).toThrow(/0001_snake_case/);
    expect(() => loadMigrations(layout({ "0001_Bad": { up: "a", down: "b" } }))).toThrow(MigrationLayoutError);
    expect(() => loadMigrations(layout({ notes: "file" }))).toThrow(/Unexpected file/);
    expect(() => loadMigrations(layout({ "0001_x": { up: "a" } }))).toThrow(/down\.sql/);
    expect(() => loadMigrations(join(tmpdir(), "does-not-exist-fc"))).toThrow(/not found/);
  });
});
