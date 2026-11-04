// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudDecoder } from "../../src/hub/CloudDecoder";
import { SpatialLayers } from "../../src/hub/controllers/SpatialLayers";
import Log from "../../src/shared/log/Log";
import { identity } from "../../src/shared/spatial/Transform";

test("retained scans use TF at acquisition time and reset clears decoded scans", async () => {
  const layers = new SpatialLayers();
  const log = new Log();
  log.putRaw("/cloud", 1, new Uint8Array([1]));
  log.putRaw("/cloud", 0, new Uint8Array());
  log.setStructuredType("/cloud", "sensor_msgs/PointCloud2");
  layers.begin(log, 1);
  layers.tree.addTransform("map", "lidar", 1, { ...identity(), translation: [1, 0, 0] });
  layers.tree.addTransform("map", "lidar", 2, { ...identity(), translation: [2, 0, 0] });
  const request = CloudDecoder.request;
  CloudDecoder.request = async () => ({ frame: "lidar", positions: new Float32Array([0, 0, 0]) });
  try {
    assert.throws(() => layers.objects(log, "/cloud", 2, "map", { decay: "2" }), /decoding/);
    await Promise.resolve();
    const result = layers.objects(log, "/cloud", 2, "map", { decay: "2" });
    assert.equal(result.objects[0].type, "cloud");
    if (result.objects[0].type === "cloud") assert.deepEqual(result.objects[0].transform.translation, [1, 0, 0]);
    log.putRaw("/cloud", 2, new Uint8Array([2]));
    const pending = layers.objects(log, "/cloud", 2, "map", { decay: "2" });
    assert.equal(pending.objects.length, 1, "keep the decoded scan visible while the newest scan decodes");
    layers.begin(new Log(), 0);
    assert.deepEqual(layers.tree.getFrames(), []);
    assert.throws(() => layers.objects(log, "/cloud", 2, "map", { decay: "2" }), /decoding/);
  } finally {
    CloudDecoder.request = request;
  }
});

test("expired decoded scans cannot fail TF lookup for the current decay window", async () => {
  const layers = new SpatialLayers();
  const log = new Log();
  log.putRaw("/cloud", 1, new Uint8Array([1]));
  log.putRaw("/cloud", 0, new Uint8Array());
  log.setStructuredType("/cloud", "sensor_msgs/PointCloud2");
  layers.begin(log, 1);
  layers.tree.addTransform("map", "retired_lidar", 1, identity());
  const request = CloudDecoder.request;
  CloudDecoder.request = async (payload) => ({
    frame: payload.bytes[0] === 1 ? "retired_lidar" : "map",
    positions: new Float32Array([0, 0, 0])
  });
  try {
    assert.throws(() => layers.objects(log, "/cloud", 1, "map"), /decoding/);
    await Promise.resolve();
    layers.objects(log, "/cloud", 1, "map");
    log.putRaw("/cloud", 2, new Uint8Array([2]));
    assert.throws(() => layers.objects(log, "/cloud", 2, "map"), /decoding/);
    await Promise.resolve();
    layers.tree.clear();
    const result = layers.objects(log, "/cloud", 2, "map");
    assert.equal(result.objects.length, 1);
    assert.equal(result.stamp, 2);
  } finally {
    CloudDecoder.request = request;
  }
});

