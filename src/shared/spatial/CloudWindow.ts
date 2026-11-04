// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/** Select by history only: decoded cache contents never change the requested window. */
export function cloudWindow(
  history: { getTimestampCount(): number; getTimestamp(i: number): number | undefined },
  time: number,
  decay: number
): number[] {
  let lo = 0,
    hi = history.getTimestampCount();
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (history.getTimestamp(mid)! <= time) lo = mid + 1;
    else hi = mid;
  }
  const result: number[] = [];
  for (let i = Math.max(0, lo - Math.max(1, Math.min(20, Math.floor(decay) || 1))); i < lo; i++)
    result.push(history.getTimestamp(i)!);
  return result;
}
export function cloudRange(scans: { min: number; max: number }[]): { min: number; max: number } {
  let min = Infinity,
    max = -Infinity;
  for (const scan of scans) {
    min = Math.min(min, scan.min);
    max = Math.max(max, scan.max);
  }
  return { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 1 };
}
/** Shared byte-bounded LRU. A layer's current window is protected until its next request. */
export class CloudCache {
  private entries = new Map<string, { value: any; bytes: number }>();
  private pins = new Map<object, { keys: Set<string>; time: number }>();
  bytes = 0;
  constructor(readonly budget = 128 * 1024 * 1024) {}
  protect(owner: object, keys: string[]) {
    this.pins.set(owner, { keys: new Set(keys), time: Date.now() });
  }
  get(key: string) {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry?.value;
  }
  set(key: string, value: any) {
    const bytes =
      256 +
      (value.error?.length ?? 0) * 2 +
      (value.positions?.byteLength ?? 0) +
      (value.values?.byteLength ?? 0) +
      (value.colors?.byteLength ?? 0);
    const pinned = new Set<string>();
    for (const [owner, pin] of this.pins) {
      if (Date.now() - pin.time > 2000) this.pins.delete(owner);
      else pin.keys.forEach((k) => pinned.add(k));
    }
    for (const [k, entry] of this.entries) {
      if (this.bytes + bytes <= this.budget) break;
      if (!pinned.has(k)) {
        this.entries.delete(k);
        this.bytes -= entry.bytes;
      }
    }
    if (this.bytes + bytes > this.budget) return false;
    const old = this.entries.get(key);
    if (old) this.bytes -= old.bytes;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    return true;
  }
}
