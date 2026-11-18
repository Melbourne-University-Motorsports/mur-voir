// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// Generated from mur-msgs d0f1b5f927a72ce3615eb4e7081095c32db1c34d. Do not edit.
// Run npm run archive-api:generate.

/**
 * Dated (Melbourne local time), legacy, or undated pending name. Stable: a listed run is never renamed.
 */
export type RunName = string;
/**
 * RFC 3339, whole seconds, Australia/Melbourne offset (+10:00 or +11:00).
 */
export type StartTime = string;
/**
 * RFC 3339, up to millisecond precision, Australia/Melbourne offset (+10:00 or +11:00).
 */
export type EventTime = string;
export type Seconds = number;
export type NullableNonNegative = number | null;
export type Percent = number | null;
export type RunState = "recording" | "uploading" | "complete";
export type RunEnd = ("power_off" | "clean_stop") | null;
export type Severity = "shutdown" | "warning";
export type Run = {
  [k: string]: unknown;
} & {
  name: RunName;
  start: StartTime | null;
  dated: boolean;
  duration_s: Seconds;
  state: RunState;
  end: RunEnd;
  on_car_s: NullableNonNegative;
  size_bytes: number;
  summary: Summary | null;
  [k: string]: unknown;
};

/**
 * MUR run archive API v1 shapes. See README for semantic requirements.
 */
export interface ArchiveAPIExports {
  RunName?: RunName;
  StartTime?: StartTime;
  EventTime?: EventTime;
  Seconds?: Seconds;
  NullableNonNegative?: NullableNonNegative;
  Percent?: Percent;
  RunState?: RunState;
  RunEnd?: RunEnd;
  Severity?: Severity;
  Fault?: Fault;
  Summary?: Summary;
  Run?: Run;
  RunList?: RunList;
  Preparing?: Preparing;
  Error?: Error;
  [k: string]: unknown;
}
export interface Fault {
  /**
   * DBC signal name, e.g. HB_TTCS_FaultBits.
   */
  signal: string;
  /**
   * Bit index (LSB = 0) or raw enum value within the signal.
   */
  code: number | null;
  name: string;
  full_name: string;
  severity: Severity;
  /**
   * Wall-clock time of each activation, oldest first. Empty when the run's start is null.
   *
   * @maxItems 100
   */
  times: EventTime[];
  /**
   * Seconds from the start of the run to each activation, oldest first.
   *
   * @minItems 1
   * @maxItems 100
   */
  at_s: [Seconds, ...Seconds[]];
  /**
   * Total activations in covers_s; at_s and times hold the first 100.
   */
  count: number;
  [k: string]: unknown;
}
export interface Summary {
  covers_s: Seconds;
  activity: "driving" | "parked";
  place: string | null;
  distance_m: NullableNonNegative;
  top_speed_kmh: NullableNonNegative;
  soc_start_pct: Percent;
  soc_end_pct: Percent;
  ts_on_s: NullableNonNegative;
  faults: Fault[];
  [k: string]: unknown;
}
export interface RunList {
  version: 1;
  runs: Run[];
  next: RunName | null;
  [k: string]: unknown;
}
export interface Preparing {
  state: "preparing";
  [k: string]: unknown;
}
export interface Error {
  /**
   * Machine-readable code. Clients must tolerate codes they do not know.
   */
  error: string;
  message: string;
  [k: string]: unknown;
}