test("delayed TF uses individual acquisition stamps, receipt controls availability", async () => {
  const log = new Log(),
    layers = new SpatialLayers();
  log.putRaw("/tf", 0, new Uint8Array());
  log.setStructuredType("/tf", "tf2_msgs/TFMessage");
  const tf = (child: string, sec: number, x: number, nanosec = 0) => ({
    header: { frame_id: "map", stamp: { sec, nanosec } },
    child_frame_id: child,
    transform: { translation: { x, y: 0, z: 0 }, rotation: { w: 1, x: 0, y: 0, z: 0 } }
  });
  log.putString(
    "/tf/spatial",
    10.1,
    JSON.stringify({ transforms: [tf("lidar", 10, 0), tf("other", 9, 3), tf("fallback", 0, 7)] })
  );
  log.putString(
    "/tf/spatial",
    11.1,
    JSON.stringify({ transforms: [tf("lidar", 11, 10), tf("other", 10, 5), tf("invalid", 1, 9, 1e9)] })
  );
  log.putRaw("/cloud", 0, new Uint8Array());
  log.setStructuredType("/cloud", "sensor_msgs/PointCloud2");
  log.putRaw("/cloud", 10.7, new Uint8Array([1]));
  layers.begin(log, 10);
  assert.equal(layers.tree.hasFrame("lidar"), false);
  layers.begin(log, 11.2);
  assert.equal(layers.resolve("other", "map", 10.6).translation[0], 4);
  assert.equal(layers.resolve("fallback", "map", 10.1).translation[0], 7);
  assert.equal(layers.resolve("invalid", "map", 11.1).translation[0], 9);
  const request = CloudDecoder.request;
  CloudDecoder.request = async () => ({
    frame: "lidar",
    stamp: { sec: 10, nanosec: 500000000 },
    positions: new Float32Array([0, 0, 0])
  });
  try {
    assert.throws(() => layers.objects(log, "/cloud", 11.2, "map"));
    await Promise.resolve();
    const cloud = layers.objects(log, "/cloud", 11.2, "map").objects[0];
    assert.equal(cloud.type, "cloud");
    if (cloud.type === "cloud") assert.equal(cloud.transform.translation[0], 5);
  } finally {
    CloudDecoder.request = request;
  }
});

test("continuous decode holds only until settlement; seeks and options never revive old scans", async () => {
  const layers = new SpatialLayers(),
    log = new Log();
  log.putRaw("/cloud", 0, new Uint8Array());
  log.setStructuredType("/cloud", "sensor_msgs/PointCloud2");
  const request = CloudDecoder.request;
  let finish: (v: any) => void = () => {};
  CloudDecoder.request = () =>
    new Promise((r) => {
      finish = r;
    });
  const decoded = { frame: "map", positions: new Float32Array([0, 0, 0]), min: 0, max: 10 };
  try {
    log.putRaw("/cloud", 1, new Uint8Array([1]));
    layers.begin(log, 1, true);
    assert.throws(() => layers.objects(log, "/cloud", 1, "map"));
    finish(decoded);
    await Promise.resolve();
    const first = layers.objects(log, "/cloud", 1, "map").objects[0];
    log.putRaw("/cloud", 1.1, new Uint8Array([2]));
    layers.begin(log, 1.1, true);
    assert.equal(layers.objects(log, "/cloud", 1.1, "map").objects[0].id, first.id);
    assert.doesNotMatch(layers.cloudStatus, /holding/, "brief holds are debounced");
    finish({ error: "Invalid PointCloud2 layout" });
    await Promise.resolve();
    assert.throws(() => layers.objects(log, "/cloud", 1.1, "map"), /Invalid/);
    log.putRaw("/cloud", 2, new Uint8Array([3]));
    layers.begin(log, 2, false);
    assert.throws(() => layers.objects(log, "/cloud", 2, "map"), /partial/);
    finish(decoded);
    await Promise.resolve();
    layers.objects(log, "/cloud", 2, "map");
    layers.begin(log, 2, true);
    assert.throws(() => layers.objects(log, "/cloud", 2, "map", { field: "z" }), /partial/);
  } finally {
    CloudDecoder.request = request;
  }
});

test("partial window range freezes and complete range is exact", async () => {
  const layers = new SpatialLayers(),
    log = new Log();
  log.putRaw("/cloud", 0, new Uint8Array());
  log.setStructuredType("/cloud", "sensor_msgs/PointCloud2");
  for (let i = 1; i <= 3; i++) log.putRaw("/cloud", i, new Uint8Array([i]));
  layers.begin(log, 3);
  const request = CloudDecoder.request,
    finishes = new Map<number, (v: any) => void>();
  CloudDecoder.request = (p) => new Promise((r) => finishes.set(p.bytes[0], r));
  const value = (max: number) => ({ frame: "map", positions: new Float32Array([0, 0, 0]), min: 0, max });
  const get = () => layers.objects(log, "/cloud", 3, "map", { decay: "3" }).objects as any[];
  try {
    assert.throws(get);
    finishes.get(3)!(value(10));
    await Promise.resolve();
    assert.equal(get()[0].max, 10);
    finishes.get(2)!(value(100));
    await Promise.resolve();
    assert.ok(get().every((o) => o.max === 10));
    finishes.get(1)!(value(50));
    await Promise.resolve();
    assert.ok(get().every((o) => o.max === 100));
  } finally {
    CloudDecoder.request = request;
  }
});

