// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import SourceList from "../../src/hub/SourceList";
import Log from "../../src/shared/log/Log";

test("remembered discovered field survives remove and add through stock selection", () => {
  const log = new Log();
  log.putRaw("/cloud", 1, new Uint8Array());
  log.setStructuredType("/cloud", "sensor_msgs/PointCloud2");
  const old = (globalThis as any).window;
  (globalThis as any).window = {
    log,
    typeMemory: { test: { "/cloud": { type: "spatial", options: { field: "ring" } } } }
  };
  const list = Object.create(SourceList.prototype) as any;
  list.config = {
    typeMemoryId: "test",
    types: [
      {
        key: "spatial",
        sourceTypes: ["sensor_msgs/PointCloud2"],
        options: [{ key: "field", values: [{ key: "intensity", display: "intensity" }] }]
      }
    ]
  };
  list.state = [];
  list.supplementalStateSuppliers = [];
  list.itemOptionValues = new Map([[JSON.stringify(["/cloud", "field"]), [{ key: "ring", display: "ring" }]]]);
  list.addListItem = (state: any) => list.state.push(state);
  try {
    list.addField("/cloud");
    assert.equal(list.state[0].options.field, "ring");
    list.state = [];
    list.addField("/cloud");
    assert.equal(list.state[0].options.field, "ring");
  } finally {
    (globalThis as any).window = old;
  }
});
