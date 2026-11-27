// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { alertLine, dbcDefinition, isTracksideLive, Limits, tileLabel, tileState } from "../shared/Trackside";
import { setHidden, setText } from "../shared/domWrite";
import { isMobileLayout } from "./MobileLayout";

export type TracksideAlertSource = { key: string; dbcSignal?: string; low?: number; high?: number };

type AlertItem = Parameters<typeof alertLine>[0][number];
type Entry = {
  key: string;
  label: string;
  profile: AlertItem["profile"];
  limits?: Limits;
  definition: ReturnType<typeof dbcDefinition>;
  field: ReturnType<typeof window.log.getField>;
  time?: number;
  version?: number;
  discard?: number;
  value?: unknown;
  item?: AlertItem;
};

let cache:
  | {
      log: typeof window.log;
      fields: number;
      metadata: number;
      configs: TracksideAlertSource[][];
      entries: Entry[];
      result?: ReturnType<typeof alertLine>;
    }
  | undefined;

let lastMobileState: string | null = null;

function alertEntries(configs: TracksideAlertSource[][]) {
  const log = window.log;
  const fields = log.getFieldKeysVersion();
  const metadata = log.getMetadataVersion();
  if (
    cache?.log === log &&
    cache.fields === fields &&
    cache.metadata === metadata &&
    cache.configs.length === configs.length &&
    cache.configs.every((config, i) => config === configs[i])
  ) {
    return cache;
  }
  const signals = new Map<string, string>();
  const limits: (TracksideAlertSource & Limits)[] = [];
  for (const config of configs) {
    // A tab keeps one set of limits per field, so a field in several of its tiles alerts once
    const limited = new Set<string>();
    for (const source of config) {
      if (source.dbcSignal) signals.set(source.key, source.dbcSignal);
      if ((source.low !== undefined || source.high !== undefined) && !limited.has(source.key)) {
        limited.add(source.key);
        limits.push(source);
      }
    }
  }
  const entries: Entry[] = [];
  const add = (key: string, definition: Entry["definition"], limits?: Limits) => {
    entries.push({
      key,
      label: tileLabel(log.getMetadataString(key), key, signals.get(key)),
      profile: log.getChannelProfile(key),
      definition,
      limits,
      field: log.getField(key)
    });
  };
  for (const key of log.getFieldKeys()) {
    const definition = dbcDefinition(log.getMetadataString(key), key);
    if (definition) add(key, definition);
  }
  for (const { key, low, high } of limits) add(key, null, { low, high });
  return (cache = { log, fields, metadata, configs, entries });
}

export function updateTracksideAlerts(element: HTMLElement, configs: TracksideAlertSource[][]) {
  const liveTime = window.selection.getCurrentLiveTime();
  const time = liveTime ?? window.selection.getRenderTime() ?? window.log.getTimestampRange()[1];
  const provider = window.liveStatus;
  const summary = provider?.getLiveStatus();
  const live = isTracksideLive(summary, liveTime);
  const state = alertEntries(configs);
  let changed = state.result === undefined;
  for (const entry of state.entries) {
    const { field, key, limits, profile, definition, label } = entry;
    if (
      live &&
      (summary.backend !== "connected" || !summary.hasFreshData || provider!.getFieldFreshness(key) !== "online")
    ) {
      if (entry.item !== undefined) {
        entry.item = undefined;
        changed = true;
      }
      continue;
    }
    const sampleTime = Math.min(time, field?.getTimestamp(field.getTimestampCount() - 1) ?? -Infinity);
    const version = field?.getDataVersion();
    const discard = field?.getDiscardVersion();
    if (entry.time !== sampleTime || entry.version !== version || entry.discard !== discard) {
      const range = field?.getRange(time, time);
      const value = range && range.timestamps[0] <= time ? range.values[0] : undefined;
      if (!Object.is(entry.value, value)) entry.item = undefined;
      entry.value = value;
      entry.time = sampleTime;
      entry.version = version;
      entry.discard = discard;
    }
    if (entry.item === undefined) {
      const value = entry.value;
      entry.item = {
        tile: tileState(key, value, profile, limits, definition, undefined, label),
        value,
        profile,
        limits,
        fault: definition !== null
      };
      changed = true;
    }
  }

  const mobile = isMobileLayout();
  if (!mobile) {
    if (lastMobileState !== null) {
      lastMobileState = null;
      changed = true;
      element.classList?.remove?.("mobile-alerts-expanded");
    }
    if (!changed) return;
    const result = (state.result = alertLine(state.entries.flatMap(({ item }) => (item ? [item] : []))));
    setHidden(element, !result.text);
    setText(element, result.text);
    const title = result.detail ? result.text + "\n" + result.detail : result.text;
    if (element.title !== title) element.title = title;
    if (element.dataset.severity !== result.severity) element.dataset.severity = result.severity;
    const active = !!result.text;
    if (document.body.classList.contains("has-trackside-alerts") !== active) {
      document.body.classList.toggle("has-trackside-alerts", active);
    }
    return;
  }

  const result = changed
    ? (state.result = alertLine(state.entries.flatMap(({ item }) => (item ? [item] : []))))
    : state.result!;
  let hidden = true;
  let severity = "ok";
  let mainText = "";
  let detailText = "";
  if (result.text) {
    hidden = false;
    severity = result.severity;
    mainText = result.text;
    detailText = result.detail ?? "";
  } else if (summary?.backend === "connected" && !summary.hasFreshData) {
    hidden = false;
    severity = "muted";
    mainText = "Base connected, no car data";
  } else if (state.entries.length > 0 || window.log.getFieldKeys().length > 0) {
    hidden = false;
    severity = "ok";
    mainText = "All clear — 0 active faults";
  }

  const mobileKey = JSON.stringify([hidden, severity, mainText, detailText]);
  if (!changed && lastMobileState === mobileKey) return;
  lastMobileState = mobileKey;

  setHidden(element, hidden);
  if (element.dataset.severity !== severity) element.dataset.severity = severity;
  const title = detailText ? mainText + "\n" + detailText : mainText;
  if (element.title !== title) element.title = title;

  if (detailText) {
    element.classList?.toggle?.("has-detail", true);
    const summaryEl = document.createElement("div");
    summaryEl.className = "trackside-alerts-summary";
    summaryEl.textContent = mainText;
    const detailEl = document.createElement("div");
    detailEl.className = "trackside-alerts-detail";
    detailEl.textContent = detailText;
    element.replaceChildren(summaryEl, detailEl);
  } else {
    element.classList?.remove?.("has-detail", "mobile-alerts-expanded");
    setText(element, mainText);
  }

  const active = !hidden;
  if (document.body.classList.contains("has-trackside-alerts") !== active) {
    document.body.classList.toggle("has-trackside-alerts", active);
  }
}
