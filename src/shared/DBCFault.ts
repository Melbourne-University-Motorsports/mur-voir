// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

export type Severity = "ok" | "warn" | "critical";

export interface DBCFaultDefinition {
  name: string;
  values?: Record<string, string>;
  comment?: string;
}
/** Only call for signals with DBC provenance. Ordinary aiding/status flags are not faults. */
export function classifyDBCFault(
  def: DBCFaultDefinition,
  value: unknown
): { severity: Severity | "unknown"; label: string; detail?: string } | null {
  const bitmask = /fault.*(?:bits?|bytes?|mask|flags)|(?:fault|error|timeout)flags|^FAULT_Bitmask$/i.test(def.name);
  const labels = Object.values(def.values ?? {});
  if (!bitmask && !labels.some((label) => /fault|error|fail|warning|degraded/i.test(label))) return null;
  const label = def.values?.[String(value)] ?? String(value);
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value)))
    return { severity: "unknown", label: "NO DATA" };
  if (bitmask) {
    const active = Number(value);
    if (active === 0) return { severity: "ok", label: "0x0" };
    const entries = faultBits(def.comment ?? "");
    const set = [...entries.values()]
      .filter((entry) => Math.floor(active / 2 ** entry.bit) % 2 === 1)
      .sort((a, b) => a.bit - b.bit);
    // Set bits with no entry stay visible as hex, and count as critical.
    let unknown = active;
    set.forEach((entry) => (unknown -= 2 ** entry.bit));
    const names = set.map((entry) => entry.name);
    if (unknown > 0) names.push(`0x${unknown.toString(16)}`);
    const critical = unknown > 0 || set.some((entry) => entry.grade !== "warning");
    return {
      severity: critical ? "critical" : "warn",
      label: names.join(", "),
      detail: [
        ...set.map((entry) => `bit ${entry.bit}: ${entry.full}${entry.grade ? ` (${entry.grade})` : ""}`),
        ...(unknown > 0 ? [`0x${unknown.toString(16)}: no name in the DBC`] : [])
      ].join("\n")
    };
  }
  if (/invalid|init|unknown/i.test(label) || !labels.includes(label)) return { severity: "unknown", label };
  // Warning takes precedence for labels such as "Ground Fault Warning".
  return {
    severity: /warning|degraded/i.test(label) ? "warn" : /fault|error|fail/i.test(label) ? "critical" : "ok",
    label
  };
}

export type FaultBit = { bit: number; name: string; full: string; grade: "shutdown" | "warning" | null };

/**
 * Fault bits named in a DBC comment, by bit number (first entry wins). mur-msgs v0.2.1 writes one
 * per line, `bit N: short name; full name; shutdown|warning`; older comments write `bit N: name`
 * (or `N: name`, comma separated), which reads as an ungraded entry.
 */
export function faultBits(comment: string): Map<number, FaultBit> {
  const bits = new Map<number, FaultBit>();
  for (const match of comment.matchAll(
    /(?:bit\s*)?(\d+)\s*[:=]\s*([^,;\n]+)((?:;(?!\s*(?:bit\s*)?\d+\s*[:=])[^;\n]*){0,2})/gi
  )) {
    const bit = Number(match[1]);
    if (bits.has(bit) || bit > 52) continue;
    const name = match[2].trim().replace(/"$/, "");
    const rest = match[3]
      .split(";")
      .slice(1)
      .map((part) => part.trim().replace(/"$/, "").trim());
    const grade =
      rest.length > 0 && /^(shutdown|warning)$/i.test(rest[rest.length - 1]) ? rest.pop()!.toLowerCase() : null;
    bits.set(bit, { bit, name, full: rest[0] || name, grade: grade as FaultBit["grade"] });
  }
  return bits;
}
