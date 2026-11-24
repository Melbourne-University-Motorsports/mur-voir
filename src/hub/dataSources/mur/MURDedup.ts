// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// Deduplicate by (path, stream_id, seq) for as long as the log can admit the sample.
const BLOCK_SIZE = 256;
type SequenceBlock = { latestTime: number; seen: Uint32Array };

export class SampleDeduplicator {
  private streams = new Map<string, Map<number, SequenceBlock>>();
  private floor = -Infinity;

  /** Records an unseen sample if its timestamp is still retained. */
  accept(path: string, streamId: string, seq: number, time: number): boolean {
    if (time < this.floor) return false;
    const key = path + "\u0000" + streamId;
    let stream = this.streams.get(key);
    if (stream === undefined) this.streams.set(key, (stream = new Map()));

    const index = Math.floor(seq / BLOCK_SIZE);
    let block = stream.get(index);
    if (block === undefined) {
      block = { latestTime: time, seen: new Uint32Array(BLOCK_SIZE / 32) };
      stream.set(index, block);
    }
    const offset = seq - index * BLOCK_SIZE;
    const word = offset >>> 5;
    const bit = 1 << (offset & 31);
    if (block.seen[word] & bit) return false;
    block.seen[word] |= bit;
    if (time > block.latestTime) block.latestTime = time;
    return true;
  }

  /** Drops blocks whose samples all predate the log's discard boundary. */
  discardBefore(time: number) {
    if (time <= this.floor) return;
    this.floor = time;
    for (const [key, stream] of this.streams) {
      for (const [index, block] of stream) {
        if (block.latestTime < time) stream.delete(index);
      }
      if (stream.size === 0) this.streams.delete(key);
    }
  }

  /** Forgets everything (new segment). */
  clear() {
    this.streams.clear();
    this.floor = -Infinity;
  }
}
