// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import Log from "../../../shared/log/Log";
import LoggableType from "../../../shared/log/LoggableType";
import { sendProgress, setMetadata } from "../ImporterUtil";
import { decodeCSVText, detectDelimiter, readRows } from "../csv/CSVParser";
import { BUNDLED_DBCS } from "./BundledDBCs";
import { CANDUMP_ENUM_RAW_SUFFIX, getNodeName, getSignalKey, getUnknownFrameKey } from "./CANKeys";
import { CandumpIndex, DATA_STRIDE, FLAG_ERROR, FLAG_EXTENDED, FLAG_REMOTE, indexCandump } from "./Candump";
import { DBCMessage, DBCSet, DBCSignal, decodeSignal, extractRaw, parseDBC, sortDBCFiles } from "./DBC";

/**
 * candump -L importer.
 *
 * Files from the main process: [log, <stem>.json sidecar | null, <stem>.markers.csv | null,
 * DBC pack | null]. The DBC pack is UTF-8 JSON `{ "<relative path>": "<dbc text>" }` read from
 * the DBC folder in Preferences; without it the bundled mur-msgs DBCs are used.
 *
 * Frames are indexed once; each signal is decoded only when requested, from that message's
 * frames only. Decoding uses the merged DBC set by ID, so both bus-naming schemes work.
 *
 * An MF4 can carry DBC snapshots for some buses (`busDBCs`, by interface name such as "can0"). Frames
 * on such a bus decode with its snapshots only; every other bus uses the DBC folder or bundled set.
 * Field keys don't depend on the bus, so a signal that both sets define the same way keeps its key.
 *
 * One exception: when the default set multiplexes a frame that a bus's snapshot defines without a
 * multiplexor, at the same length, that bus decodes the frame with the default definition. Old runs
 * carry snapshots from before a message was multiplexed (ENNOID_VCell, whose frames all decoded into
 * the same three cell signals), so their plots would mix groups. Metadata/Import lists these frames.
 */

/** DBC files attached to a log, per interface ("can0"): file name → DBC text. */
export type BusDBCs = { [iface: string]: { [name: string]: string } };

interface SignalPart {
  message: DBCMessage;
  signal: DBCSignal;
  frames: number[];
}

function buildSet(files: { [path: string]: string }): DBCSet {
  const set = new DBCSet();
  sortDBCFiles(Object.keys(files)).forEach((path) => set.add(parseDBC(files[path], path)));
  if (set.duplicates.length > 0) console.warn("Duplicate DBC message IDs (first wins):", set.duplicates);
  return set;
}

