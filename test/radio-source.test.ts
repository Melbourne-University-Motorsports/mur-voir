// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { decodeCANFrame } from "../src/hub/dataSources/mqtt/MQTTPayload";
import {
  atCommandFrame,
  decodeRadioPacket,
  XBeeFrame,
  XBeeFrameParser
} from "../src/hub/dataSources/radio/RadioProtocol";
import { pickRadioPort } from "../src/hub/dataSources/radio/RadioSource";

// Six seconds from the base radio (AP=1, 9600 baud) with the car on the bench, starting with the
// reply to an "AP" query. Recorded 2026-11-22 from car radio 0013A20042838C43.
const capture = new Uint8Array(fs.readFileSync("test/fixtures/radio/xbee-ap1-capture.bin"));

/** Wraps a frame body in an API frame, escaping it for AP=2 when asked. */
function frame(body: number[], escaped = false): Uint8Array {
  const checksum = 0xff - (body.reduce((a, b) => a + b, 0) & 0xff);
  const rest = [0, body.length, ...body, checksum];
  const out = [0x7e];
  for (const byte of rest) {
    if (escaped && [0x7e, 0x7d, 0x11, 0x13].includes(byte)) out.push(0x7d, byte ^ 0x20);
    else out.push(byte);
  }
  return Uint8Array.from(out);
}

function header(sequence: number): number[] {
  const bytes = new Uint8Array(15);
  const view = new DataView(bytes.buffer);
  bytes.set([0x57, 0x54, 1]);
  view.setBigUint64(3, 0x1122334455667788n, true);
  view.setUint32(11, sequence, true);
  return Array.from(bytes);
}

