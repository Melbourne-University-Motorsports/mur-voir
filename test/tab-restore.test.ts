// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import test from "node:test";
import Tabs from "../src/hub/Tabs";
import TabType, { filterRestorableTabs, getAllTabTypes, NEW_TAB_TYPES } from "../src/shared/TabType";

const tabs = (types: number[]) => types.map((type) => ({ type: type as TabType }));

test("restoring the pre-rollback layout selects the preceding surviving tab", () => {
  const restored = filterRestorableTabs(tabs([0, 1, 1, 2, 3, 20, 21, 22, 4, 14, 13, 2, 3]), 5);
  assert.deepEqual(
    restored.tabs.map((tab) => tab.type),
    [0, 1, 1, 2, 4, 14, 13, 2]
  );
  assert.equal(restored.selected, 3);
});

test("restoring keeps the same surviving tab selected after earlier removals", () => {
  assert.equal(filterRestorableTabs(tabs([0, 3, 8, 1, 9, 10, 4]), 6).selected, 2);
});

test("restoring clamps selection when no predecessor survives", () => {
  assert.equal(filterRestorableTabs(tabs([3, 20, 1]), 1).selected, 0);
  assert.deepEqual(filterRestorableTabs(tabs([3, 8, 9, 10, 20, 21, 22]), 5), { tabs: [], selected: 0 });
  assert.deepEqual(filterRestorableTabs([], -1), { tabs: [], selected: 0 });
  assert.equal(filterRestorableTabs(tabs([0, 1]), 99).selected, 1);
});

test("2D Field stays restorable while new tabs use the core menu order", () => {
  assert.ok(getAllTabTypes().includes(TabType.Field2d));
  assert.deepEqual(NEW_TAB_TYPES, [1, 13, 4, 6, 5, 7, 15, 18, 11, 16, 17, 12]);
  assert.ok(getAllTabTypes().includes(TabType.Laps), "old Laps tabs stay restorable");
});

test("Driver Inputs and Car Dynamics restore under new ids while 8 and 9 stay removed", () => {
  assert.deepEqual(
    filterRestorableTabs(tabs([8, 16, 9, 17]), 3).tabs.map((tab) => tab.type),
    [TabType.DriverInputs, TabType.CarDynamics]
  );
});

test("renaming a tab refreshes the overflow shadows with the new title width", () => {
  const titleElement = { innerText: "" };
  const tabs = Object.assign(Object.create(Tabs.prototype), {
    tabList: [{ type: TabType.LineGraph, titleElement, title: "" }],
    TAB_BAR: {
      scrollLeft: 0,
      clientWidth: 780,
      get scrollWidth() {
        return titleElement.innerText.length > 30 ? 2632 : 780;
      }
    },
    SHADOW_LEFT: { style: { opacity: "0" } },
    SHADOW_RIGHT: { style: { opacity: "0" } }
  });
  tabs.renameTab(0, "A long title ".repeat(20));
  assert.equal(tabs.SHADOW_RIGHT.style.opacity, "1");
  tabs.renameTab(0, "Short");
  assert.equal(tabs.SHADOW_RIGHT.style.opacity, "0");
});
