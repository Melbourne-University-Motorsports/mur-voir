// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import Log from "../../../shared/log/Log";
import { LiveDataSource, LiveDataSourceStatus } from "../LiveDataSource";
import { BackendState, Freshness, LiveStatusProvider, LiveStatusSummary } from "../LiveStatus";
import { decodeCANFrame, mqttMetadata, MQTTValue } from "../mqtt/MQTTPayload";
import { LiveClock, SessionTimeBase } from "../mur/MURTime";
import { atCommandFrame, decodeRadioPacket, XBeeFrameParser } from "./RadioProtocol";

/**
 * Serial speeds tried in order until the radio answers an AT query: Wireless-telem's 230400
 * (config/telem.toml [radio] baud), its old 9600, then the other standard XBee speeds.
 */
export const RADIO_BAUDS = [230400, 9600, 115200, 57600, 921600, 460800, 38400, 19200];
let lastBaud: number | null = null;
/** USB vendor IDs of XBee adapters: FTDI (Digi's XBee USB boards) and Silicon Labs. */
export const RADIO_USB_VENDORS = [0x0403, 0x10c4];
/** Car timestamps further than this from the laptop clock fall back to receive time. */
const CLOCK_TOLERANCE_NS = 10_000_000_000n;
const REPLY_TIMEOUT_MS = 700;
const RETRY_MS = 2000;

// Minimal Web Serial types (Chromium and Electron); TypeScript's DOM library does not include them.
interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}
interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface SerialLike {
  getPorts(): Promise<SerialPortLike[]>;
  requestPort(options?: { filters?: { usbVendorId: number }[] }): Promise<SerialPortLike>;
}
function getSerial(): SerialLike | null {
  return (navigator as unknown as { serial?: SerialLike }).serial ?? null;
}

/** Picks the radio among the ports this page may use: a known XBee adapter first, else any USB port. */
export function pickRadioPort<T extends { getInfo(): SerialPortInfo }>(ports: T[]): T | null {
  return (
    ports.find((port) => RADIO_USB_VENDORS.includes(port.getInfo().usbVendorId ?? -1)) ??
    ports.find((port) => port.getInfo().usbVendorId !== undefined) ??
    null
  );
}

/**
 * The base station's 900 MHz XBee radio, read straight over USB serial (Web Serial). Packets are the
 * car's Wireless-telem radio datagrams; CAN frames decode with the bundled DBCs to the same
 * `<NODE>/<Signal>` fields as candump and MQTT raw CAN, and other values become `name/with/slashes`.
 */
export default class RadioSource extends LiveDataSource implements LiveStatusProvider {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private parser = new XBeeFrameParser();
  private outputTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private replyTimer: ReturnType<typeof setTimeout> | null = null;
  private backend: BackendState = "connecting";
  private detail = "Looking for the 900 MHz radio";
  private radioAddress: string | null = null;
  private addressParts: { SH?: string; SL?: string } = {};
  private receipts = new Map<string, { time: number; approximate: boolean }>();
  private types = new Map<string, string>();
  private timeBase = new SessionTimeBase();
  private clock = new LiveClock();
  private dirty = false;
  private established = false;
  private lastSequence = new Map<string, number>();
  private packets = 0;
  private missing = 0;
  private lastPacketMs: number | null = null;

  connect(
    address: string,
    status: (status: LiveDataSourceStatus) => void,
    output: (log: Log, time: () => number) => void
  ) {
    super.connect(address, status, output);
    this.log = new Log();
    this.outputTimer = setInterval(() => {
      if (!this.dirty || !this.log) return;
      this.dirty = false;
      this.outputCallback?.(this.log, () => this.clock.now(Date.now()) ?? 0);
    }, 50);
    void this.open(true);
  }

  stop() {
    super.stop();
    if (this.outputTimer !== null) clearInterval(this.outputTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.replyTimer !== null) clearTimeout(this.replyTimer);
    void this.closePort();
  }

  private stopped(): boolean {
    return this.status === LiveDataSourceStatus.Stopped;
  }

