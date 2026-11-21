// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// The 900 MHz base radio's serial stream, decoded without the Wireless-telem base station.
// Pure: no DOM or Web Serial access, so it can be unit tested with node:test.

/** A frame from the radio: received data from another radio, or the reply to a local AT command. */
export type XBeeFrame =
  | { type: "receive"; source: string; data: Uint8Array }
  | { type: "at"; frameId: number; command: string; status: number; value: Uint8Array };

const START = 0x7e;
const ESCAPE = 0x7d;

/**
 * Splits the XBee API byte stream into frames. Mode 1 (AP=1) frames are sent as is; mode 2 (AP=2)
 * escapes 0x7E, 0x7D, 0x11 and 0x13 after the start byte. Bytes before a start byte and frames
 * with a bad checksum are dropped.
 */
export class XBeeFrameParser {
  escaped = false;
  private buffer: number[] = [];
  private escapeNext = false;
  private inFrame = false;
  /** Frames dropped for a bad checksum or an impossible length. */
  badFrames = 0;

  push(chunk: Uint8Array): XBeeFrame[] {
    const frames: XBeeFrame[] = [];
    for (let byte of chunk) {
      if (byte === START) {
        if (this.inFrame && this.buffer.length > 0) this.badFrames++;
        this.inFrame = true;
        this.buffer = [];
        this.escapeNext = false;
        continue;
      }
      if (!this.inFrame) continue;
      if (this.escaped) {
        if (this.escapeNext) {
          byte ^= 0x20;
          this.escapeNext = false;
        } else if (byte === ESCAPE) {
          this.escapeNext = true;
          continue;
        }
      }
      this.buffer.push(byte);
      if (this.buffer.length < 2) continue;
      const length = (this.buffer[0] << 8) | this.buffer[1];
      if (length === 0 || length > 0x1000) {
        this.badFrames++;
        this.inFrame = false;
        continue;
      }
      if (this.buffer.length < length + 3) continue;
      this.inFrame = false;
      const body = this.buffer.slice(2, 2 + length);
      const sum = body.reduce((total, value) => total + value, this.buffer[2 + length]);
      if ((sum & 0xff) !== 0xff) {
        this.badFrames++;
        continue;
      }
      const frame = parseFrame(Uint8Array.from(body));
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function parseFrame(body: Uint8Array): XBeeFrame | null {
  switch (body[0]) {
    case 0x90: // Receive packet
      return body.length >= 12 ? { type: "receive", source: hex(body.subarray(1, 9)), data: body.subarray(12) } : null;
    case 0x91: // Explicit receive indicator (AO set)
      return body.length >= 18 ? { type: "receive", source: hex(body.subarray(1, 9)), data: body.subarray(18) } : null;
    case 0x88: // Local AT command response
      return body.length >= 5
        ? {
            type: "at",
            frameId: body[1],
            command: String.fromCharCode(body[2], body[3]),
            status: body[4],
            value: body.subarray(5)
          }
        : null;
    default:
      return null;
  }
}

/** Builds a local AT command query frame (unescaped, which is also valid in mode 2 for these bytes). */
export function atCommandFrame(frameId: number, command: string): Uint8Array {
  const body = [0x08, frameId, command.charCodeAt(0), command.charCodeAt(1)];
  const checksum = 0xff - (body.reduce((total, value) => total + value, 0) & 0xff);
  return Uint8Array.from([START, 0x00, body.length, ...body, checksum]);
}

/** One record from the car. Times are Unix microseconds from the Pi's clock. */
export type RadioRecord =
  | { type: "can"; bus: number; timeUs: bigint; id: number; extended: boolean; flags: number; data: Uint8Array }
  | { type: "value"; name: string; timeUs: bigint; value: number };

export interface RadioPacket {
  runId: string;
  sequence: number;
  records: RadioRecord[];
}

const HEADER_SIZE = 15;
const CAN_SIZE = 17;
const VALUE_SIZE = 18;

/**
 * Decodes one Wireless-telem radio datagram (services/telem/src/telem/protocol.py, version 1).
 * Returns null for anything malformed, like the base station.
 */
export function decodeRadioPacket(payload: Uint8Array): RadioPacket | null {
  if (payload.length < HEADER_SIZE || payload[0] !== 0x57 || payload[1] !== 0x54 || payload[2] !== 1) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const runId = view.getBigUint64(3, true).toString(16).padStart(16, "0");
  const sequence = view.getUint32(11, true);
  const records: RadioRecord[] = [];
  let pos = HEADER_SIZE;
  while (pos < payload.length) {
    const kind = payload[pos];
    if (kind === 1) {
      if (pos + CAN_SIZE > payload.length) return null;
      const bus = payload[pos + 1];
      const timeUs = view.getBigUint64(pos + 2, true);
      const id = view.getUint32(pos + 10, true);
      const flags = payload[pos + 14];
      const dlc = payload[pos + 15];
      const length = payload[pos + 16];
      pos += CAN_SIZE;
      const extended = (flags & 1) !== 0;
      if (length > 64 || dlc > 64 || flags & ~63 || id > (extended ? 0x1fffffff : 0x7ff)) return null;
      if (pos + length > payload.length) return null;
      records.push({ type: "can", bus, timeUs, id, extended, flags, data: payload.subarray(pos, pos + length) });
      pos += length;
    } else if (kind === 2) {
      if (pos + VALUE_SIZE > payload.length) return null;
      const timeUs = view.getBigUint64(pos + 1, true);
      const value = view.getFloat64(pos + 9, true);
      const length = payload[pos + 17];
      pos += VALUE_SIZE;
      if (length === 0 || length > 96 || pos + length > payload.length || !Number.isFinite(value)) return null;
      let name: string;
      try {
        name = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(pos, pos + length));
      } catch {
        return null;
      }
      records.push({ type: "value", name, timeUs, value });
      pos += length;
    } else {
      return null;
    }
  }
  return records.length > 0 ? { runId, sequence, records } : null;
}
