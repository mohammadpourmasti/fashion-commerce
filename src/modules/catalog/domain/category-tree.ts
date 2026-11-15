/**
 * Category tree rules (ADR-024): no cycles, at most four levels (root = level 1), and a parent
 * must exist and be active. The application loads the tree (small: hundreds of rows) under an
 * advisory lock and asks these functions before writing.
 */

import { invalid, issue, valid, type CatalogIssue, type Validation } from "./errors";

export const MAX_CATEGORY_DEPTH = 4;

export interface CategoryNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly status: "active" | "archived";
}

export type CategoryTree = ReadonlyMap<string, CategoryNode>;

export const toTree = (nodes: readonly CategoryNode[]): CategoryTree => new Map(nodes.map((n) => [n.id, n]));

/** Level of a node (root = 1). Throws if the stored tree is already cyclic, which the rules prevent. */
export function depthOf(tree: CategoryTree, id: string): number {
  let depth = 0;
  const seen = new Set<string>();
  for (let current: string | null = id; current !== null; ) {
    if (seen.has(current)) throw new Error(`Category tree contains a cycle at ${current}`);
    seen.add(current);
    depth += 1;
    current = tree.get(current)?.parentId ?? null;
  }
  return depth;
}

/** The node and everything below it. */
export function subtreeOf(tree: CategoryTree, id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const node of tree.values()) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node.id);
    children.set(node.parentId, list);
  }
  const out = new Set<string>([id]);
  const queue = [id];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        queue.push(child);
      }
    }
  }
  return out;
}

/** Number of levels in the subtree rooted at `id` (a leaf has height 1). */
export function heightOf(tree: CategoryTree, id: string): number {
  const base = depthOf(tree, id);
  let deepest = base;
  for (const member of subtreeOf(tree, id)) deepest = Math.max(deepest, depthOf(tree, member));
  return deepest - base + 1;
}

function checkParent(tree: CategoryTree, parentId: string, issues: CatalogIssue[]): CategoryNode | undefined {
  const parent = tree.get(parentId);
  if (!parent) issues.push(issue("category_not_found", "parentId"));
  else if (parent.status !== "active") issues.push(issue("category_archived", "parentId"));
  return parent;
}

/** A new category under `parentId` (null = a new department at the top level). */
export function validateNewCategory(tree: CategoryTree, parentId: string | null): Validation<{ depth: number }> {
  if (parentId === null) return valid({ depth: 1 });
  const issues: CatalogIssue[] = [];
  if (!checkParent(tree, parentId, issues)) return invalid(issues);
  const depth = depthOf(tree, parentId) + 1;
  if (depth > MAX_CATEGORY_DEPTH) issues.push(issue("category_too_deep", "parentId", { max: MAX_CATEGORY_DEPTH }));
  return issues.length > 0 ? invalid(issues) : valid({ depth });
}

/** Moving `categoryId` (with its whole subtree) under `newParentId` (null = top level). */
export function validateCategoryMove(tree: CategoryTree, categoryId: string, newParentId: string | null): Validation<{ depth: number }> {
  if (!tree.has(categoryId)) return invalid([issue("category_not_found", "categoryId")]);
  const height = heightOf(tree, categoryId);
  if (newParentId === null) {
    return height > MAX_CATEGORY_DEPTH ? invalid([issue("category_too_deep", "parentId", { max: MAX_CATEGORY_DEPTH })]) : valid({ depth: 1 });
  }
  const issues: CatalogIssue[] = [];
  if (subtreeOf(tree, categoryId).has(newParentId)) {
    return invalid([issue("category_cycle", "parentId")]);
  }
  if (!checkParent(tree, newParentId, issues)) return invalid(issues);
  const depth = depthOf(tree, newParentId) + 1;
  if (depth + height - 1 > MAX_CATEGORY_DEPTH) issues.push(issue("category_too_deep", "parentId", { max: MAX_CATEGORY_DEPTH }));
  return issues.length > 0 ? invalid(issues) : valid({ depth });
}
