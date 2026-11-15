import { describe, expect, it } from "vitest";
import { moduleNames, type ModuleDescriptor, type ModuleName } from "@/shared/kernel/module";
import { findDependencyCycle, modules } from "./registry";

type Graph = Record<ModuleName, ModuleDescriptor>;

/** The real module graph with `name`'s dependencies replaced. */
function withDependencies(overrides: Partial<Record<ModuleName, readonly ModuleName[]>>): Graph {
  const graph = { ...modules };
  for (const [name, dependsOn] of Object.entries(overrides) as [ModuleName, readonly ModuleName[]][]) {
    graph[name] = { ...modules[name], dependsOn };
  }
  return graph;
}

describe("module registry", () => {
  it("registers every declared module exactly once", () => {
    expect(Object.keys(modules).sort()).toEqual([...moduleNames].sort());
    expect(new Set(moduleNames).size).toBe(moduleNames.length);
  });

  it("keys each descriptor by its own name", () => {
    for (const name of moduleNames) {
      expect(modules[name].name).toBe(name);
    }
  });

  it("only depends on registered modules, never on itself", () => {
    for (const name of moduleNames) {
      for (const dependency of modules[name].dependsOn) {
        expect(moduleNames).toContain(dependency);
        expect(dependency).not.toBe(name);
      }
    }
  });

  it("lists no duplicate dependencies", () => {
    for (const name of moduleNames) {
      const { dependsOn } = modules[name];
      expect(new Set(dependsOn).size).toBe(dependsOn.length);
    }
  });

  it("gives every module a summary and at least one owned aggregate", () => {
    for (const name of moduleNames) {
      expect(modules[name].summary.length).toBeGreaterThan(0);
      expect(modules[name].owns.length).toBeGreaterThan(0);
    }
  });

  it("has no two modules claiming the same owned aggregate", () => {
    const owners = new Map<string, ModuleName>();
    for (const name of moduleNames) {
      for (const owned of modules[name].owns) {
        expect(owners.get(owned), `"${owned}" owned by two modules`).toBeUndefined();
        owners.set(owned, name);
      }
    }
  });
});

describe("findDependencyCycle", () => {
  it("finds no cycle in the real module graph", () => {
    expect(findDependencyCycle()).toBeNull();
    expect(findDependencyCycle(modules)).toBeNull();
  });

  it("does not flag shared dependencies (diamonds) as cycles", () => {
    // commerce and pos both reach catalog and inventory through different paths.
    expect(findDependencyCycle(withDependencies({ finance: ["commerce", "pos", "payments"] }))).toBeNull();
  });

  it("detects a self-dependency", () => {
    expect(findDependencyCycle(withDependencies({ identity: ["identity"] }))).toEqual([
      "identity",
      "identity",
    ]);
  });

  it("detects a two-module cycle", () => {
    // inventory already depends on catalog.
    const cycle = findDependencyCycle(withDependencies({ catalog: ["inventory"] }));
    expect(cycle).not.toBeNull();
    expect(cycle?.[0]).toBe(cycle?.at(-1));
    expect(new Set(cycle)).toEqual(new Set(["catalog", "inventory"]));
  });

  it("detects a longer cycle and reports the modules in it", () => {
    // ai → customers → identity → ai
    const cycle = findDependencyCycle(withDependencies({ identity: ["ai"] }));
    expect(cycle).not.toBeNull();
    expect(cycle).toHaveLength(4);
    expect(cycle?.[0]).toBe(cycle?.at(-1));
    expect(new Set(cycle)).toEqual(new Set(["ai", "customers", "identity"]));
  });

  it("detects a cycle reached only through an acyclic prefix", () => {
    // finance → commerce → catalog → finance
    const cycle = findDependencyCycle(withDependencies({ catalog: ["finance"] }));
    expect(cycle).not.toBeNull();
    expect(cycle).toContain("catalog");
    expect(cycle).toContain("finance");
    expect(cycle).toContain("commerce");
  });

  it("does not mutate the graph it inspects", () => {
    const graph = withDependencies({ catalog: ["inventory"] });
    const before = JSON.stringify(graph);
    findDependencyCycle(graph);
    expect(JSON.stringify(graph)).toBe(before);
  });
});
