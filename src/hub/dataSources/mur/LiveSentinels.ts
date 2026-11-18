// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import type { SignalDescriptor } from "../../../shared/mur/contract";
import { BUNDLED_DBCS } from "../can/BundledDBCs";
import { DBCSignal, parseDBC } from "../can/DBC";

/**
 * The car's cellular publisher converts each DBC value to SI before sending it. This is its table
 * (Wireless-telem services/telem/src/telem/cellular.py, UNITS): DBC unit -> [multiplier, offset].
 * Units not listed are sent unchanged.
 */
const PUBLISHER_UNITS: { [unit: string]: [number, number] } = {
  "%": [0.01, 0],
  degC: [1, 273.15],
  deg: [Math.PI / 180, 0],
  rpm: [(2 * Math.PI) / 60, 0],
  "km/h": [1 / 3.6, 0],
  mV: [0.001, 0],
  mm: [0.001, 0],
  ms: [0.001, 0],
  us: [1e-6, 0],
  kHz: [1000, 0],
  kOhm: [1000, 0],
  kW: [1000, 0],
  psi: [6894.757293168, 0],
  raw: [1, 0]
};

type Sentinel = { value: number; tolerance: number };

let signalsByName: Map<string, { signal: DBCSignal; source: string; message: string }[]> | null = null;
const cache = new WeakMap<SignalDescriptor, Sentinel[]>();

function bundledSignals() {
  if (signalsByName !== null) return signalsByName;
  signalsByName = new Map();
  for (const [path, text] of Object.entries(BUNDLED_DBCS)) {
    for (const message of parseDBC(text, path).messages) {
      for (const signal of message.signals) {
        const list = signalsByName.get(signal.name) ?? [];
        list.push({ signal, source: path.split("/").pop()!, message: message.name });
        signalsByName.set(signal.name, list);
      }
    }
  }
  return signalsByName;
}

/** The bundled DBC signal a live descriptor came from, preferring its own database and message. */
function bundledSignal(descriptor: SignalDescriptor): DBCSignal | undefined {
  const dbc = descriptor.dbc;
  if (!dbc?.signal) return undefined;
  const candidates = bundledSignals().get(dbc.signal) ?? [];
  return (
    candidates.find((c) => c.source === dbc.database && c.message === dbc.message) ??
    candidates.find((c) => c.message === dbc.message) ??
    candidates[0]
  )?.signal;
}

/**
 * The values a live numeric field takes when its DBC signal reports "no reading" (for example
 * ECU_AccuTempMax's raw 0x7FFF, 3276.7 °C, sent as 3549.85 K), in the units the descriptor uses.
 * Uses the bundled DBCs, the same ones the MF4 importer uses to turn sentinels into gaps.
 */
export function liveSentinels(descriptor: SignalDescriptor): Sentinel[] {
  const cached = cache.get(descriptor);
  if (cached !== undefined) return cached;
  let sentinels: Sentinel[] = [];
  if (descriptor.type === "float64") {
    const signal = bundledSignal(descriptor);
    if (signal !== undefined) {
      const [multiplier, offset] = PUBLISHER_UNITS[signal.unit] ?? [1, 0];
      sentinels = [...signal.sentinels].map((raw) => {
        const signed = signal.signed && raw >= 2 ** (signal.length - 1) ? raw - 2 ** signal.length : raw;
        const physical = signed * signal.factor + signal.offset;
        return {
          value: physical * multiplier + offset,
          tolerance: Math.abs(signal.factor * multiplier) * 0.5
        };
      });
    }
  }
  cache.set(descriptor, sentinels);
  return sentinels;
}

/**
 * The DBC unit of a live field whose value the publisher converted to SI, e.g. "km/h" for a field
 * sent in m/s. Null when the field has no DBC signal or was sent unconverted.
 */
export function liveDbcUnit(descriptor: SignalDescriptor): string | null {
  const signal = bundledSignal(descriptor);
  if (signal === undefined || !(signal.unit in PUBLISHER_UNITS) || signal.unit === "raw") return null;
  return signal.unit;
}

/** True if a live numeric sample is its signal's "no reading" value. */
export function isLiveSentinel(descriptor: SignalDescriptor, value: number): boolean {
  return liveSentinels(descriptor).some((sentinel) => Math.abs(value - sentinel.value) <= sentinel.tolerance);
}