test("duplicate-topic layers pin independent variants and navigation is not decode loss", async () => {
  const layers = new SpatialLayers(),
    log = new Log();
  log.putRaw("/cloud", 1, new Uint8Array([1]));
  log.setStructuredType("/cloud", "sensor_msgs/PointCloud2");
  const request = CloudDecoder.request;
  CloudDecoder.request = () => new Promise(() => {});
  try {
    layers.begin(log, 1, true);
    for (const [id, field] of [
      ["a", "intensity"],
      ["b", "z"]
    ])
      assert.throws(() => layers.objects(log, "/cloud", 1, "map", { field }, id));
    const cache = (SpatialLayers as any).clouds.get(log);
    assert.equal(cache.pins.size, 2);
    assert.equal(new Set([...cache.pins.values()].flatMap((p: any) => [...p.keys])).size, 2);
    log.putRaw("/cloud", 2, new Uint8Array([2]));
    layers.begin(log, 2, false);
    assert.throws(() => layers.objects(log, "/cloud", 2, "map", {}, "a"));
    assert.doesNotMatch(layers.cloudStatus, /superseded/);
    log.putRaw("/cloud", 3, new Uint8Array([3]));
    layers.begin(log, 3, true);
    assert.throws(() => layers.objects(log, "/cloud", 3, "map", {}, "a"));
    assert.match(layers.cloudStatus, /1 scans superseded/);
    assert.throws(() => layers.objects(log, "/cloud", 3, "map", { field: "z" }, "a"));
    assert.doesNotMatch(layers.cloudStatus, /superseded/);
  } finally {
    CloudDecoder.request = request;
  }
});

test("settled scan identities match across seek, playback, and overlapping reset decodes", async () => {
  const layers = new SpatialLayers(),
    log = new Log();
  for (let t = 1; t <= 6; t++) log.putRaw("/cloud", t, new Uint8Array([t]));
  log.setStructuredType("/cloud", "sensor_msgs/PointCloud2");
  const request = CloudDecoder.request;
  const decoded = { frame: "map", positions: new Float32Array([0, 0, 0]), min: 0, max: 1 };
  CloudDecoder.request = async () => decoded;
  const sets: string[][] = [];
  try {
    for (const route of [
      [1, 6, 3],
      [6, 3],
      [1, 2, 3]
    ]) {
      for (const t of route) {
        layers.begin(log, t, route.length === 3);
        try {
          layers.objects(log, "/cloud", t, "map", { decay: "2" });
        } catch {}
        await Promise.resolve();
      }
      sets.push(
        layers
          .objects(log, "/cloud", 3, "map", { decay: "2" })
          .objects.map((o) => o.id!)
          .sort()
      );
    }
    assert.deepEqual(sets[0], sets[1]);
    assert.deepEqual(sets[1], sets[2]);
    const pending: ((v: any) => void)[] = [];
    CloudDecoder.request = () => new Promise((r) => pending.push(r));
    const other = new Log();
    other.putRaw("/cloud", 3, new Uint8Array([3]));
    other.setStructuredType("/cloud", "sensor_msgs/PointCloud2");
    layers.begin(other, 3);
    assert.throws(() => layers.objects(other, "/cloud", 3, "map"));
    layers.begin(new Log(), 0);
    layers.begin(other, 3);
    assert.throws(() => layers.objects(other, "/cloud", 3, "map"));
    pending[0]({ ...decoded, error: "old generation" });
    await Promise.resolve();
    assert.throws(() => layers.objects(other, "/cloud", 3, "map"), /decoding/);
    assert.equal(pending.length, 2);
    pending[1](decoded);
    await Promise.resolve();
    assert.equal(layers.objects(other, "/cloud", 3, "map").objects.length, 1);
  } finally {
    CloudDecoder.request = request;
  }
});

