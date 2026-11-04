// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { parse } from "@foxglove/rosmsg";
import { MessageReader } from "@foxglove/rosmsg2-serialization";
import { decodePointCloud2 } from "./PointCloud2";
const readers = new Map<string, MessageReader>();
self.onmessage = (event) => {
  const { id, payload } = event.data;
  let message: any;
  try {
    const start = performance.now();
    let cloud = payload.cloud;
    if (payload.encoding === "mur-points-v1") {
      const bytes = payload.bytes as Uint8Array;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const length = view.getUint32(0, true);
      cloud = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
      cloud.data = bytes.subarray(4 + length);
    }
    message =
      payload.encoding === "cdr"
        ? (
            readers.get(payload.definition) ??
            (() => {
              const reader = new MessageReader(parse(payload.definition, { ros2: true }));
              readers.clear();
              readers.set(payload.definition, reader);
              return reader;
            })()
          ).readMessage(payload.bytes)
        : cloud;
    const result = decodePointCloud2(message, payload.field, payload.maxPoints);
    // @ts-expect-error worker transfer overload
    self.postMessage({ id, payload: { ...result, decodeMs: performance.now() - start } }, [
      result.positions.buffer,
      result.values.buffer,
      ...(result.colors ? [result.colors.buffer] : [])
    ]);
  } catch (error) {
    self.postMessage({
      id,
      payload: {
        error: error instanceof Error ? error.message : String(error),
        fields: message?.fields?.filter((f: any) => f.count === 1).map((f: any) => f.name)
      }
    });
  }
};
