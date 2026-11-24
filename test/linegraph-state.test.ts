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
import LoggableType from "../src/shared/log/LoggableType";
import { SteppedSeries } from "../src/shared/log/SteppedSeries";
import LineGraphRenderer from "../src/shared/renderers/LineGraphRenderer";
import { ValueScaler } from "../src/shared/util";

function graphController(sources: unknown[]): LineGraphController {
  return Object.assign(Object.create(LineGraphController.prototype), {
    lapMode: "time",
    leftSourceList: { getState: () => sources },
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
    steppedSeries: new WeakMap(),
    fieldIds: new WeakMap(),
    nextFieldId: 0,
    decimated: new Map(),
    rawPreviews: new WeakMap()
  });
}

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
    const controller = graphController([{ logKey: key, visible: true, type: "smooth", options: { color: "#2980b9" } }]);
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

test("a hidden source still loading does not suppress the visible source's empty graph message", () => {
  const log = new Log();
  log.createBlankField("/visible", LoggableType.Number);
  log.createBlankField("/hidden", LoggableType.Number);
  let loading = new Set(["/visible"]);
  const windowBefore = globalThis.window;
  globalThis.window = {
    log,
    selection: {
      getTimelineRange: () => [0, 10],
      getMode: () => SelectionMode.Static,
      getSelectedTime: () => null,
      getHoveredTime: () => null,
      getGrabZoomRange: () => null
    },
    getLoadingFields: () => loading,
    matchMedia: () => ({ matches: false })
  } as any;
  try {
    const controller = graphController(
      ["/visible", "/hidden"].map((logKey) => ({
        logKey,
        visible: logKey === "/visible",
        type: "stepped",
        options: { color: "#2980b9" }
      }))
    );
    assert.equal(controller.getCommand().message, undefined);
    loading = new Set(["/hidden"]);
    assert.equal(controller.getCommand().message, "The selected fields have no numeric samples in this log.");
  } finally {
    globalThis.window = windowBefore;
  }
});

test("stepped windows reuse interior chunks and retain exact boundaries across append, backfill and discard", () => {
  const key = "/voltage";
  const log = new Log();
  for (let i = 0; i < 500; i++) log.putNumber(key, i / 20, i);
  const field = log.getField(key)!;
  const series = new SteppedSeries();
  function read(start: number, end: number, factor = 2) {
    const window = series.get(field, log.getHistoryVersion(key), String(factor), [start, end], (v) => v * factor);
    const full = log.getNumber(key, start, end)!;
    const expected = full.timestamps.flatMap((t, i) =>
      t <= end ? [[Math.max(t, start), full.values[i] * factor]] : []
    );
    assert.deepEqual(
      window.chunks.flatMap(({ timestamps, values }) => timestamps.map((t, i) => [t, values[i]])),
      expected
    );
    assert.equal(window.count, expected.length);
    assert.equal(window.min, Math.min(...expected.map(([, value]) => value)));
    assert.equal(window.max, Math.max(...expected.map(([, value]) => value)));
    return window;
  }
  const initial = read(3.625, 24.75);
  log.putNumber(key, 25, 500);
  const shifted = read(3.875, 25.125);
  assert.equal(shifted.chunks[4], initial.chunks[4]);
  log.putNumber(key, 10.01, 981);
  const backfilled = read(3.875, 25.125);
  assert.notEqual(backfilled.chunks[4], shifted.chunks[4]);
  log.clearBeforeTime(11.025);
  read(11.25, 25.125);
  read(12, 24, 3);
  const held = read(25.25, 26);
  assert.equal(read(25.25, 26.125).chunks[0], held.chunks[0]);
  log.clearBeforeTime(12);
  read(11.5, 13.4);
});

test("a scrolling stepped trace reuses its projected interior until the scale or history changes", () => {
  class TestPath {
    readonly segments: [number, number][] = [];
    moveTo() {}
    lineTo(x: number, y: number) {
      this.segments.push([x, y]);
    }
    addPath(source: TestPath) {
      this.segments.push(...source.segments);
    }
  }
  const { Path2D, DOMMatrix } = globalThis;
  Object.assign(globalThis, { Path2D: TestPath, DOMMatrix: class {} });
  try {
    const log = new Log();
    const key = "/throttle";
    for (let i = 0; i < 300; i++) log.putNumber(key, i / 20, i);
    const series = new SteppedSeries();
    const renderer = Object.assign(Object.create(LineGraphRenderer.prototype), { steppedInteriors: new WeakMap() });
    const projected: TestPath[] = [];
    const context = {
      beginPath() {},
      setTransform() {},
      moveTo() {},
      lineTo() {},
      stroke(path?: TestPath) {
        if (path) projected.push(path);
      }
    };
    const render = (start: number, yScale: number) => {
      const range: [number, number] = [start, start + 10];
      const samples = series.get(log.getField(key)!, log.getHistoryVersion(key), "", range, (v) => v);
      renderer.strokeSteppedWindow(
        context,
        samples,
        new ValueScaler(range, [0, 400]),
        new ValueScaler([0, 1], [0, yScale]),
        40,
        yScale,
        400,
        1
      );
    };

    render(1.25, -2);
    render(1.5, -2);
    assert.equal(projected[1], projected[0]);
    render(1.75, -3);
    assert.notEqual(projected[2], projected[1]);
    log.putNumber(key, 5, 987);
    render(1.75, -3);
    assert.notEqual(projected[3], projected[2]);
    assert.ok(projected[3].segments.some(([, y]) => y === 987 - 40));
  } finally {
    Object.assign(globalThis, { Path2D, DOMMatrix });
  }
});

test("dense stepped paths retain both extremes and the held value in a device pixel", () => {
  const log = new Log();
  for (const [time, value] of [
    [0, 0],
    [0.16, 7],
    [0.17, -4],
    [0.2, 3],
    [0.8, 2]
  ]) {
    log.putNumber("v", time, value);
  }
  const range: [number, number] = [0, 1];
  const samples = new SteppedSeries().get(log.getField("v")!, 0, "", range, (v) => v);
  const rects: number[][] = [];
  const context = {
    lineWidth: 1,
    beginPath() {},
    rect(...rectangle: number[]) {
      rects.push(rectangle);
    },
    fill() {}
  };
  const renderer = Object.create(LineGraphRenderer.prototype);
  renderer.drawDenseSteppedWindow(
    context,
    samples,
    new ValueScaler(range, [0, 4]),
    new ValueScaler(range, range),
    4,
    1
  );
  assert.deepEqual(rects[1], [0.14, -4.5, 1, 12]);
  assert.deepEqual(rects.at(-1), [3.2 - 0.5, 1.5, 4 - 3.2 + 1, 1]);
});
