// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mapMessage, registerChannel } from "../../src/hub/dataSources/foxglove/FoxgloveMapping";
import Log from "../../src/shared/log/Log";
import LoggableType from "../../src/shared/log/LoggableType";
import { getOrDefault } from "../../src/shared/log/LogUtil";

function channel(log: Log, topic: string, schemaName: string) {
  return registerChannel(log, { id: 1, topic, schemaName, schema: "{}", encoding: "json" });
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

test("live binary and spatial histories expire, scalar telemetry and static TF keep liveDiscard", () => {
  const log = new Log();
  const cloud = channel(log, "/cloud", "sensor_msgs/msg/PointCloud2");
  const image = channel(log, "/image", "sensor_msgs/msg/Image");
  const pose = channel(log, "/pose", "geometry_msgs/msg/PoseStamped");
  const tf = channel(log, "/tf_static", "tf2_msgs/msg/TFMessage");
  for (const time of [1, 41, 61, 100]) {
    for (const mapped of [cloud, image, pose, tf]) mapMessage(log, mapped, time, bytes({ value: time }));
    log.putNumber("/scalar", time, time);
  }
  const identity = log.getField("/cloud");
  const version = log.getHistoryVersion("/cloud");
  log.getTimestamps(["/cloud", "/pose/spatial"], "union");
  log.getRaw("/cloud", 100, 100, "reader");
  log.discardLiveData(101, 1200);
  assert.deepEqual(log.getRaw("/cloud", -Infinity, Infinity)?.timestamps, [41, 61, 100]);
  assert.deepEqual(log.getRaw("/image", -Infinity, Infinity)?.timestamps, [41, 61, 100]);
  assert.deepEqual(log.getString("/pose/spatial", -Infinity, Infinity)?.timestamps, [41, 61, 100]);
  assert.deepEqual(log.getNumber("/scalar", -Infinity, Infinity)?.timestamps, [1, 41, 61, 100]);
  assert.equal(log.getRaw("/tf_static", -Infinity, Infinity)?.timestamps[0], 1);
  assert.equal(log.getField("/cloud"), identity);
  assert.equal(log.getHistoryVersion("/cloud"), version);
  assert.deepEqual(log.getTimestamps(["/cloud", "/pose/spatial"], "union"), [41, 61, 100]);
  assert.equal(getOrDefault(log, "/cloud", LoggableType.Raw, 20, null), null);
  assert.deepEqual(log.getRaw("/cloud", 80, 80, "reader")?.values[0], bytes({ value: 61 }));
  log.discardLiveData(200, 1200);
  assert.equal(getOrDefault(log, "/cloud", LoggableType.Raw, 200, null), null);
  assert.ok(log.getFieldKeys().includes("/cloud"));
  assert.equal(log.getString("/pose/spatial", 200, 200)?.values.length, 0);
});

test("bounded histories still expire with unlimited liveDiscard", () => {
  const log = new Log();
  mapMessage(log, channel(log, "/image", "sensor_msgs/Image"), 1, bytes({ data: [1] }));
  log.putNumber("/scalar", 1, 3);
  log.discardLiveData(100, -1);
  assert.deepEqual(log.getRaw("/image", 100, 100)?.values, []);
  assert.equal(log.getNumber("/scalar", 100, 100)?.values[0], 3);
});

test("file logs retain all samples and lazy strings serialize as ordinary strings", () => {
  const log = new Log();
  const pose = channel(log, "/pose", "geometry_msgs/PoseStamped");
  for (const time of [1, 2000]) mapMessage(log, pose, time, bytes({ value: time }));
  assert.deepEqual(log.getRaw("/pose", -Infinity, Infinity)?.timestamps, [1, 2000]);
  const restored = Log.fromSerialized(log.toSerialized());
  assert.deepEqual(restored.getString("/pose/spatial", -Infinity, Infinity)?.values, ['{"value":1}', '{"value":2000}']);
});

test("spatial JSON is lazy, bounded caching preserves reader values", () => {
  const log = new Log();
  let reads = 0;
  for (let i = 0; i < 4; i++)
    log.putLazyString("/spatial", i, () => {
      reads++;
      return String(i);
    });
  assert.equal(reads, 0);
  assert.equal(log.getString("/spatial", 3, 3)?.values[0], "3");
  assert.equal(log.getString("/spatial", 3, 3)?.values[0], "3");
  assert.equal(reads, 1);
  assert.deepEqual(log.getString("/spatial", -Infinity, Infinity)?.values, ["0", "1", "2", "3"]);
});

test("logical front discard hides expired samples before compaction and rejects late samples", () => {
  const log = new Log();
  const cloud = channel(log, "/cloud", "sensor_msgs/PointCloud2");
  for (let i = 0; i < 10; i++) mapMessage(log, cloud, i, bytes({ i }));
  log.getRaw("/cloud", 0, 0, "reader");
  log.discardLiveData(62, 1200);
  assert.deepEqual(log.getField("/cloud")?.getTimestamps(), [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(getOrDefault(log, "/cloud", LoggableType.Raw, 1, null, "reader"), null);
  assert.deepEqual(log.getRaw("/cloud", 3.5, 3.5, "reader")?.values, [bytes({ i: 3 }), bytes({ i: 4 })]);
  mapMessage(log, cloud, 0, bytes({ i: 99 }));
  assert.equal(log.getRaw("/cloud", -Infinity, Infinity)?.values.length, 8);
  assert.equal(Log.fromSerialized(log.toSerialized()).getRaw("/cloud", -Infinity, Infinity)?.values.length, 8);
});

test("identical bounded messages keep receipt times and remain current until their last receipt expires", () => {
  const log = new Log();
  const image = channel(log, "/image", "sensor_msgs/Image");
  for (const time of [1, 30, 70]) mapMessage(log, image, time, bytes({ data: [1] }));
  log.discardLiveData(100, 1200);
  assert.deepEqual(log.getRaw("/image", -Infinity, Infinity)?.timestamps, [70]);
  assert.deepEqual(getOrDefault(log, "/image", LoggableType.Raw, 100, null), bytes({ data: [1] }));
  log.discardLiveData(131, 1200);
  assert.equal(getOrDefault(log, "/image", LoggableType.Raw, 131, null), null);
});

test("Path and MarkerArray children expire, including children created after registration", () => {
  const log = new Log();
  for (const type of ["nav_msgs/Path", "visualization_msgs/MarkerArray", "geometry_msgs/PoseStamped"]) {
    const mapped = channel(log, "/" + type, type);
    for (const time of [1, 50, 100]) mapMessage(log, mapped, time, bytes({ child: { x: time } }));
    mapMessage(log, mapped, 100, bytes({ late: { x: 7 } }));
  }
  log.discardLiveData(101, 1200);
  for (const type of ["nav_msgs/Path", "visualization_msgs/MarkerArray"]) {
    assert.deepEqual(log.getNumber("/" + type + "/child/x", -Infinity, Infinity)?.timestamps, [50, 100]);
    assert.equal(log.getNumber("/" + type + "/late/x", 101, 101)?.values[0], 7);
  }
  assert.deepEqual(log.getNumber("/geometry_msgs/PoseStamped/child/x", -Infinity, Infinity)?.timestamps, [1, 50, 100]);
  log.discardLiveData(200, -1);
  assert.equal(log.getNumber("/nav_msgs/Path/late/x", 200, 200)?.values.length, 0);
  assert.ok(log.getFieldKeys().includes("/nav_msgs/Path/late/x"));
});

test("lazy ranges resolve only consumed entries and memoize each entry for that use", () => {
  const log = new Log();
  let reads = 0;
  for (let i = 0; i < 10; i++)
    log.putLazyString("/lazy", i, () => {
      reads++;
      return String(i);
    });
  const data = log.getString("/lazy", -Infinity, Infinity)!;
  assert.equal(reads, 0);
  assert.equal(data.values[0], "0");
  for (let i = 1; i < 10; i++) assert.equal(data.values[i], String(i));
  assert.equal(data.values[0], "0");
  assert.equal(reads, 10);
});

test("current spatial snapshots reuse eager decode without keeping every decoded message", () => {
  const log = new Log();
  const mapped = channel(log, "/pose", "geometry_msgs/PoseStamped");
  const decode = mapped.decode;
  let reads = 0;
  mapped.decode = (data) => {
    reads++;
    return decode(data);
  };
  for (let i = 0; i < 10; i++) mapMessage(log, mapped, i, bytes({ i }));
  assert.equal(reads, 10);
  assert.equal(log.getString("/pose/spatial", 9, 9)?.values[0], '{"i":9}');
  assert.equal(reads, 10);
  assert.equal(mapped.decoded.size, 2);
});

test("reference lidar load stays below 64 MiB and retains decay ten at the boundary", () => {
  const log = new Log();
  log.createBlankField("/cloud", LoggableType.Raw);
  log.setLiveRetention("/cloud", 60);
  log.setStructuredType("/cloud", "sensor_msgs/PointCloud2");
  for (let i = 0; i < 25; i++) {
    log.putRaw("/cloud", i / 10, new Uint8Array(300000 * 16).fill(i));
    log.discardLiveData(i / 10, 1200);
  }
  const raw = log.getRaw("/cloud", -Infinity, Infinity)!;
  assert.ok(raw.values.reduce((n, v) => n + v.byteLength, 0) <= 64 * 1024 * 1024);
  assert.ok(raw.timestamps.length >= 10);
  assert.equal(raw.timestamps.at(-1), 2.4);
});

test("replacement and out-of-order insertion preserve timestamps after a large live history", () => {
  const log = new Log();
  for (let i = 0; i < 50000; i++) log.putNumber("/value", i, i);
  log.putNumber("/value", 49999, -1);
  log.putNumber("/value", 1234, -2);
  log.putNumber("/value", 1234.5, -3);
  const data = log.getNumber("/value", -Infinity, Infinity)!;
  assert.equal(data.timestamps.length, 50001);
  assert.equal(data.values.at(-1), -1);
  assert.equal(data.values[data.timestamps.indexOf(1234)], -2);
  assert.equal(data.values[data.timestamps.indexOf(1234.5)], -3);
});

test("non-cloud binary histories retain the previous time horizon", () => {
  for (const type of ["sensor_msgs/Image", "sensor_msgs/LaserScan"]) {
    const log = new Log();
    log.putRaw("/raw", 0, new Uint8Array());
    log.setLiveRetention("/raw", 60);
    log.setStructuredType("/raw", type);
    for (let i = 0; i < 70; i++) log.putRaw("/raw", i / 10, new Uint8Array(1024 * 1024));
    log.discardLiveData(7, 1200);
    assert.equal(log.getRaw("/raw", -Infinity, Infinity)!.values.length, 70);
  }
});

test("32-byte padded reference lidar retains requested maximum within total cap", () => {
  const log = new Log();
  log.putRaw("/cloud", 0, new Uint8Array());
  log.setStructuredType("/cloud", "sensor_msgs/PointCloud2");
  log.setLiveRetention("/cloud", 60);
  log.setCloudDecay("/cloud", 20);
  for (let i = 1; i <= 30; i++) {
    log.putRaw("/cloud", i / 10, new Uint8Array(300000 * 32));
    log.discardLiveData(i / 10, 1200);
  }
  const raw = log.getRaw("/cloud", -Infinity, Infinity)!;
  assert.ok(raw.timestamps.length >= 20);
  assert.ok(raw.values.reduce((n, v) => n + v.byteLength, 0) <= 256 * 1024 * 1024);
});

test("retention demand survives hidden or paused silence until explicit layer removal", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const log = new Log(),
    owner = {};
  log.putRaw("/cloud", 0, new Uint8Array());
  log.setStructuredType("/cloud", "sensor_msgs/PointCloud2");
  log.setLiveRetention("/cloud", 60);
  log.setRetainedCloudLayers(owner, [{ key: "/cloud", decay: 20 }]);
  t.mock.timers.tick(10000); // hidden or paused view makes no demand refresh calls
  for (let i = 1; i <= 30; i++) {
    log.putRaw("/cloud", i / 10, new Uint8Array(10 * 1024 * 1024));
    log.discardLiveData(i / 10, 1200);
  }
  assert.ok(log.getRaw("/cloud", -Infinity, Infinity)!.timestamps.length >= 20);
  log.setRetainedCloudLayers(owner, []);
  log.discardLiveData(3, 1200);
  assert.ok(log.getRaw("/cloud", -Infinity, Infinity)!.timestamps.length <= 6);
  log.setRetainedCloudLayers(owner, [{ key: "/cloud", decay: 20 }]);
  assert.equal((log as any).retainedCloudLayers.size, 1);
});
