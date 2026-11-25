// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import test from "node:test";
import { FramePace, requestFrame, setFramePaceSupplier } from "../src/hub/FrameScheduler";

test("a live view that scrolls with time keeps drawing at the live frame rate while no data arrives", () => {
  // A fake clock drives timers and animation frames (one vsync per simulated millisecond)
  let now = 0;
  let timers: { due: number; callback: () => void; id: number }[] = [];
  let frames: FrameRequestCallback[] = [];
  let nextId = 1;
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    performance: globalThis.performance,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout
  };
  Object.defineProperty(globalThis, "performance", { value: { now: () => now }, configurable: true });
  globalThis.window = {
    requestAnimationFrame: (callback: FrameRequestCallback) => (frames.push(callback), nextId++),
    addEventListener: () => {}
  } as any;
  globalThis.document = { addEventListener: () => {} } as any;
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    const id = nextId++;
    timers.push({ due: now + delay, callback, id });
    return id;
  }) as any;
  globalThis.clearTimeout = ((id: number) => (timers = timers.filter((timer) => timer.id !== id))) as any;
  const advance = (ms: number) => {
    for (const end = now + ms; now < end; now++) {
      const due = timers.filter((timer) => timer.due <= now);
      timers = timers.filter((timer) => timer.due > now);
      due.forEach((timer) => timer.callback());
      const pending = frames;
      frames = [];
      pending.forEach((callback) => callback(now));
    }
  };
  try {
    let pace: FramePace = "scroll";
    setFramePaceSupplier(() => pace);
    let drawn = 0;
    const loop = () => {
      drawn++;
      requestFrame(loop);
    };
    requestFrame(loop);
    advance(100); // settle the first frame
    drawn = 0;
    advance(1000);
    assert.ok(drawn >= 19 && drawn <= 21, `scroll pace drew ${drawn} frames in a second`);

    pace = "live";
    advance(300);
    drawn = 0;
    advance(1000);
    assert.ok(drawn >= 3 && drawn <= 5, `live pace without new data drew ${drawn} frames in a second`);
  } finally {
    Object.defineProperty(globalThis, "performance", { value: saved.performance, configurable: true });
    Object.assign(globalThis, {
      window: saved.window,
      document: saved.document,
      setTimeout: saved.setTimeout,
      clearTimeout: saved.clearTimeout
    });
  }
});