function canRecord(bus: number, timeUs: bigint, id: number, data: number[], flags = 0): number[] {
  const bytes = new Uint8Array(17 + data.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  bytes[1] = bus;
  view.setBigUint64(2, timeUs, true);
  view.setUint32(10, id, true);
  bytes.set([flags, data.length, data.length], 14);
  bytes.set(data, 17);
  return Array.from(bytes);
}

function valueRecord(name: string, timeUs: bigint, value: number): number[] {
  const text = new TextEncoder().encode(name);
  const bytes = new Uint8Array(18 + text.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 2;
  view.setBigUint64(1, timeUs, true);
  view.setFloat64(9, value, true);
  bytes[17] = text.length;
  bytes.set(text, 18);
  return Array.from(bytes);
}

const receive = (data: number[]) => [0x90, 0, 0x13, 0xa2, 0, 0x42, 0x83, 0x8c, 0x43, 0xff, 0xfe, 0xc1, ...data];

test("the AP query frame matches the XBee API checksum", () => {
  assert.deepEqual(Array.from(atCommandFrame(1, "AP")), [0x7e, 0x00, 0x04, 0x08, 0x01, 0x41, 0x50, 0x65]);
});

test("a real base-radio capture decodes to car packets and DBC fields", () => {
  const parser = new XBeeFrameParser();
  const frames = parser.push(capture);
  assert.equal(parser.badFrames, 0);
  const at = frames[0] as Extract<XBeeFrame, { type: "at" }>;
  assert.equal(at.type, "at");
  assert.equal(at.command, "AP");
  assert.equal(at.status, 0);
  assert.deepEqual(Array.from(at.value), [1]);

  const received = frames.filter((f): f is Extract<XBeeFrame, { type: "receive" }> => f.type === "receive");
  assert.ok(received.length >= 5, `only ${received.length} packets`);
  assert.ok(received.every((f) => f.source === "0013A20042838C43"));
  const packets = received.map((f) => decodeRadioPacket(f.data));
  assert.ok(packets.every((p) => p !== null));
  const sequences = packets.map((p) => p!.sequence);
  assert.deepEqual(
    sequences,
    sequences.map((_, i) => sequences[0] + i)
  );

  const paths = new Set<string>();
  for (const packet of packets)
    for (const record of packet!.records)
      if (record.type === "can")
        decodeCANFrame(record.id, record.extended, record.data, null).forEach((v) => paths.add(v.path));
  for (const path of ["INVERTER/INV_VSMState", "ECU/ECU_ECUState", "TTCS/TTCS_IMDState", "PEDALBOX/PEDAL_Position1"])
    assert.ok(paths.has(path), `missing ${path} in ${[...paths].join(", ")}`);
});

test("frames split across serial reads give the same result", () => {
  const whole = new XBeeFrameParser().push(capture);
  const parser = new XBeeFrameParser();
  const pieces: XBeeFrame[] = [];
  for (let i = 0; i < capture.length; i += 7) pieces.push(...parser.push(capture.subarray(i, i + 7)));
  assert.deepEqual(pieces, whole);
});

test("AP=2 frames are unescaped", () => {
  // Sequence 0x11 and a value with 0x7E and 0x13 bytes all need escaping.
  const body = receive([...header(0x11), ...canRecord(0, 0x7e13n, 0x0aa, [0x7e, 0x7d, 0x11, 0x13])]);
  const bytes = frame(body, true);
  assert.ok(bytes.length > body.length + 4);
  const parser = new XBeeFrameParser();
  parser.escaped = true;
  const [decoded] = parser.push(bytes);
  assert.equal(decoded.type, "receive");
  const packet = decodeRadioPacket((decoded as Extract<XBeeFrame, { type: "receive" }>).data)!;
  assert.equal(packet.sequence, 0x11);
  const record = packet.records[0];
  assert.equal(record.type, "can");
  if (record.type === "can") {
    assert.equal(record.timeUs, 0x7e13n);
    assert.deepEqual(Array.from(record.data), [0x7e, 0x7d, 0x11, 0x13]);
  }
});

test("a bad checksum drops the frame and the parser recovers", () => {
  const good = frame(receive([...header(1), ...valueRecord("lvb1.voltage", 1n, 12.5)]));
  const bad = good.slice();
  bad[bad.length - 1] ^= 0xff;
  const parser = new XBeeFrameParser();
  const frames = parser.push(Uint8Array.from([0x00, ...bad, ...good]));
  assert.equal(frames.length, 1);
  assert.equal(parser.badFrames, 1);
});

test("radio packets decode CAN and value records like the base station", () => {
  const payload = Uint8Array.from([
    ...header(7),
    ...canRecord(1, 1795301573605149n, 0x18ff0001, [1, 2, 3], 1),
    ...valueRecord("lvb1.voltage", 1795301573605150n, 12.5)
  ]);
  const packet = decodeRadioPacket(payload)!;
  assert.equal(packet.runId, "1122334455667788");
  assert.equal(packet.sequence, 7);
  assert.deepEqual(packet.records[0], {
    type: "can",
    bus: 1,
    timeUs: 1795301573605149n,
    id: 0x18ff0001,
    extended: true,
    flags: 1,
    data: payload.subarray(15 + 17, 15 + 20)
  });
  assert.deepEqual(packet.records[1], { type: "value", name: "lvb1.voltage", timeUs: 1795301573605150n, value: 12.5 });
});

test("malformed radio packets are rejected", () => {
  const can = canRecord(0, 1n, 0x100, [1, 2]);
  assert.equal(decodeRadioPacket(Uint8Array.from([0x58, ...header(1).slice(1), ...can])), null); // Magic
  assert.equal(decodeRadioPacket(Uint8Array.from(header(1))), null); // No records
  assert.equal(decodeRadioPacket(Uint8Array.from([...header(1), ...can.slice(0, -1)])), null); // Truncated
  assert.equal(decodeRadioPacket(Uint8Array.from([...header(1), 3, 0, 0])), null); // Unknown record
  assert.equal(decodeRadioPacket(Uint8Array.from([...header(1), ...canRecord(0, 1n, 0x800, [])])), null); // 11-bit ID
});

test("the radio port is the XBee adapter when several are allowed", () => {
  const port = (usbVendorId?: number) => ({ getInfo: () => ({ usbVendorId }) });
  const ftdi = port(0x0403);
  assert.equal(pickRadioPort([port(), port(0x05ac), ftdi]), ftdi);
  const other = port(0x1a86);
  assert.equal(pickRadioPort([port(), other]), other);
  assert.equal(pickRadioPort([port()]), null);
});
