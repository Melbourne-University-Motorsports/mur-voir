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
const HEADER_V2_SIZE = 23;

function decodeName(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function validCAN(id: number, extended: boolean, flags: number, dlc: number, length: number): boolean {
  return length <= 64 && dlc <= 64 && (flags & ~63) === 0 && id <= (extended ? 0x1fffffff : 0x7ff);
}

/**
 * Decodes one Wireless-telem radio datagram (services/telem/src/telem/protocol.py, versions 1
 * and 2). Returns null for anything malformed, like the base station.
 */
export function decodeRadioPacket(payload: Uint8Array): RadioPacket | null {
  if (payload.length < 3 || payload[0] !== 0x57 || payload[1] !== 0x54) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const records: RadioRecord[] = [];
  let pos: number;
  if (payload[2] === 1) {
    if (payload.length < HEADER_SIZE) return null;
    pos = HEADER_SIZE;
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
        if (!validCAN(id, extended, flags, dlc, length) || pos + length > payload.length) return null;
        records.push({ type: "can", bus, timeUs, id, extended, flags, data: payload.subarray(pos, pos + length) });
        pos += length;
      } else if (kind === 2) {
        if (pos + VALUE_SIZE > payload.length) return null;
        const timeUs = view.getBigUint64(pos + 1, true);
        const value = view.getFloat64(pos + 9, true);
        const length = payload[pos + 17];
        pos += VALUE_SIZE;
        if (length === 0 || length > 96 || pos + length > payload.length || !Number.isFinite(value)) return null;
        const name = decodeName(payload.subarray(pos, pos + length));
        if (name === null) return null;
        records.push({ type: "value", name, timeUs, value });
        pos += length;
      } else return null;
    }
  } else if (payload[2] === 2) {
    // One base time per packet; each record has a tag (kind in the low nibble) and a uint24 offset.
    if (payload.length < HEADER_V2_SIZE) return null;
    const base = view.getBigUint64(15, true);
    pos = HEADER_V2_SIZE;
    while (pos < payload.length) {
      if (pos + 4 > payload.length) return null;
      const tag = payload[pos];
      const kind = tag & 15;
      const nibble = tag >> 4;
      const timeUs = base + BigInt(payload[pos + 1] | (payload[pos + 2] << 8) | (payload[pos + 3] << 16));
      pos += 4;
      let bus: number, id: number, flags: number, dlc: number, length: number;
      if (kind === 1 || kind === 3) {
        const idSize = kind === 1 ? 2 : 4;
        if (pos + idSize + 1 > payload.length) return null;
        id = kind === 1 ? view.getUint16(pos, true) : view.getUint32(pos, true);
        length = payload[pos + idSize];
        pos += idSize + 1;
        bus = nibble;
        flags = kind === 1 ? 0 : 1;
        dlc = length;
        if (length > 8) return null;
      } else if (kind === 4 && nibble === 0) {
        if (pos + 8 > payload.length) return null;
        bus = payload[pos];
        id = view.getUint32(pos + 1, true);
        flags = payload[pos + 5];
        dlc = payload[pos + 6];
        length = payload[pos + 7];
        pos += 8;
      } else if (kind === 2 && nibble === 0) {
        if (pos + 9 > payload.length) return null;
        const value = view.getFloat64(pos, true);
        length = payload[pos + 8];
        pos += 9;
        if (length === 0 || length > 96 || pos + length > payload.length || !Number.isFinite(value)) return null;
        const name = decodeName(payload.subarray(pos, pos + length));
        if (name === null) return null;
        records.push({ type: "value", name, timeUs, value });
        pos += length;
        continue;
      } else return null;
      const extended = (flags & 1) !== 0;
      if (!validCAN(id, extended, flags, dlc, length) || pos + length > payload.length) return null;
      records.push({ type: "can", bus, timeUs, id, extended, flags, data: payload.subarray(pos, pos + length) });
      pos += length;
    }
  } else return null;
  return records.length > 0
    ? {
        runId: view.getBigUint64(3, true).toString(16).padStart(16, "0"),
        sequence: view.getUint32(11, true),
        records
      }
    : null;
}
