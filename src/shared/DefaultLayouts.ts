// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { HubState, TabState } from "./HubState";
import TabType, { getDefaultTabTitle } from "./TabType";
import trackDay from "./layouts/default.json";

/**
 * Layouts shipped with the app, offered under File > Add <title> Layout and `?layout=<id>` in Lite.
 * Each is an exported layout file; regenerate `layouts/default.json` with `node tools/default-layout.mjs`.
 */
export type DefaultLayout = { id: string; title: string; state: HubState };

export const DEFAULT_LAYOUTS: DefaultLayout[] = [
  { id: "default", title: "Track Day", state: (trackDay as unknown as { hubs: HubState[] }).hubs[0] }
];

export function getDefaultLayout(id: string | null | undefined): DefaultLayout | undefined {
  return DEFAULT_LAYOUTS.find((layout) => layout.id === id);
}

/**
 * True if every tab of the layout (except Documentation) is already open, matched by type and title.
 * A tab named after its type saves its title as "", so a default title matches "" too.
 */
export function isLayoutOpen(layout: DefaultLayout, openTabs: Pick<TabState, "type" | "title">[]): boolean {
  const title = (tab: Pick<TabState, "type" | "title">) =>
    tab.title === getDefaultTabTitle(tab.type) ? "" : tab.title;
  return layout.state.tabs.tabs
    .filter((tab) => tab.type !== TabType.Documentation)
    .every((tab) => openTabs.some((open) => open.type === tab.type && title(open) === title(tab)));
}
