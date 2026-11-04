// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodePointCloud2, PointCloud2 } from "../../src/shared/spatial/PointCloud2";
for (const big of [false, true])
  test("padded cloud offsets and endianness " + big, () => {
    const cloud: PointCloud2 = {
      width: 2,
      height: 2,
      point_step: 20,
      row_step: 48,
      is_dense: false,
      is_bigendian: big,
      fields: ["intensity", "x", "y", "z"].map((name, i) => ({ name, offset: i * 4, datatype: 7, count: 1 })),
      data: new Uint8Array(96)
    };
    const view = new DataView(cloud.data.buffer);
    for (const offset of [0, 20, 48, 68]) [10, 1, 2, 3].forEach((v, i) => view.setFloat32(offset + i * 4, v, !big));
    view.setFloat32(68 + 4, NaN, !big);
    const result = decodePointCloud2(cloud);
    assert.equal(result.positions.length, 9);
    assert.deepEqual([...result.positions.slice(0, 3)], [1, 2, 3]);
    assert.equal(result.min, 10);
    assert.throws(() => decodePointCloud2({ ...cloud, row_step: 1 }));
  });

test("MUR binary cloud retains xyzi and follows the map-frame vehicle position", async () => {
  const { cloudPacket } = await import("../../tools/mock-backend/src/pointcloud");
  const packet = cloudPacket(1000000000n, 0, { x: 40, y: 30 });
  const length = new DataView(packet.buffer).getUint32(0, true);
  const cloud = JSON.parse(new TextDecoder().decode(packet.subarray(4, 4 + length)));
  cloud.data = packet.subarray(4 + length);
  const result = decodePointCloud2(cloud, "intensity");
  assert.equal(result.positions.length, 3600);
  assert.equal(result.frame, "map");
  assert.equal(result.min, 0);
  assert.equal(result.max, 255);
  for (let i = 0; i < result.positions.length; i += 3) {
    assert.ok(Math.abs(result.positions[i] - 40) < 8);
    assert.ok(Math.abs(result.positions[i + 1] - 30) < 8);
  }
});

test("FLOAT64, packed RGB bits, scalar validation and deterministic budget", () => {
  for (const big of [false, true])
    for (const datatype of [6, 7]) {
      const data = new Uint8Array(64),
        view = new DataView(data.buffer);
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 3; j++) view.setFloat64(i * 32 + j * 8, j + i, !big);
        view.setUint32(i * 32 + 24, 0x12abef, !big);
      }
      const cloud: PointCloud2 = {
        width: 2,
        height: 1,
        point_step: 32,
        row_step: 64,
        is_dense: true,
        is_bigendian: big,
        data,
        fields: [
          ...["x", "y", "z"].map((name, i) => ({ name, offset: i * 8, datatype: 8, count: 1 })),
          { name: "rgb", offset: 24, datatype, count: 1 }
        ]
      };
      const result = decodePointCloud2(cloud, "rgb", 1);
      assert.equal(result.positions.length, 3);
      assert.equal(result.stride, 2);
      assert.ok(Math.abs(result.colors![1] - 0xab / 255) < 1e-6);
      assert.throws(() => decodePointCloud2(cloud, "intensity"), /Missing colour field/);
      assert.throws(
        () =>
          decodePointCloud2(
            { ...cloud, fields: [...cloud.fields, { name: "vector", offset: 0, datatype: 8, count: 2 }] },
            "vector"
          ),
        /scalar/
      );
      assert.throws(() => decodePointCloud2({ ...cloud, data: data.subarray(1) }), /layout/);
    }
});

test("zero and all-NaN clouds return empty finite ranges", () => {
  const cloud: PointCloud2 = {
    width: 1,
    height: 1,
    point_step: 16,
    row_step: 16,
    is_dense: true,
    is_bigendian: false,
    data: new Uint8Array(16),
    fields: ["x", "y", "z", "intensity"].map((name, i) => ({ name, offset: i * 4, datatype: 7, count: 1 }))
  };
  new DataView(cloud.data.buffer).setFloat32(0, NaN, true);
  assert.equal(decodePointCloud2(cloud).positions.length, 0);
  assert.equal(decodePointCloud2({ ...cloud, width: 0, row_step: 0, data: new Uint8Array() }).positions.length, 0);
});

test("invalid scalar points are omitted and counted, never represented as zero", () => {
  const cloud: PointCloud2 = {
    width: 4,
    height: 1,
    point_step: 16,
    row_step: 64,
    is_dense: true,
    is_bigendian: false,
    fields: ["x", "y", "z", "intensity"].map((name, i) => ({ name, offset: i * 4, datatype: 7, count: 1 })),
    data: new Uint8Array(64)
  };
  const view = new DataView(cloud.data.buffer);
  [NaN, Infinity, -Infinity, 10].forEach((v, i) => view.setFloat32(i * 16 + 12, v, true));
  const decoded = decodePointCloud2(cloud);
  assert.equal(decoded.invalidScalars, 3);
  assert.deepEqual([...decoded.values], [10]);
  assert.equal(decoded.min, 10);
});

test("reference mock positions are spatially distinct", async () => {
  const { cloudPacket } = await import("../../tools/mock-backend/src/pointcloud");
  for (const count of [1, 1200, 300000]) {
    const packet = cloudPacket(1000000000n, 0, { x: 0, y: 0 }, count),
      length = new DataView(packet.buffer).getUint32(0, true);
    const cloud = JSON.parse(new TextDecoder().decode(packet.subarray(4, 4 + length)));
    cloud.data = packet.subarray(4 + length);
    const { positions } = decodePointCloud2(cloud);
    const unique = new Set<string>();
    for (let i = 0; i < positions.length; i += 3) unique.add(positions.slice(i, i + 3).join(","));
    assert.equal(unique.size, count);
  }
});
