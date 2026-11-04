// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

export interface PointField {
  name: string;
  offset: number;
  datatype: number;
  count: number;
}
export interface PointCloud2 {
  width: number;
  height: number;
  fields: PointField[];
  is_bigendian: boolean;
  point_step: number;
  row_step: number;
  data: Uint8Array;
  is_dense: boolean;
  header?: { frame_id: string; stamp?: { sec: number; nanosec: number } };
}
const SIZES = [0, 1, 1, 2, 2, 4, 4, 4, 8];
/** Decodes padded organized clouds without expanding points into Log fields. Non-finite points are dropped even if a producer incorrectly sets is_dense. */
export function decodePointCloud2(cloud: PointCloud2, colorField = "intensity", maxPoints = 10_000_000) {
  const { width, height, point_step, row_step } = cloud;
  if (
    ![width, height, point_step, row_step].every((v) => Number.isSafeInteger(v) && v >= 0) ||
    point_step === 0 ||
    row_step < width * point_step ||
    row_step * height > cloud.data.byteLength
  )
    throw new Error("Invalid PointCloud2 layout");
  if (width * height > 10_000_000) throw new Error("PointCloud2 exceeds 10 million point limit");
  const view = new DataView(cloud.data.buffer, cloud.data.byteOffset, cloud.data.byteLength);
  for (const field of cloud.fields) {
    if (
      !SIZES[field.datatype] ||
      !Number.isInteger(field.offset) ||
      field.offset < 0 ||
      !Number.isSafeInteger(field.count) ||
      field.count < 1 ||
      field.offset + SIZES[field.datatype] * field.count > point_step
    )
      throw new Error("Invalid point field: " + field.name);
  }
  const fields = new Map(cloud.fields.map((f) => [f.name, f]));
  if (!["x", "y", "z"].every((name) => fields.has(name))) throw new Error("PointCloud2 requires x/y/z");
  const little = !cloud.is_bigendian;
  const read = (base: number, field: PointField): number => {
    const offset = base + field.offset;
    switch (field.datatype) {
      case 1:
        return view.getInt8(offset);
      case 2:
        return view.getUint8(offset);
      case 3:
        return view.getInt16(offset, little);
      case 4:
        return view.getUint16(offset, little);
      case 5:
        return view.getInt32(offset, little);
      case 6:
        return view.getUint32(offset, little);
      case 7:
        return view.getFloat32(offset, little);
      case 8:
        return view.getFloat64(offset, little);
      default:
        return NaN;
    }
  };
  const field = fields.get(colorField);
  if (!field) throw new Error("Missing colour field: " + colorField + "; available: " + [...fields.keys()].join(", "));
  for (const f of [fields.get("x")!, fields.get("y")!, fields.get("z")!, field])
    if (f.count !== 1) throw new Error("Expected scalar point field: " + f.name);
  const rgb = colorField === "rgb" || colorField === "rgba";
  if (rgb && ![5, 6, 7].includes(field.datatype)) throw new Error("Packed RGB requires a 32-bit field");
  if (!Number.isSafeInteger(maxPoints) || maxPoints < 1) throw new Error("Invalid point budget");
  const stride = Math.max(1, Math.ceil((width * height) / maxPoints));
  const capacity = Math.ceil((width * height) / stride);
  const positions = new Float32Array(capacity * 3),
    values = new Float32Array(capacity),
    colors = rgb ? new Float32Array(capacity * 3) : null;
  const xf = fields.get("x")!,
    yf = fields.get("y")!,
    zf = fields.get("z")!;
  let count = 0,
    min = Infinity,
    max = -Infinity;
  for (let i = 0; i < width * height; i += stride) {
    const base = Math.floor(i / width) * row_step + (i % width) * point_step;
    const x = read(base, xf),
      y = read(base, yf),
      z = read(base, zf);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const offset = count * 3;
    positions[offset] = x;
    positions[offset + 1] = y;
    positions[offset + 2] = z;
    const value = rgb ? 0 : read(base, field);
    values[count] = Number.isFinite(value) ? value : 0;
    if (colors) {
      const packed = view.getUint32(base + field.offset, little);
      colors[offset] = ((packed >>> 16) & 255) / 255;
      colors[offset + 1] = ((packed >>> 8) & 255) / 255;
      colors[offset + 2] = (packed & 255) / 255;
    }
    if (Number.isFinite(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    count++;
  }
  return {
    positions: count === capacity ? positions : positions.slice(0, count * 3),
    values: count === capacity ? values : values.slice(0, count),
    colors: colors ? (count === capacity ? colors : colors.slice(0, count * 3)) : null,
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 1,
    frame: cloud.header?.frame_id ?? "",
    stamp: cloud.header?.stamp,
    fields: cloud.fields.filter((f) => f.count === 1).map((f) => f.name),
    sourcePoints: width * height,
    stride
  };
}