  private fail(detail: string) {
    if (this.stopped()) return;
    this.backend = "error";
    this.detail = detail;
    this.setStatus(LiveDataSourceStatus.Error);
    void this.closePort();
    // Before the first connection, LiveConnection reports the error; after it, keep trying.
    if (this.established && this.retryTimer === null)
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.open(false);
      }, RETRY_MS);
  }

  private async open(userAction: boolean) {
    const serial = getSerial();
    if (serial === null) {
      this.fail("This browser cannot open USB serial ports. Use Chrome or Edge, or the desktop app");
      return;
    }
    let port: SerialPortLike | null;
    try {
      port = pickRadioPort(await serial.getPorts());
      // A browser lists a port only after the user picks it once. The desktop app allows every port.
      if (port === null && userAction)
        port = await serial.requestPort({ filters: RADIO_USB_VENDORS.map((usbVendorId) => ({ usbVendorId })) });
    } catch {
      port = null;
    }
    if (this.stopped()) return;
    if (port === null) {
      this.fail("No 900 MHz radio found. Plug the base radio into USB");
      return;
    }
    const bauds = lastBaud === null ? RADIO_BAUDS : [lastBaud, ...RADIO_BAUDS.filter((b) => b !== lastBaud)];
    for (const baud of bauds) {
      try {
        await port.open({ baudRate: baud });
      } catch (error) {
        this.fail(
          "Cannot open the 900 MHz radio" +
            (error instanceof Error && /already open|busy|in use/i.test(error.message)
              ? ". Another program (XCTU or the base station) is using it"
              : "")
        );
        return;
      }
      if (this.stopped()) {
        await port.close().catch(() => {});
        return;
      }
      this.port = port;
      this.parser = new XBeeFrameParser();
      this.radioAddress = null;
      this.addressParts = {};
      this.backend = "connecting";
      this.detail = "Radio found, waiting for its reply";
      void this.readLoop(port);
      // AP tells us whether frames are escaped; SH and SL give the address the car must send to.
      await this.write([atCommandFrame(1, "AP"), atCommandFrame(2, "SH"), atCommandFrame(3, "SL")]);
      const deadline = Date.now() + REPLY_TIMEOUT_MS;
      while (this.backend === "connecting" && this.port === port && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (this.stopped() || this.port !== port) return;
      if ((this.backend as BackendState) === "connected") {
        lastBaud = baud;
        return;
      }
      await this.closePort(); // No reply at this speed: try the next.
    }
    this.fail("The radio did not reply at any serial speed. It needs API mode (AP=1 or AP=2)");
  }

  private async write(frames: Uint8Array[]) {
    const writer = this.port?.writable?.getWriter();
    if (!writer) return;
    try {
      for (const frame of frames) await writer.write(frame);
    } catch {
      // The read loop reports a lost port.
    } finally {
      writer.releaseLock();
    }
  }

  private async readLoop(port: SerialPortLike) {
    try {
      while (port === this.port && port.readable) {
        this.reader = port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done || port !== this.port) break;
            if (value) this.handleBytes(value);
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch {
      // Unplugged or closed.
    }
    if (port === this.port && !this.stopped()) this.fail("The 900 MHz radio was disconnected");
  }

  private async closePort() {
    const port = this.port;
    this.port = null;
    try {
      await this.reader?.cancel();
    } catch {}
    try {
      await port?.close();
    } catch {}
  }

  private markConnected() {
    if (this.backend === "connected" || this.stopped()) return;
    if (this.replyTimer !== null) clearTimeout(this.replyTimer);
    this.replyTimer = null;
    this.backend = "connected";
    this.established = true;
    this.setStatus(LiveDataSourceStatus.Active);
  }

  private handleBytes(bytes: Uint8Array) {
    const now = Date.now();
    for (const frame of this.parser.push(bytes)) {
      if (frame.type === "at") {
        if (frame.status !== 0) continue;
        if (frame.command === "AP") this.parser.escaped = frame.value[0] === 2;
        if (frame.command === "SH" || frame.command === "SL") {
          this.addressParts[frame.command] = Array.from(frame.value, (b) => b.toString(16).padStart(2, "0"))
            .join("")
            .toUpperCase()
            .padStart(8, "0");
          if (this.addressParts.SH && this.addressParts.SL)
            this.radioAddress = this.addressParts.SH + this.addressParts.SL;
        }
        this.markConnected();
        continue;
      }
      const packet = decodeRadioPacket(frame.data);
      if (packet === null) continue;
      this.markConnected();
      this.packets++;
      this.lastPacketMs = now;
      const last = this.lastSequence.get(packet.runId);
      if (last !== undefined) {
        const delta = (packet.sequence - last) >>> 0;
        if (delta === 0 || delta >= 2 ** 31) continue; // Duplicate or late
        this.missing += delta - 1;
      }
      this.lastSequence.set(packet.runId, packet.sequence);
      const receivedNs = BigInt(now) * 1_000_000n;
      for (const record of packet.records) {
        const tNs = record.timeUs * 1000n;
        const synchronised = tNs - receivedNs < CLOCK_TOLERANCE_NS && receivedNs - tNs < CLOCK_TOLERANCE_NS;
        const values: MQTTValue[] =
          record.type === "can"
            ? (record.flags & 6) === 0
              ? decodeCANFrame(record.id, record.extended, record.data, tNs.toString())
              : []
            : [{ path: record.name.replace(/\./g, "/"), value: record.value, tNs: tNs.toString() }];
        for (const value of values) this.put(value, synchronised, receivedNs, now);
      }
    }
  }

  private put(sample: MQTTValue, synchronised: boolean, receivedNs: bigint, now: number) {
    if (!this.log) return;
    const path = sample.path;
    const type = sample.value instanceof Uint8Array ? "raw" : typeof sample.value;
    if (this.types.has(path) && this.types.get(path) !== type) return;
    const time = this.timeBase.sampleTime({
      t_ns: sample.tNs ?? receivedNs.toString(),
      received_ns: receivedNs.toString(),
      time_quality: synchronised ? "synchronised" : "unsynchronised"
    });
    if (!time || time.seconds < 0) return;
    this.types.set(path, type);
    if (typeof sample.value === "number") this.log.putNumber(path, time.seconds, sample.value);
    else if (typeof sample.value === "boolean") this.log.putBoolean(path, time.seconds, sample.value);
    else if (typeof sample.value === "string") this.log.putString(path, time.seconds, sample.value);
    else this.log.putRaw(path, time.seconds, sample.value);
    const metadata = sample.metadata ?? mqttMetadata(path);
    if (metadata && !this.log.getMetadataString(path)) this.log.setMetadataString(path, JSON.stringify(metadata));
    this.receipts.set(path, { time: now, approximate: time.approximate });
    this.clock.observe(time.seconds, now);
    this.dirty = true;
  }

  getStatusProvider(): LiveStatusProvider {
    return this;
  }
  getFieldAge(key: string): number | null {
    const receipt = this.receipts.get(key.replace(/^\//, ""));
    return receipt ? Math.max(0, (Date.now() - receipt.time) / 1000) : null;
  }
  getFieldFreshness(key: string): Freshness | null {
    const age = this.getFieldAge(key);
    // The radio sends some values at 0.5 Hz, so allow more than two periods before stale.
    return age === null ? null : this.backend !== "connected" || age > 10 ? "offline" : age > 5 ? "stale" : "online";
  }
  isFieldUnsynchronised(key: string): boolean {
    const receipt = this.receipts.get(key.replace(/^\//, ""));
    return !!receipt?.approximate && Date.now() - receipt.time < 5000;
  }
  getLiveStatus(): LiveStatusSummary {
    let detail = this.detail;
    if (this.backend === "connected") {
      const radio = this.radioAddress ? `Radio ${this.radioAddress}` : "Radio connected";
      const quiet = this.lastPacketMs === null || Date.now() - this.lastPacketMs > 5000;
      detail = quiet
        ? `${radio} · no car packets${this.radioAddress ? ` (the car must send to ${this.radioAddress})` : ""}`
        : `${radio} · ${this.packets} packets, ${this.missing} missed`;
    }
    return {
      backend: this.backend,
      backendDetail: detail,
      viewedRun: 0,
      runCount: 1,
      hasFreshData: Array.from(this.receipts.keys()).some((key) => this.getFieldFreshness(key) === "online")
    };
  }
}
