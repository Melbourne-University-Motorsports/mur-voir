// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// Sample deduplication on (path, stream_id, seq) (spec 01 §4.1, §6). Pure, so it can be unit tested.
//
// Each (path, stream_id) keeps the exact set of seqs seen, stored as sorted runs of consecutive seqs. A
// stream that arrives in order extends its last run, so memory follows the number of gaps, not samples.
// Keep the set exact over the backend's backfill window. Once a sequence falls out of the window,
// reject it on both live and history paths.

/** The mock retains 360 seconds at up to 100 Hz per signal. */
const SEQUENCE_WINDOW = 36_000;

interface Runs {
  // Flat [start0, end0, start1, end1, ...] from index `base`, inclusive ends, ascending and non-adjacent
  list: number[];
  base: number;
}

export class SampleDeduplicator {
  private streams = new Map<string, Runs>();

  /** Returns true if the sample is new (and records it), false if it is a duplicate. */
  accept(path: string, streamId: string, seq: number): boolean {
    const streamKey = path + "\u0000" + streamId;
    const stream = this.streams.get(streamKey);
    if (stream === undefined) {
      this.streams.set(streamKey, { list: [seq, seq], base: 0 });
      return true;
    }
    const runs = stream.list;

    const last = runs.length - 1;
    const floor = Math.max(seq, runs[last]) - SEQUENCE_WINDOW + 1;
    if (seq < floor) return false;

    // Common case: a new maximum. Drop entire expired runs and trim any run crossing the floor.
    if (seq > runs[last]) {
      if (seq === runs[last] + 1) runs[last] = seq;
      else runs.push(seq, seq);
      while (runs[stream.base + 1] < floor) stream.base += 2;
      runs[stream.base] = Math.max(runs[stream.base], floor);
      if (stream.base > 0 && stream.base * 2 >= runs.length) {
        runs.splice(0, stream.base);
        stream.base = 0;
      }
      return true;
    }

    // Find the last run starting at or before seq
    const base = stream.base / 2;
    let lo = base;
    let hi = runs.length / 2 - 1;
    let index = base - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (runs[mid * 2] <= seq) {
        index = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (index >= base && seq <= runs[index * 2 + 1]) return false;

    // New: extend a neighbouring run or insert one, merging runs that now touch
    const joinsPrevious = index >= base && runs[index * 2 + 1] === seq - 1;
    const next = index + 1;
    const joinsNext = next * 2 < runs.length && runs[next * 2] === seq + 1;
    if (joinsPrevious && joinsNext) {
      runs[index * 2 + 1] = runs[next * 2 + 1];
      runs.splice(next * 2, 2);
    } else if (joinsPrevious) {
      runs[index * 2 + 1] = seq;
    } else if (joinsNext) {
      runs[next * 2] = seq;
    } else {
      runs.splice(next * 2, 0, seq, seq);
    }
    return true;
  }

  /** Filters a batch of history samples for one path, returning the new ones in ascending seq order. */
  filterHistory<T extends { stream_id: string; seq: number }>(path: string, samples: T[]): T[] {
    const sorted = [...samples].sort((a, b) => a.seq - b.seq);
    return sorted.filter((sample) => this.accept(path, sample.stream_id, sample.seq));
  }

  /** Forgets everything (new segment). */
  clear() {
    this.streams.clear();
  }
}
