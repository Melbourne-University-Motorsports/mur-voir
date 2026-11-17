// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import type LogFieldTree from "./LogFieldTree";

/** Which fields to show by live state: all, fresh from the live source, or catalogued but not fresh. */
export type LiveFilter = "all" | "live" | "not-live";

export interface FieldFilter {
  query: string;
  live: LiveFilter;
}

/**
 * Live state of a field as the live source reports it ("online" means fresh), or null when the
 * field is not a catalogued live signal.
 */
export type FreshnessLookup = (key: string) => string | null;

export interface FieldFilterContext {
  freshness: FreshnessLookup;
  /** Other names a field can be found by, such as its display label or DBC signal name. */
  aliases?: (key: string) => string[];
  /** Generated fields can match and show, but are left out of the match count like the field count. */
  isGenerated?: (key: string) => boolean;
  /** Child names the sidebar never shows. */
  hiddenKeys?: string[];
}

export interface FieldFilterResult {
  /** Sidebar paths ("/a/b") to show: matches, their ancestors, and everything under a match. */
  visible: Set<string>;
  /** Sidebar paths of the matching fields. */
  matches: Set<string>;
  /** Sidebar paths with a matching descendant, expanded while the filter is active. */
  expand: Set<string>;
  /** Number of matching fields, not counting generated ones. */
  matchCount: number;
  /** Changes whenever the visible tree or its default expansion changes. */
  signature: string;
}

/** Whether a filter hides anything. */
export function isFilterActive(filter: FieldFilter): boolean {
  return filter.query.trim().length > 0 || filter.live !== "all";
}

/** Whether a single field matches the filter. */
export function fieldMatches(key: string, filter: FieldFilter, context: FieldFilterContext): boolean {
  if (filter.live !== "all") {
    const freshness = context.freshness(key);
    if (freshness === null) return false;
    if ((freshness === "online") !== (filter.live === "live")) return false;
  }
  const query = filter.query.trim().toLowerCase();
  if (query.length === 0) return true;
  if (key.toLowerCase().includes(query)) return true;
  return (context.aliases?.(key) ?? []).some((alias) => alias.toLowerCase().includes(query));
}

/**
 * Filters a sidebar tree. Paths are built the way the sidebar builds them, "/" + child names
 * from the given root, skipping hidden keys.
 */
export function filterFieldTree(
  tree: { [id: string]: LogFieldTree },
  filter: FieldFilter,
  context: FieldFilterContext
): FieldFilterResult {
  const hiddenKeys = context.hiddenKeys ?? [];
  const visible = new Set<string>();
  const matched = new Set<string>();
  const expand = new Set<string>();
  let matchCount = 0;

  // Returns whether the node or anything under it matches. Everything under a match shows.
  const visit = (path: string, node: LogFieldTree, underMatch: boolean): boolean => {
    const matches = node.fullKey !== null && fieldMatches(node.fullKey, filter, context);
    if (matches) {
      matched.add(path);
      if (!context.isGenerated?.(node.fullKey!)) matchCount++;
    }
    let descendantMatches = false;
    Object.entries(node.children).forEach(([name, child]) => {
      if (!hiddenKeys.includes(name) && visit(path + "/" + name, child, underMatch || matches)) {
        descendantMatches = true;
      }
    });
    if (underMatch || matches || descendantMatches) visible.add(path);
    if (descendantMatches) expand.add(path);
    return matches || descendantMatches;
  };

  Object.entries(tree).forEach(([name, node]) => {
    if (!hiddenKeys.includes(name)) visit("/" + name, node, false);
  });

  return {
    visible: visible,
    matches: matched,
    expand: expand,
    matchCount: matchCount,
    signature:
      [...matched].sort().join("\n") + "\n\n" + [...visible].sort().join("\n") + "\n\n" + [...expand].sort().join("\n")
  };
}
