// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import test from "node:test";
import LineGraphController from "../src/hub/controllers/LineGraphController";
import LineGraphFilter from "../src/shared/LineGraphFilter";
import { SelectionMode } from "../src/shared/Selection";
import { LapViewport } from "../src/shared/laps/LapViewport";
import Log from "../src/shared/log/Log";
import LineGraphRenderer from "../src/shared/renderers/LineGraphRenderer";

test("legacy graph threshold and override keys are ignored while lap mode and sources load", () => {
  const controller = Object.create(LineGraphController.prototype) as any;
  const sources = [{ logKey: "speed", visible: true, type: "stepped", options: { color: "#fff" } }];
  let restored: unknown;
  controller.leftSourceList = { setState: (state: unknown) => (restored = state), getState: () => sources };
  controller.rightSourceList = controller.discreteSourceList = { getState: () => [] };
  controller.lapSelect = { value: "time" };
  controller.updateAxisLabels = () => {};
  controller.restoreState(
    JSON.parse(
      JSON.stringify({
        showThresholds: true,
        thresholds: [{ value: 50 }],
        overrides: { speed: { unit: "mph" } },
        channelProfiles: { speed: { precision: 9 } },
        lapMode: "lapTime",
        leftSources: sources
      })
    )
  );
  assert.deepEqual(restored, sources);
  assert.equal(controller.lapSelect.value, "lapTime");
  const saved = controller.saveState();
  assert.equal(saved.lapMode, "lapTime");
  for (const key of ["showThresholds", "thresholds", "overrides", "channelProfiles"]) {
    assert.equal(key in saved, false, key);
    assert.equal(Object.hasOwn(controller, key), false, key);
  }
});

test("a fixed, locked graph clips reduced data and redraws after same-length backfill", () => {
  const log = new Log();
  const key = "/speed";
  for (let i = 0; i <= 5020; i++) {
    if (i !== 2003) log.putNumber(key, i / 100, i % 11);
  }
  // The inserted maximum will replace the point at 20.01 in the same bucket.
  log.putNumber(key, 20.01, 30);
  log.putNumber(key, 50.14, -1000);
  let viewport = [0.105, 50.13];
  const windowBefore = globalThis.window;
  globalThis.window = {
    log,
    selection: {
      getTimelineRange: () => viewport,
      getMode: () => SelectionMode.Static,
      getSelectedTime: () => 10,
      getHoveredTime: () => null,
      getGrabZoomRange: () => null
    },
    getLoadingFields: () => new Set(),
    matchMedia: () => ({ matches: false }),
    devicePixelRatio: 1
  } as any;
  try {
    const controller = Object.assign(Object.create(LineGraphController.prototype), {
      lapMode: "time",
      leftSourceList: {
        getState: () => [{ logKey: key, visible: true, type: "smooth", options: { color: "#2980b9" } }]
      },
      rightSourceList: { getState: () => [] },
      discreteSourceList: { getState: () => [] },
      leftFilter: LineGraphFilter.None,
      rightFilter: LineGraphFilter.None,
      leftUnitConversion: { autoTarget: "meters/second", preset: null },
      rightUnitConversion: { autoTarget: null, preset: null },
      leftLockedRange: [0, 100],
      rightLockedRange: null,
      MAX_VALUE: 1e20,
      MIN_AXIS_RANGE: 1e-5,
      MAX_AXIS_RANGE: 1e20,
      RANGE_MARGIN: 0.05,
      periodStats: new WeakMap(),
      convertedSamples: new WeakMap(),
      fieldIds: new WeakMap(),
      nextFieldId: 0,
      decimated: new Map(),
      rawPreviews: new WeakMap()
    }) as LineGraphController;
    const first = controller.getCommand();
    const samples = first.leftFields[0];
    assert.equal(samples.timestamps[0], 0.105);
    assert.ok(Math.abs(samples.values[0] - 5) < 1e-10);
    assert.equal(samples.timestamps.at(-1), 50.13);
    assert.equal(samples.values.at(-1), 8);
    assert.ok(samples.timestamps.every((t, i, all) => i === 0 || t > all[i - 1]));
    assert.equal(controller.getCommand(), first);

    const draw = new Error("canvas draw");
    const renderer = Object.assign(Object.create(LineGraphRenderer.prototype), {
      ROOT: { querySelector: () => null },
      CANVAS: {
        clientWidth: 900,
        clientHeight: 400,
        getContext: () => {
          throw draw;
        }
      },
      lapViewport: new LapViewport(),
      scrollSensor: { periodic: () => {} }
    }) as LineGraphRenderer;
    assert.throws(() => renderer.render(first), draw);
    assert.doesNotThrow(() => renderer.render(first));

    log.putNumber(key, 20.03, 60);
    const second = controller.getCommand();
    assert.equal(second.leftFields[0].values.length, samples.values.length);
    assert.ok(second.leftFields[0].values.includes(60));
    assert.throws(() => renderer.render(second), draw);

    viewport = [0.1, 0.2];
    log.setMetadataString(key, '{"unit":"m/s"}');
    const metric = controller.getCommand().leftFields[0];
    assert.equal(metric.values[0], 10);
    log.setMetadataString(key, '{"unit":"km/h"}');
    const converted = controller.getCommand().leftFields[0];
    assert.ok(Math.abs(converted.values[0] - 10 / 3.6) < 1e-10);
  } finally {
    globalThis.window = windowBefore;
  }
});
