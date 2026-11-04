// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import os from "node:os";
import { decodePointCloud2 } from "../../src/shared/spatial/PointCloud2";
import { cloudPacket } from "../mock-backend/src/pointcloud";
const bytes = cloudPacket(0n, 0, undefined, Number(process.argv[2] ?? 300000));
const n = new DataView(bytes.buffer).getUint32(0, true);
const cloud = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + n)));
cloud.data = bytes.subarray(4 + n);
const times: number[] = [];
for (let i = 0; i < 25; i++) {
  const start = performance.now();
  decodePointCloud2(cloud);
  times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    machine: os.cpus()[0].model,
    platform: os.platform(),
    points: cloud.width,
    decodeMedianMs: times[12],
    decodeP95Ms: times[23],
    heapBytes: process.memoryUsage().heapUsed,
    gpuMode: "none (CPU decode only)"
  })
);
