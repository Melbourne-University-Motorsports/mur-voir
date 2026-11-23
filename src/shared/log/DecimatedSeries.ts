// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import Log from "./Log";
import LogField from "./LogField";
import LoggableType from "./LoggableType";

/** About one bucket per pixel column of a wide graph. */
const TARGET_BUCKETS = 1024;
/** Below this many samples per bucket on average, reducing saves little; graphs read the log directly. */
const MIN_SAMPLES_PER_BUCKET = 4;

type Point = { t: number; v: number };

/**
 * A numeric field reduced to a few points per time bucket: the first, lowest, highest and last sample,
 * plus the first missing value (NaN) so gaps survive. A graph showing more samples than pixels draws
 * the same picture from these, and its cost stops growing with the length of the session.
 *
 * Live data only appends, so each call reduces just the new samples. Inserted history, discarded data
 * or a new bucket size (the visible span doubled or halved) rebuild it.
 */
export default class DecimatedSeries {
  private log: Log | null = null;
  private key = "";
  private historyVersion = -1;
  private discardVersion = -1;
  private bucketSize = 0;
  private consumed = 0;
  private times: number[] = [];
  private values: number[] = [];
  private openIndex = NaN;
  private first: Point | null = null;
  private last: Point | null = null;
  private min: Point | null = null;
  private max: Point | null = null;
  private missing: Point | null = null;

  /**
   * Returns reduced samples covering `[start, end]` (with the sample before `start`, as `getNumber`
   * does), or null when the range holds too few samples to need reducing.
   */
  get(log: Log, key: string, start: number, end: number): { timestamps: number[]; values: number[] } | null {
    const field = log.getField(key);
    if (field === null || field.getType() !== LoggableType.Number) return null;
    const span = end - start;
    if (!(span > 0) || !Number.isFinite(span)) return null;
    const count = field.getTimestampCount();
    const needed = TARGET_BUCKETS * MIN_SAMPLES_PER_BUCKET;
    if (count < needed || upperIndex(field, end) - lowerIndex(field, start) < needed) return null;

    const bucketSize = 2 ** Math.ceil(Math.log2(span / TARGET_BUCKETS));
    if (
      log !== this.log ||
      key !== this.key ||
      bucketSize !== this.bucketSize ||
      log.getHistoryVersion(key) !== this.historyVersion ||
      field.getDiscardVersion() !== this.discardVersion ||
      count < this.consumed
    ) {
      this.reset(log, key, field, bucketSize);
    }
    this.consume(log, key, count);
    return this.read(start, end);
  }

  private reset(log: Log, key: string, field: LogField, bucketSize: number) {
    this.log = log;
    this.key = key;
    this.historyVersion = log.getHistoryVersion(key);
    this.discardVersion = field.getDiscardVersion();
    this.bucketSize = bucketSize;
    this.consumed = 0;
    this.times = [];
    this.values = [];
    this.openIndex = NaN;
    this.first = this.last = this.min = this.max = this.missing = null;
  }

  /** Reduces the samples appended since the last call. */
  private consume(log: Log, key: string, count: number) {
    const added = count - this.consumed;
    if (added <= 0) return;
    const field = log.getField(key)!;
    const from = this.consumed === 0 ? -Infinity : field.getTimestamp(this.consumed)!;
    const data = log.getNumber(key, from, Infinity);
    if (data === undefined) return;
    // The range starts at the sample at or before `from`; the new samples are its last `added`
    const offset = data.timestamps.length - added;
    for (let i = Math.max(0, offset); i < data.timestamps.length; i++) {
      this.add(data.timestamps[i], data.values[i]);
    }
    this.consumed = count;
  }

  private add(t: number, v: number) {
    const index = Math.floor(t / this.bucketSize);
    if (index !== this.openIndex) {
      this.flush(this.times, this.values);
      this.openIndex = index;
      this.first = this.last = this.min = this.max = this.missing = null;
    }
    const point = { t, v };
    if (this.first === null) this.first = point;
    this.last = point;
    if (Number.isNaN(v)) {
      if (this.missing === null) this.missing = point;
    } else {
      if (this.min === null || v < this.min.v) this.min = point;
      if (this.max === null || v > this.max.v) this.max = point;
    }
  }

  /** Appends the open bucket's points, in time order, to `times` and `values`. */
  private flush(times: number[], values: number[]) {
    if (this.first === null) return;
    const points = [this.first, this.min, this.max, this.missing, this.last].filter(
      (point, index, all): point is Point => point !== null && all.indexOf(point) === index
    );
    points.sort((a, b) => a.t - b.t);
    for (const point of points) {
      times.push(point.t);
      values.push(point.v);
    }
  }

  private read(start: number, end: number): { timestamps: number[]; values: number[] } {
    // Completed buckets, from the point before `start` to the first point after `end`
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] < start) lo = mid + 1;
      else hi = mid;
    }
    let from = Math.max(0, lo - 1);
    let to = from;
    while (to < this.times.length && this.times[to] <= end) to++;
    if (to < this.times.length) to++;
    const timestamps = this.times.slice(from, to);
    const values = this.values.slice(from, to);
    // The open bucket, which is the newest data
    if (to === this.times.length) this.flush(timestamps, values);
    return { timestamps, values };
  }
}

/** Index of the first retained sample at or after `time`. */
function lowerIndex(field: LogField, time: number): number {
  let lo = 0;
  let hi = field.getTimestampCount();
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (field.getTimestamp(mid)! < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index after the last retained sample at or before `time`. */
function upperIndex(field: LogField, time: number): number {
  let lo = 0;
  let hi = field.getTimestampCount();
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (field.getTimestamp(mid)! <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
