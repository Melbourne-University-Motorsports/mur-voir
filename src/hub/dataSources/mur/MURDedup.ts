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
// Because the set is exact, history can fill a gap anywhere: before live data started, or while a tab
// was hidden and its fields were not streamed.

/** Past this many runs per stream, the two oldest merge, so ancient gaps can no longer be backfilled. */
const MAX_RUNS = 8192;

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

    // Common case: newer than everything seen (a throttled stream skips seqs, so it may start a run)
    const last = runs.length - 1;
    if (seq > runs[last]) {
      if (seq === runs[last] + 1) runs[last] = seq;
      else runs.push(seq, seq);
      if (runs.length - stream.base > MAX_RUNS * 2) {
        // Merge the two oldest runs, then drop the consumed prefix now and then
        runs[stream.base + 2] = runs[stream.base];
        stream.base += 2;
        if (stream.base >= MAX_RUNS) {
          runs.splice(0, stream.base);
          stream.base = 0;
        }
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
