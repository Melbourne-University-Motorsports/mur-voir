// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import LogField from "./LogField";
import { LogValueSetNumber } from "./LogValueSets";

const CHUNK_SECONDS = 2;

export type SteppedChunk = LogValueSetNumber & { min: number; max: number; finite: boolean };
export type SteppedWindow = {
  series: SteppedSeries;
  chunks: SteppedChunk[];
  clippedStart: boolean;
  count: number;
  min: number;
  max: number;
  finite: boolean;
};

/** Local renderers and previews read chunks directly. IPC uses the command's arrays. */
export const steppedWindows = new WeakMap<LogValueSetNumber, SteppedWindow>();

/** Reuses immutable, converted samples in the interior of a moving viewport. */
export class SteppedSeries {
  private history = -1;
  private discard = -1;
  private config = "";
  private chunks = new Map<
    number,
    {
      from: number;
      through: number;
      hold: boolean;
      endMode: "exclusive" | "inclusive" | "past-tail";
      chunk: SteppedChunk;
    }
  >();
  private firstSample = -Infinity;

  get(
    field: LogField,
    history: number,
    config: string,
    range: [number, number],
    convert: (value: number) => number
  ): SteppedWindow {
    const discard = field.getDiscardVersion();
    if (history !== this.history || config !== this.config) {
      this.chunks.clear();
      this.history = history;
      this.config = config;
    } else if (discard !== this.discard) {
      // Discard can move the held sample to the new retention boundary.
      const first = field.getTimestamp(0) ?? Infinity;
      for (const index of this.chunks.keys()) {
        if (index * CHUNK_SECONDS <= Math.max(this.firstSample, first)) this.chunks.delete(index);
      }
    }
    this.discard = discard;
    this.firstSample = field.getTimestamp(0) ?? Infinity;

    const [start, end] = range;
    const first = Math.floor(start / CHUNK_SECONDS);
    const last = Math.floor(end / CHUNK_SECONDS);
    for (const index of this.chunks.keys()) {
      if (index < first || index > last) this.chunks.delete(index);
    }
    const latest = field.getTimestamp(field.getTimestampCount() - 1) ?? -Infinity;
    const result: SteppedWindow = {
      series: this,
      chunks: [],
      clippedStart: start > this.firstSample,
      count: 0,
      min: Infinity,
      max: -Infinity,
      finite: true
    };
    for (let index = first; index <= last; index++) {
      const from = Math.max(start, index * CHUNK_SECONDS);
      const to = Math.min(end, (index + 1) * CHUNK_SECONDS);
      const through = Math.min(to, latest);
      const endMode = latest < to ? "past-tail" : index < last ? "exclusive" : "inclusive";
      const cached = this.chunks.get(index);
      const hold = index === first;
      let chunk =
        cached?.from === from && cached.through === through && cached.hold === hold && cached.endMode === endMode
          ? cached.chunk
          : undefined;
      if (chunk === undefined) {
        // Include all entries exactly on an interior boundary, even when a discard
        // left an older held value at the same timestamp as the next sample.
        const lower = hold ? from : from - Number.EPSILON * Math.max(1, Math.abs(from));
        const data = field.getNumber(lower, to)!;
        const timestamps: number[] = [];
        const values: number[] = [];
        let min = Infinity;
        let max = -Infinity;
        let finite = true;
        for (let i = 0; i < data.timestamps.length; i++) {
          const t = data.timestamps[i];
          if (t < from && !hold) continue;
          if (t > to || (t === to && index < last)) break;
          const value = convert(data.values[i]);
          timestamps.push(Math.max(t, start));
          values.push(value);
          if (value < min) min = value;
          if (value > max) max = value;
          finite &&= Number.isFinite(value);
        }
        chunk = { timestamps, values, min, max, finite };
        this.chunks.set(index, { from, through, hold, endMode, chunk });
      }
      if (chunk.timestamps.length === 0) continue;
      result.chunks.push(chunk);
      result.count += chunk.timestamps.length;
      result.min = Math.min(result.min, chunk.min);
      result.max = Math.max(result.max, chunk.max);
      result.finite &&= chunk.finite;
    }
    return result;
  }
}