test("virtual 60 Hz clock advances decay one when decode exceeds scan period", async () => {
  const original = CloudDecoder.request;
  try {
    for (const [speed, hz, latency] of [
      [8, 10, 0.01],
      [1, 10, 0.15],
      [1, 20, 0.06]
    ]) {
      const log = new Log(),
        layers = new SpatialLayers();
      for (let i = 0; i <= hz * speed * 5; i++) log.putRaw("/cloud", i / hz, new Uint8Array([i % 256]));
      log.setStructuredType("/cloud", "sensor_msgs/PointCloud2");
      let clock = 0;
      const jobs: { at: number; finish: (v: any) => void }[] = [];
      CloudDecoder.request = () =>
        jobs.length >= 2 ? null : new Promise((finish) => jobs.push({ at: clock + latency, finish }));
      const shown = new Set<string>();
      let maxAge = 0;
      for (let tick = 0; tick < 300; tick++) {
        clock = tick / 60;
        for (let j = jobs.length - 1; j >= 0; j--)
          if (jobs[j].at <= clock) {
            jobs.splice(j, 1)[0].finish({ frame: "map", positions: new Float32Array([0, 0, 0]), min: 0, max: 1 });
          }
        await Promise.resolve();
        const time = clock * speed;
        layers.begin(log, time, true);
        try {
          const result = layers.objects(log, "/cloud", time, "map");
          shown.add(result.objects[0].id!);
          maxAge = Math.max(maxAge, time - result.stamp);
        } catch {}
      }
      assert.ok(shown.size > 20, `${speed}x ${hz} Hz ${latency}s: ${shown.size} scans`);
      assert.ok(maxAge < speed * (latency + 0.15));
      layers.begin(log, 39.95, false);
      assert.throws(() => layers.objects(log, "/cloud", 39.95, "map"), /decoding/);
    }
  } finally {
    CloudDecoder.request = original;
  }
});

test("sim stamps and skew pose scans without changing receipt-time layers; outliers and domains disclosed", async () => {
  const original = CloudDecoder.request;
  try {
    for (const offset of [0.5, 1700000000]) {
      const log = new Log(),
        layers = new SpatialLayers();
      log.putRaw("/tf", 0, new Uint8Array());
      log.setStructuredType("/tf", "tf2_msgs/TFMessage");
      for (const [stamp, x] of [
        [100, 0],
        [101, 10],
        [99999, 1000]
      ]) {
        const receipt = (stamp === 99999 ? 101.1 : stamp) + offset;
        log.putString(
          "/tf/spatial",
          receipt,
          JSON.stringify({
            transforms: [
              {
                header: { frame_id: "map", stamp: { sec: stamp, nsec: 0 } },
                child_frame_id: "lidar",
                transform: { translation: { x, y: 0, z: 0 }, rotation: { w: 1, x: 0, y: 0, z: 0 } }
              }
            ]
          })
        );
      }
      log.putRaw("/cloud", 101 + offset, new Uint8Array([1]));
      log.setStructuredType("/cloud", "sensor_msgs/PointCloud2");
      layers.begin(log, 101 + offset);
      assert.equal(layers.resolve("lidar", "map", 101 + offset).translation[0], 10);
      CloudDecoder.request = async () => ({
        frame: "lidar",
        stamp: { sec: 100, nsec: 500000000 },
        positions: new Float32Array([0, 0, 0]),
        min: 0,
        max: 1
      });
      assert.throws(() => layers.objects(log, "/cloud", 101 + offset, "map"));
      await Promise.resolve();
      const obj = layers.objects(log, "/cloud", 101 + offset, "map").objects[0] as any;
      assert.equal(obj.transform.translation[0], 5);
      layers.begin(log, 101.1 + offset);
      layers.objects(log, "/cloud", 101.1 + offset, "map");
      assert.match(layers.cloudStatus, /1 TF stamp outliers/);
      log.putRaw("/cloud", 101.2 + offset, new Uint8Array([2]));
      CloudDecoder.request = async () => ({
        frame: "lidar",
        stamp: { sec: 5000, nsec: 0 },
        positions: new Float32Array([0, 0, 0]),
        min: 0,
        max: 1
      });
      assert.throws(() => layers.objects(log, "/cloud", 101.2 + offset, "map"));
      await Promise.resolve();
      layers.objects(log, "/cloud", 101.2 + offset, "map");
      assert.match(layers.cloudStatus, /clock mismatch; receipt-time pose/);
    }
  } finally {
    CloudDecoder.request = original;
  }
});
