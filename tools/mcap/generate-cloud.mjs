// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// node tools/mcap/generate-cloud.mjs [points=300000] [scans=30]
import { parse } from "@foxglove/rosmsg";
import { MessageWriter } from "@foxglove/rosmsg2-serialization";
import { McapWriter } from "@mcap/core";
import fs from "node:fs/promises";
const points = Number(process.argv[2] ?? 300000),
  scans = Number(process.argv[3] ?? 30);
if (!Number.isSafeInteger(points) || points < 1 || points > 10000000 || !Number.isSafeInteger(scans) || scans < 1)
  throw Error("Invalid size");
await fs.mkdir("/tmp/mur-point-clouds", { recursive: true });
const file = await fs.open(process.argv[4] ?? "/tmp/mur-point-clouds/reference.mcap", "w");
let position = 0n;
const writer = new McapWriter({
  writable: {
    position: () => position,
    write: async (b) => {
      await file.write(b);
      position += BigInt(b.length);
    }
  },
  useChunks: true
});
await writer.start({ profile: "ros2", library: "mur-voir fixture" });
const header = `std_msgs/Header header
uint32 height
uint32 width
sensor_msgs/PointField[] fields
bool is_bigendian
uint32 point_step
uint32 row_step
uint8[] data
bool is_dense
===
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
===
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
===
MSG: sensor_msgs/PointField
string name
uint32 offset
uint8 datatype
uint32 count`;
const tf = `geometry_msgs/TransformStamped[] transforms
===
MSG: geometry_msgs/TransformStamped
std_msgs/Header header
string child_frame_id
geometry_msgs/Transform transform
===
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
===
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
===
MSG: geometry_msgs/Transform
geometry_msgs/Vector3 translation
geometry_msgs/Quaternion rotation
===
MSG: geometry_msgs/Vector3
float64 x
float64 y
float64 z
===
MSG: geometry_msgs/Quaternion
float64 x
float64 y
float64 z
float64 w`;
async function channel(topic, name, definition) {
  const schemaId = await writer.registerSchema({
    name,
    encoding: "ros2msg",
    data: new TextEncoder().encode(definition)
  });
  return {
    id: await writer.registerChannel({ topic, schemaId, messageEncoding: "cdr", metadata: new Map() }),
    encoder: new MessageWriter(parse(definition, { ros2: true }))
  };
}
const cloud = await channel("/lidar/points", "sensor_msgs/msg/PointCloud2", header),
  tree = await channel("/tf_static", "tf2_msgs/msg/TFMessage", tf);
await writer.addMessage({
  channelId: tree.id,
  sequence: 0,
  logTime: 0n,
  publishTime: 0n,
  data: tree.encoder.writeMessage({
    transforms: [
      {
        header: { stamp: { sec: 0, nanosec: 0 }, frame_id: "map" },
        child_frame_id: "lidar",
        transform: { translation: { x: 2, y: 0, z: 1 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
      }
    ]
  })
});
for (let scan = 0; scan < scans; scan++) {
  const height = points % 16 === 0 ? 16 : 1,
    width = points / height,
    point_step = 20,
    row_step = width * point_step + 16;
  const data = new Uint8Array(row_step * height),
    v = new DataView(data.buffer);
  for (let i = 0; i < points; i++) {
    const o = Math.floor(i / width) * row_step + (i % width) * point_step,
      a = ((i % 1000) / 1000) * Math.PI * 2,
      r = 3 + (5 * i) / points;
    v.setFloat32(o, i % 997 === 0 ? NaN : r * Math.cos(a), true);
    v.setFloat32(o + 4, r * Math.sin(a), true);
    v.setFloat32(o + 8, (i % 16) * 0.1, true);
    v.setFloat32(o + 12, i % 256, true);
  }
  const time = BigInt(scan) * 100000000n;
  await writer.addMessage({
    channelId: cloud.id,
    sequence: scan,
    logTime: time,
    publishTime: time,
    data: cloud.encoder.writeMessage({
      header: { stamp: { sec: Math.floor(scan / 10), nanosec: (scan % 10) * 100000000 }, frame_id: "lidar" },
      height,
      width,
      fields: ["x", "y", "z", "intensity"].map((name, i) => ({ name, offset: i * 4, datatype: 7, count: 1 })),
      is_bigendian: false,
      point_step,
      row_step,
      data,
      is_dense: false
    })
  });
}
await writer.end();
await file.close();
console.log({ path: "/tmp/mur-point-clouds/reference.mcap", points, scans, bytes: String(position) });
