// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { HubState } from "./HubState";
import trackDay from "./layouts/default.json";

/**
 * Layouts shipped with the app, offered under File > Default Layouts and `?layout=<id>` in Lite.
 * Each is an exported layout file; regenerate `layouts/default.json` with `node tools/default-layout.mjs`.
 */
export type DefaultLayout = { id: string; title: string; state: HubState };

export const DEFAULT_LAYOUTS: DefaultLayout[] = [
  { id: "default", title: "Track Day", state: (trackDay as unknown as { hubs: HubState[] }).hubs[0] }
];

export function getDefaultLayout(id: string | null | undefined): DefaultLayout | undefined {
  return DEFAULT_LAYOUTS.find((layout) => layout.id === id);
}