export function createCandumpImporter() {
  let log = new Log(false);
  let index: CandumpIndex;
  let defaultSet = new DBCSet();
  let defaultOrigin = "bundled";
  let defaultFiles: string[] = [];
  const busSets = new Map<string, DBCSet>();
  const unknownFrames = new Map<string, number[]>(); // "<ext><id>" → frame indices
  const signalsByKey = new Map<string, { parts: SignalPart[]; enumRaw: boolean }>();
  const decoded = new Set<string>();

  function messageKey(id: number, extended: boolean) {
    return (extended ? "x" : "s") + id.toString();
  }

  function loadDBCs(pack: Uint8Array | null) {
    let files: { [path: string]: string } = BUNDLED_DBCS;
    defaultOrigin = "bundled";
    if (pack !== null && pack.length > 0) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(pack));
        if (typeof parsed === "object" && Object.keys(parsed).length > 0) {
          files = parsed;
          defaultOrigin = "DBC folder";
        }
      } catch (error) {
        console.error("Failed to read the DBC folder, using the bundled DBCs", error);
      }
    }
    defaultSet = buildSet(files);
    defaultFiles = sortDBCFiles(Object.keys(files));
  }

  /**
   * The message whose names make a snapshot signal's key. Keys come from the default set (bundled or
   * DBC folder), so a run decoded with its snapshots keeps the keys layouts use: a forwarded message
   * can name a different transmitter on each bus (Rear_Dynamics is REAR in the control DBC and ECU in
   * the telemetry one), and the merged default set picks one. A signal the default set doesn't have
   * under that ID (renamed, or new) keys by the snapshot's own names.
   */
  function keyMessageFor(message: DBCMessage, signal: DBCSignal): DBCMessage {
    const known = defaultSet.get(message.id, message.extended);
    return known?.signals.some((other) => other.name === signal.name) ? known : message;
  }

  /**
   * The default set's definition of a frame to decode instead of a snapshot's: the default set
   * multiplexes it, the snapshot doesn't, and both give it the same length.
   */
  function multiplexedDefault(attached: DBCMessage): DBCMessage | undefined {
    if (attached.signals.some((signal) => signal.isMultiplexor)) return undefined;
    const known = defaultSet.get(attached.id, attached.extended);
    if (known === undefined || known.dlc !== attached.dlc) return undefined;
    return known.signals.some((signal) => signal.isMultiplexor) ? known : undefined;
  }

  function start(files: (Uint8Array | null)[], frameIndex?: CandumpIndex, busDBCs: BusDBCs = {}): Log {
    loadDBCs(files[3] ?? null);
    Object.entries(busDBCs).forEach(([iface, dbcs]) => {
      if (Object.keys(dbcs).length > 0) busSets.set(iface, buildSet(dbcs));
    });
    index = frameIndex ?? indexCandump(files[0]!, (fraction) => sendProgress(fraction * 0.9));
    if (index.count === 0) throw new Error("No candump frames found");

    // Group frames by bus DBC set and message, and collect bus statistics
    let minTime = Infinity;
    let maxTime = -Infinity;
    const errorFrames: number[] = [];
    const remoteCounts = new Map<string, number>();
    const groups = new Map<string, { setIface: string | null; frames: number[] }>();
    const setIfaceOf = index.ifaces.map((iface) => (busSets.has(iface) ? iface : null));
    for (let i = 0; i < index.count; i++) {
      const timestamp = index.timestamps[i];
      if (timestamp < minTime) minTime = timestamp;
      if (timestamp > maxTime) maxTime = timestamp;
      const flags = index.flags[i];
      if (flags & FLAG_ERROR) {
        errorFrames.push(i);
        continue;
      }
      const key = messageKey(index.ids[i], (flags & FLAG_EXTENDED) !== 0);
      if (flags & FLAG_REMOTE) {
        remoteCounts.set(key, (remoteCounts.get(key) ?? 0) + 1);
        continue;
      }
      const setIface = setIfaceOf[index.ifaceIndex[i]];
      const groupKey = (setIface ?? "") + "|" + key;
      let group = groups.get(groupKey);
      if (group === undefined) {
        group = { setIface, frames: [] };
        groups.set(groupKey, group);
      }
      group.frames.push(i);
    }
    log.updateRangeWithTimestamp(minTime);
    log.updateRangeWithTimestamp(maxTime);

    const busesOf = (frames: number[]) => {
      const ifaces = new Set<string>();
      for (let i = 0; i < frames.length && ifaces.size < index.ifaces.length; i++) {
        ifaces.add(index.ifaces[index.ifaceIndex[frames[i]]]);
      }
      return ifaces;
    };

    // Each signal of each message in the log gets a field. The same message decoded by two sets
    // (one bus with snapshots, another without) shares the field when the signal keeps its key.
    const messageCount = new Set<string>();
    const overridesByBus = new Map<string, string[]>(); // iface → messages decoded with the default set
    groups.forEach((group) => {
      const firstFrame = group.frames[0];
      const extended = (index.flags[firstFrame] & FLAG_EXTENDED) !== 0;
      const id = index.ids[firstFrame];
      messageCount.add(messageKey(id, extended));
      let message = (group.setIface === null ? defaultSet : busSets.get(group.setIface)!).get(id, extended);
      const override = group.setIface !== null && message !== undefined ? multiplexedDefault(message) : undefined;
      if (override !== undefined) {
        message = override;
        overridesByBus.set(group.setIface!, [...(overridesByBus.get(group.setIface!) ?? []), override.name]);
      }
      if (message === undefined) {
        const key = messageKey(id, extended);
        unknownFrames.set(key, [...(unknownFrames.get(key) ?? []), ...group.frames]);
        return;
      }
      message.signals.forEach((signal) => {
        const enumRaw = signal.valueTable !== null;
        const part = { message, signal, frames: group.frames };
        const keyMessage = group.setIface === null ? message : keyMessageFor(message, signal);
        // The plain key, or the message-qualified one a clash gave it (see getSignalKey)
        const shared = [
          getNodeName(keyMessage) + "/" + signal.name,
          getNodeName(keyMessage) + "/" + keyMessage.name + "/" + signal.name
        ].find((candidate) => {
          const other = signalsByKey.get(candidate)?.parts[0];
          return (
            other !== undefined &&
            other.message.id === message.id &&
            other.message.extended === message.extended &&
            (other.signal.valueTable !== null) === enumRaw
          );
        });
        if (shared !== undefined) {
          signalsByKey.get(shared)!.parts.push(part);
          if (enumRaw) signalsByKey.get(shared + CANDUMP_ENUM_RAW_SUFFIX)!.parts.push(part);
          return;
        }
        const fieldKey = getSignalKey(keyMessage, signal, (candidate) => signalsByKey.has(candidate));
        signalsByKey.set(fieldKey, { parts: [part], enumRaw: false });
        if (enumRaw) signalsByKey.set(fieldKey + CANDUMP_ENUM_RAW_SUFFIX, { parts: [part], enumRaw: true });
      });
    });

    signalsByKey.forEach((field, fieldKey) => {
      if (field.enumRaw) return;
      const { message, signal } = field.parts[0];
      const enumRaw = signal.valueTable !== null;
      const metadata = {
        dbcSignal: signal.name,
        unit: enumRaw ? undefined : signal.unit,
        message: message.name,
        id: "0x" + message.id.toString(16).toUpperCase() + (message.extended ? " (extended)" : ""),
        node: message.transmitter,
        dbc: [...new Set(field.parts.map((part) => part.message.source))].join(", "),
        buses: [...new Set(field.parts.flatMap((part) => [...busesOf(part.frames)]))].join(", "),
        comment: signal.comment,
        values: signal.valueTable ? Object.fromEntries(signal.valueTable) : undefined,
        sentinels:
          signal.sentinels.size > 0
            ? [...signal.sentinels].map((value) => "0x" + value.toString(16).toUpperCase())
            : undefined
      };
      if (enumRaw) {
        // Enum: the label as a string (discrete in graphs), with the number as a child
        log.createBlankField(fieldKey, LoggableType.String);
        setMetadata(log, fieldKey, metadata);
        const rawKey = fieldKey + CANDUMP_ENUM_RAW_SUFFIX;
        log.createBlankField(rawKey, LoggableType.Number);
        setMetadata(log, rawKey, { ...metadata, unit: signal.unit });
      } else {
        log.createBlankField(fieldKey, LoggableType.Number);
        setMetadata(log, fieldKey, metadata);
      }
    });

    const unknownIds: string[] = [];
    unknownFrames.forEach((frames, key) => {
      frames.sort((a, b) => a - b);
      const fieldKey = getUnknownFrameKey(index.ids[frames[0]], key.startsWith("x"));
      unknownIds.push(fieldKey);
      log.createBlankField(fieldKey, LoggableType.Raw);
      setMetadata(log, fieldKey, {
        description: "Frames with no DBC definition (raw data bytes)",
        frames: frames.length,
        buses: [...busesOf(frames)].join(", ")
      });
    });

    // Error frames, per interface (value = error class bits from the CAN ID)
    errorFrames.forEach((frame) => {
      const key = "CAN/" + index.ifaces[index.ifaceIndex[frame]] + "/ErrorFrame";
      log.putNumber(key, index.timestamps[frame], index.ids[frame]);
    });

    // Sidecars
    if (files[1]) readJsonSidecar(files[1], minTime);
    if (files[2]) readMarkers(files[2]);

    // Import summary, including which DBCs decoded each bus, so a wrong decode can be traced
    // A bus whose snapshot lost frames to the default set's multiplexed definitions lists them
    const dbcsByBus: {
      [iface: string]: { from: string; files: string[]; overrides?: string[]; overridesFrom?: string };
    } = Object.fromEntries(
      index.ifaces.map((iface) => {
        if (!busSets.has(iface)) return [iface, { from: defaultOrigin, files: defaultFiles }];
        const dbcs = { from: "attached", files: sortDBCFiles(Object.keys(busDBCs[iface])) };
        const overrides = overridesByBus.get(iface);
        return [iface, overrides ? { ...dbcs, overrides: overrides.sort(), overridesFrom: defaultOrigin } : dbcs];
      })
    );
    const unusedAttachments = Object.keys(busDBCs).filter((iface) => !index.ifaces.includes(iface));
    console.info(
      "CAN DBCs: " +
        Object.entries(dbcsByBus)
          .map(
            ([iface, dbcs]) =>
              `${iface} ${dbcs.from} (${dbcs.files.join(", ")})` +
              (dbcs.overrides ? ` with ${dbcs.overridesFrom} multiplexed ${dbcs.overrides.join(", ")}` : "")
          )
          .join("; ") +
        (unusedAttachments.length ? `; attached for buses with no frames: ${unusedAttachments.join(", ")}` : "")
    );
    const usedSources = new Set<string>();
    signalsByKey.forEach((field) => field.parts.forEach((part) => usedSources.add(part.message.source)));
    log.putJSON(
      "Metadata/Import",
      minTime,
      JSON.stringify({
        frames: index.count,
        interfaces: index.ifaces,
        messages: messageCount.size,
        unknownMessages: unknownIds.length,
        errorFrames: errorFrames.length,
        remoteFrames: [...remoteCounts.values()].reduce((a, b) => a + b, 0),
        malformedLines: index.malformedLines,
        dbcFiles: [...usedSources],
        dbcsByBus
      })
    );
    return log;
  }

  function readJsonSidecar(bytes: Uint8Array, timestamp: number) {
    try {
      const text = new TextDecoder().decode(bytes);
      JSON.parse(text); // Validate
      log.putJSON("Metadata/Run", timestamp, text);
    } catch (error) {
      console.warn("Could not read the .json sidecar", error);
    }
  }

  /** `<stem>.markers.csv`: columns t_epoch, t_rel_s, text. */
  function readMarkers(bytes: Uint8Array) {
    const text = decodeCSVText(bytes);
    const rows = readRows(text, detectDelimiter(text), Infinity);
    if (rows.length === 0) return;
    const header = rows[0].map((cell) => cell.trim().toLowerCase());
    let timeColumn = header.indexOf("t_epoch");
    let textColumn = header.indexOf("text");
    const hasHeader = timeColumn !== -1 || textColumn !== -1;
    if (timeColumn === -1) timeColumn = 0;
    if (textColumn === -1) textColumn = header.length - 1;
    rows.slice(hasHeader ? 1 : 0).forEach((row) => {
      const timestamp = Number(row[timeColumn]);
      if (!isFinite(timestamp) || row.length <= textColumn) return;
      log.putString("Markers", timestamp, row[textColumn]);
    });
  }

  function decode(keys: string[]): string[] {
    const sendKeys: string[] = [];
    keys.forEach((key) => {
      if (decoded.has(key)) return;
      decoded.add(key);
      const target = signalsByKey.get(key);
      if (target !== undefined) {
        decodeSignalField(key, target.parts, target.enumRaw);
        sendKeys.push(key);
        return;
      }
      if (key.startsWith("CAN/Unknown/")) {
        decodeUnknown(key);
        sendKeys.push(key);
      }
    });
    return sendKeys;
  }

  function decodeSignalField(key: string, parts: SignalPart[], enumRaw: boolean) {
    // Parts from different buses (and DBC sets) are merged in time order
    const frames: [number, SignalPart][] = parts.flatMap((part) =>
      part.frames.map((frame): [number, SignalPart] => [frame, part])
    );
    if (parts.length > 1) frames.sort((a, b) => index.timestamps[a[0]] - index.timestamps[b[0]] || a[0] - b[0]);
    const multiplexors = new Map(
      parts.map((part) => [
        part,
        part.signal.multiplexValue === null ? undefined : part.message.signals.find((other) => other.isMultiplexor)
      ])
    );
    for (const [frame, part] of frames) {
      const signal = part.signal;
      const offset = frame * DATA_STRIDE;
      const length = index.dataLength[frame];
      const multiplexor = multiplexors.get(part);
      if (multiplexor) {
        const muxValue = extractRaw(multiplexor, index.data, offset, length);
        if (muxValue !== signal.multiplexValue) continue;
      }
      const timestamp = index.timestamps[frame];
      if (signal.valueTable !== null && !enumRaw) {
        const raw = extractRaw(signal, index.data, offset, length);
        if (raw === null) continue;
        const signedRaw = signal.signed && raw >= 2 ** (signal.length - 1) ? raw - 2 ** signal.length : raw;
        log.putString(key, timestamp, signal.valueTable.get(signedRaw) ?? signedRaw.toString());
      } else {
        const value = decodeSignal(signal, index.data, offset, length);
        if (value === null) continue;
        log.putNumber(key, timestamp, value);
      }
    }
  }

  function decodeUnknown(key: string) {
    const match = key.match(/^CAN\/Unknown\/0x([0-9A-F]+)$/);
    if (!match) return;
    const extended = match[1].length > 3;
    const frames = unknownFrames.get(messageKey(parseInt(match[1], 16), extended));
    if (frames === undefined) return;
    frames.forEach((frame) => {
      const offset = frame * DATA_STRIDE;
      log.putRaw(key, index.timestamps[frame], index.data.slice(offset, offset + index.dataLength[frame]));
    });
  }

  return { start, decode, getLog: () => log };
}
