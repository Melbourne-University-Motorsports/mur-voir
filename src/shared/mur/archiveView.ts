// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// What the Download runs popup shows for each run, and its selection rules. No DOM, so it is testable.

import type { ArchiveFault, ArchiveRun, FaultSeverity } from "./archive";
import type { JobKind, JobState } from "./archiveJob";

export type RunFilter = "all" | "driving" | "parked";

export interface FaultGroup {
  name: string;
  fullName: string;
  severity: FaultSeverity;
  /** "HH:MM" local times of the activations listed, earliest first; "+M:SS" from the run start when undated. */
  times: string[];
  /** Total activations, which can exceed the times listed (the server lists the first 100). */
  count: number;
}

const SEVERITY_ORDER: Record<FaultSeverity, number> = { shutdown: 0, warning: 1 };

/** "HH:MM" from an RFC 3339 time with the car's local offset, without converting time zones. */
export function clock(time: string): string {
  const match = /T(\d{2}):(\d{2})/.exec(time);
  return match ? `${match[1]}:${match[2]}` : "--:--";
}

/** "+M:SS" (or "+H:MM:SS") from the start of the run, for faults in an undated run. */
export function offset(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours > 0 ? `+${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `+${minutes}:${secs}`;
}

/**
 * One group per distinct fault (signal and code), worst severity first, then by first activation, then
 * signal and code. The API already sends them that way; merging and sorting again keeps the popup right
 * if a server repeats an entry.
 */
export function groupFaults(faults: ArchiveFault[]): FaultGroup[] {
  const groups = new Map<string, { fault: ArchiveFault; times: string[]; atS: number[]; count: number }>();
  for (const fault of faults) {
    const key = `${fault.signal}\u0000${fault.code ?? ""}`;
    const group = groups.get(key);
    const count = fault.count ?? fault.times.length;
    if (group === undefined) {
      groups.set(key, { fault, times: [...fault.times], atS: [...(fault.at_s ?? [])], count });
    } else {
      group.times.push(...fault.times);
      group.atS.push(...(fault.at_s ?? []));
      group.count += count;
      if (SEVERITY_ORDER[fault.severity] < SEVERITY_ORDER[group.fault.severity]) group.fault = fault;
    }
  }
  return Array.from(groups.values())
    .map((group) => {
      const times = [...group.times].sort((a, b) => Date.parse(a) - Date.parse(b) || a.localeCompare(b));
      const atS = [...group.atS].sort((a, b) => a - b);
      const first = atS.length > 0 ? atS[0] : times.length > 0 ? Date.parse(times[0]) / 1000 : Infinity;
      return { ...group, times, atS, first };
    })
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.fault.severity] - SEVERITY_ORDER[b.fault.severity] ||
        a.first - b.first ||
        a.fault.signal.localeCompare(b.fault.signal) ||
        (a.fault.code ?? -1) - (b.fault.code ?? -1)
    )
    .map((group) => ({
      name: group.fault.name,
      fullName: group.fault.full_name,
      severity: group.fault.severity,
      times: group.times.length > 0 ? group.times.map(clock) : group.atS.map(offset),
      count: Math.max(group.count, group.times.length, group.atS.length, 1)
    }));
}

/** What the fault column shows: two groups at most, with a count of the rest on the second line. */
export function faultColumn(groups: FaultGroup[]): { lines: FaultGroup[]; more: number } {
  return { lines: groups.slice(0, 2), more: Math.max(0, groups.length - 2) };
}

/** One group as a column entry: first time, short name and ×N for repeats. */
export function faultLineText(group: FaultGroup): { at: string; label: string } {
  return { at: group.times[0] ?? "", label: group.name + (group.count > 1 ? ` ×${group.count}` : "") };
}

/** Every listed time for the hover text and the footer, noting activations past the listed ones. */
export function faultTimesText(group: FaultGroup): string {
  const extra = group.count - group.times.length;
  return group.times.join(", ") + (extra > 0 ? ` and ${extra} more` : "");
}

/** The full list for the hover text and the footer: every time, then the full name. */
export function faultListText(groups: FaultGroup[]): string {
  return groups.map((group) => `${faultTimesText(group)}  ${group.fullName}`).join("\n");
}

/** "Driving at Test track", "Parked at Test track pits", or null before the summary is built. */
export function runActivityText(run: ArchiveRun): string | null {
  if (run.summary === null) return null;
  const verb = run.summary.activity === "parked" ? "Parked" : "Driving";
  return run.summary.place ? `${verb} at ${run.summary.place}` : verb;
}

function minutes(seconds: number): number {
  return Math.max(0, Math.round(seconds / 60));
}

/**
 * The status after the activity on line one. Recording runs are live. A run that ended with a power
 * off while parts were still on the car waits for the car to power on again; any other unfinished
 * upload is still arriving. A power off the server inferred (`end_inferred`) reads like any other.
 * A complete run the logger marked incomplete says so in plain text: it isn't a fault.
 */
export function runStatus(
  run: ArchiveRun
): { kind: "live" | "uploading" | "on-car" | "incomplete"; text: string } | null {
  if (run.state === "recording") return { kind: "live", text: "Live now" };
  if (run.state === "complete")
    return run.end === "incomplete" ? { kind: "incomplete", text: "End may be missing" } : null;
  if (run.end === "power_off" && run.on_car_s !== null && run.on_car_s > 0) {
    return { kind: "on-car", text: `Last ${Math.max(1, minutes(run.on_car_s))} min still on the car` };
  }
  if (run.on_car_s === null) return { kind: "uploading", text: "Uploading" };
  const total = minutes(run.duration_s);
  return { kind: "uploading", text: `Uploading, ${minutes(run.duration_s - run.on_car_s)} of ${total} min in` };
}

function formatDistance(meters: number): string {
  const km = meters / 1000;
  return (km < 100 ? km.toFixed(1) : Math.round(km).toString()) + " km";
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  return `${minutes(seconds)} min`;
}

/** Line two: distance, top speed and SoC; parked runs show SoC and tractive system time. */
export function runNumbersText(run: ArchiveRun): string {
  const summary = run.summary;
  if (summary === null) return "";
  const parts: string[] = [];
  if (summary.activity === "driving") {
    if (summary.distance_m !== null) parts.push(formatDistance(summary.distance_m));
    if (summary.top_speed_kmh !== null) parts.push(`${Math.round(summary.top_speed_kmh)} km/h top`);
  }
  if (summary.soc_start_pct !== null && summary.soc_end_pct !== null) {
    parts.push(`SoC ${Math.round(summary.soc_start_pct)}→${Math.round(summary.soc_end_pct)}%`);
  } else if (summary.soc_start_pct !== null || summary.soc_end_pct !== null) {
    parts.push(`SoC ${Math.round((summary.soc_start_pct ?? summary.soc_end_pct)!)}%`);
  }
  if (summary.activity === "parked" && summary.ts_on_s !== null) {
    parts.push(summary.ts_on_s > 0 ? `tractive system on ${formatDuration(summary.ts_on_s)}` : "tractive system off");
  }
  return parts.join(" · ");
}

export function runLengthText(run: ArchiveRun): string {
  return formatDuration(run.duration_s) + (run.state === "recording" ? "+" : "");
}

export function sizeText(bytes: number): string {
  if (bytes < 1e5) return "<0.1 MB";
  const mb = bytes / 1e6;
  return (mb < 10 ? mb.toFixed(1) : Math.round(mb).toString()) + " MB";
}

/** "YYYY-MM-DD" in the car's local time, or null for undated runs. */
export function runDay(run: ArchiveRun): string | null {
  const match = run.start === null ? null : /^(\d{4}-\d{2}-\d{2})T/.exec(run.start);
  return match ? match[1] : null;
}

export function runClock(run: ArchiveRun): string {
  return run.start === null ? "--:--" : clock(run.start);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue 17 Nov", with the year when it differs from `today`'s. */
function shortDay(day: string, today: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, date)).getUTCDay()];
  return `${weekday} ${date} ${MONTHS[month - 1]}` + (day.slice(0, 4) !== today.slice(0, 4) ? ` ${year}` : "");
}

/** Day header: "Today, Tue 17 Nov", "Sat 14 Nov", or "Not dated". */
export function dayHeading(day: string | null, today: string): string {
  if (day === null) return "Not dated";
  return day === today ? `Today, ${shortDay(day, today)}` : shortDay(day, today);
}

/** Short label for the footer and dialogs: "Today 13:20", "Sat 14 Nov 14:02", or the run name. */
export function runLabel(run: ArchiveRun, today: string): string {
  const day = runDay(run);
  if (day === null) return run.name;
  return (day === today ? "Today" : shortDay(day, today)) + " " + runClock(run);
}

/** Today's date as "YYYY-MM-DD" in the given IANA zone (the car's), falling back to local time. */
export function todayIn(timeZone = "Australia/Melbourne", now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      now
    );
  } catch {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }
}

export function matchesFilter(run: ArchiveRun, filter: RunFilter): boolean {
  return filter === "all" || run.summary?.activity === filter;
}

/** Runs grouped by day in the order given (newest first), undated runs last. */
export function groupByDay(runs: ArchiveRun[]): { day: string | null; runs: ArchiveRun[] }[] {
  const groups: { day: string | null; runs: ArchiveRun[] }[] = [];
  const undated: ArchiveRun[] = [];
  for (const run of runs) {
    const day = runDay(run);
    if (day === null) {
      undated.push(run);
      continue;
    }
    const last = groups[groups.length - 1];
    if (last !== undefined && last.day === day) last.runs.push(run);
    else groups.push({ day, runs: [run] });
  }
  if (undated.length > 0) groups.push({ day: null, runs: undated });
  return groups;
}

/** Merges a fresh first page into the loaded list: updates known runs, adds new ones, keeps older pages. */
export function mergeRuns(loaded: ArchiveRun[], fresh: ArchiveRun[]): ArchiveRun[] {
  const freshNames = new Set(fresh.map((run) => run.name));
  return [...fresh, ...loaded.filter((run) => !freshNames.has(run.name))];
}

// Selection

export interface SelectionState {
  /** Ticked run names in the order they were ticked. */
  selected: string[];
  /** A transfer is running; ticks are locked until it ends. */
  busy: boolean;
  /** The run the hub has open, if any. */
  openRun: string | null;
  /** Listed run names, newest first, so Open can pick the most recent ticked run. */
  order?: string[];
}

export function toggleRun(state: SelectionState, name: string): string[] {
  if (state.busy) return state.selected;
  return state.selected.includes(name) ? state.selected.filter((x) => x !== name) : [...state.selected, name];
}

/** Ticks or unticks a set (a day): all ticked becomes none, otherwise all. */
export function toggleRuns(state: SelectionState, names: string[]): string[] {
  if (state.busy) return state.selected;
  const all = names.every((name) => state.selected.includes(name));
  return all
    ? state.selected.filter((name) => !names.includes(name))
    : [...state.selected, ...names.filter((name) => !state.selected.includes(name))];
}

/** Drops ticks for runs no longer listed (pruned or filtered out by the server). */
export function pruneSelection(selected: string[], runs: ArchiveRun[]): string[] {
  const names = new Set(runs.map((run) => run.name));
  return selected.filter((name) => names.has(name));
}

export interface SelectionActions {
  download: boolean;
  open: boolean;
  /** The ticked run is the open one: Open reads "Showing". */
  showing: boolean;
  copyLink: boolean;
  /** The one ticked run, when exactly one is ticked. */
  single: string | null;
  /** The run Open acts on: the ticked run, or the most recent of several. */
  target: string | null;
}

/** The ticked run Open acts on: with several ticked, the most recent (first in the newest-first list). */
export function openTarget(selected: string[], order: string[]): string | null {
  if (selected.length <= 1) return selected[0] ?? null;
  const ticked = new Set(selected);
  return order.find((name) => ticked.has(name)) ?? selected[0];
}

/** Download takes any number of runs; Open takes the most recent ticked run; Copy link needs exactly one. */
export function selectionActions(state: SelectionState): SelectionActions {
  const single = state.selected.length === 1 ? state.selected[0] : null;
  const target = openTarget(state.selected, state.order ?? state.selected);
  const showing = target !== null && target === state.openRun;
  return {
    download: state.selected.length > 0 && !state.busy,
    open: target !== null && !state.busy && !showing,
    showing,
    copyLink: single !== null,
    single,
    target
  };
}

/**
 * After a failure, Download or Open resumes the failed job only while it would fetch the same runs.
 * Ticking different runs makes the button start a new job instead.
 */
export function resumesJob(
  job: Pick<JobState, "kind" | "phase" | "names"> | null,
  kind: JobKind,
  names: string[]
): boolean {
  if (job === null || job.phase !== "failed" || job.kind !== kind || job.names.length !== names.length) return false;
  const wanted = new Set(names);
  return job.names.every((name) => wanted.has(name));
}

export type OpenChoice = "replace" | "newTab" | "cancel";

/**
 * Opening replaces the current log. With live telemetry connected the app asks first: Lite can also
 * open the run in a new browser tab, the desktop app can only stop live or cancel.
 */
export function openChoices(liveConnected: boolean, isLite: boolean): OpenChoice[] | null {
  if (!liveConnected) return null;
  return isLite ? ["cancel", "replace", "newTab"] : ["cancel", "replace"];
}
