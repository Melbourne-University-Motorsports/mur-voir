// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import test from "node:test";
import CarDynamicsController_Config from "../src/hub/controllers/CarDynamicsController_Config";
import {
  LineGraphController_DiscreteConfig,
  LineGraphController_NumericConfig
} from "../src/hub/controllers/LineGraphController_Config";
import TracksideController from "../src/hub/controllers/TracksideController";
import TracksideController_Config from "../src/hub/controllers/TracksideController_Config";
import { BUNDLED_DBCS } from "../src/hub/dataSources/can/BundledDBCs";
import { parseDBC } from "../src/hub/dataSources/can/DBC";
import { isLiveSentinel } from "../src/hub/dataSources/mur/LiveSentinels";
import { createField, writeValue } from "../src/hub/dataSources/mur/MURLogAdapter";
import SourceList from "../src/hub/SourceList";
import { DEFAULT_LAYOUTS, getDefaultLayout, isLayoutOpen } from "../src/shared/DefaultLayouts";
import { channelProfile, convertChannelValue } from "../src/shared/display/ChannelProfile";
import Log from "../src/shared/log/Log";
import LoggableType from "../src/shared/log/LoggableType";
import type { SignalDescriptor } from "../src/shared/mur/contract";
import { SourceListConfig, SourceListItemState } from "../src/shared/SourceListConfig";
import TabType from "../src/shared/TabType";
import { tileLabel, tileState } from "../src/shared/Trackside";

// The car Pi's logical buses (Wireless-telem config/telem.toml): 0 = Control, 1 = Telemetry.
const BUS_DBCS: { [bus: string]: string[] } = {
  "0": [
    "mur_control_can.dbc",
    "vendor/Cascadia_PM100DZ.dbc",
    "vendor/ENNOID_BMS.dbc",
    "vendor/Orion_BMS.dbc",
    "vendor/Valeo_OBC.dbc"
  ],
  "1": ["mur_telemetry_can.dbc", "vendor/SBG_Ellipse.dbc"]
};

function sources(controller: any): SourceListItemState[] {
  if (controller === null || typeof controller !== "object") return [];
  return [
    ...["sources", "leftSources", "rightSources", "discreteSources", "minimum", "maximum"].flatMap(
      (key) => controller[key] ?? []
    ),
    ...(controller.voltages?.sources ?? []),
    ...(controller.temperatures?.sources ?? [])
  ];
}

test("the default layout starts with the documentation tab and opens on Track day", () => {
  const layout = getDefaultLayout("default")!;
  assert.ok(layout);
  assert.equal(getDefaultLayout("nope"), undefined);
  assert.deepEqual(
    DEFAULT_LAYOUTS.map((l) => l.id),
    ["default"]
  );
  const tabs = layout.state.tabs.tabs;
  assert.equal(tabs[0].type, TabType.Documentation);
  assert.equal(tabs[layout.state.tabs.selected].title, "Track day");
  assert.deepEqual(
    tabs.slice(1).map((tab) => tab.title),
    [
      "Track day",
      "Cells",
      "Faults",
      "States",
      "HV voltage",
      "Accu temp and current",
      "Motor and torque",
      "Drive temps",
      "Pedals",
      "Car"
    ]
  );
});

test("every default layout field is a cellular path whose DBC signal exists on that bus", () => {
  const configs: { [type: number]: SourceListConfig } = {
    [TabType.Trackside]: TracksideController_Config,
    [TabType.LineGraph]: {
      ...LineGraphController_NumericConfig,
      types: [...LineGraphController_NumericConfig.types, ...LineGraphController_DiscreteConfig.types]
    },
    [TabType.CarDynamics]: CarDynamicsController_Config
  };
  const messagesByBus = Object.fromEntries(
    Object.entries(BUS_DBCS).map(([bus, files]) => [
      bus,
      files.flatMap((file) => parseDBC(BUNDLED_DBCS[file], file).messages)
    ])
  );
  let count = 0;
  for (const tab of getDefaultLayout("default")!.state.tabs.tabs) {
    for (const item of sources(tab.controller)) {
      count++;
      const match = item.logKey.match(/^\/vehicles\/mur27\/can([01])\/([a-z0-9_]+)\/([a-z0-9_]+)$/);
      assert.ok(match, item.logKey);
      const [, bus, message, signal] = match;
      assert.equal(signal, item.dbcSignal!.toLowerCase(), item.logKey);
      const dbcMessage = messagesByBus[bus].find((m) => m.name.toLowerCase() === message);
      assert.ok(dbcMessage, "no message for " + item.logKey);
      assert.ok(
        dbcMessage.signals.some((s) => s.name === item.dbcSignal),
        "no signal for " + item.logKey
      );
      const types = tab.type === TabType.Cells ? ["number"] : configs[tab.type]?.types.map((type) => type.key) ?? [];
      assert.ok(types.includes(item.type), `${tab.title}: ${item.type}`);
    }
  }
  assert.ok(count >= 90, String(count));
});

test("default layout limits belong to tiles in the same tab", () => {
  for (const tab of getDefaultLayout("default")!.state.tabs.tabs) {
    const limits = (tab.controller as any)?.limits ?? {};
    const keys = new Set(sources(tab.controller).map((item) => item.logKey));
    for (const key of Object.keys(limits)) assert.ok(keys.has(key), key);
  }
});

const sentinelDescriptor = (signal: string, message: string, unit: string): SignalDescriptor => ({
  path: `vehicles/mur27/can1/${message.toLowerCase()}/${signal.toLowerCase()}`,
  type: "float64",
  unit,
  description: signal,
  source: "test",
  nominal_rate_hz: 10,
  stale_after_ms: 3000,
  tags: [],
  schema_version: 1,
  dbc: { signal, message, database: "mur_telemetry_can.dbc" }
});

test("cellular sentinels are recognised in the SI unit the car sends", () => {
  const accu = sentinelDescriptor("ECU_AccuTempMax", "ECU_DashData", "K");
  assert.equal(isLiveSentinel(accu, 3276.7 + 273.15), true);
  assert.equal(isLiveSentinel(accu, 300), false);
  const motor = sentinelDescriptor("ECU_MotorTemp", "ECU_DashData2", "K");
  assert.equal(isLiveSentinel(motor, 215 + 273.15), true);
  assert.equal(isLiveSentinel(motor, 214 + 273.15), false);
  const speed = sentinelDescriptor("DASH_SpeedFL", "Dashboard_Speed", "m/s");
  assert.equal(isLiveSentinel(speed, 6553.5 / 3.6), true);
  assert.equal(isLiveSentinel(speed, 20), false);
  const noDbc = { ...accu, dbc: undefined };
  assert.equal(isLiveSentinel(noDbc, 3276.7 + 273.15), false);
});

test("a cellular sentinel sample is stored as a gap and shows as no reading without alarming", () => {
  const descriptor = sentinelDescriptor("ECU_AccuTempMax", "ECU_DashData", "K");
  const log = new Log();
  createField(log, descriptor);
  writeValue(log, descriptor, 1, 3276.7 + 273.15);
  writeValue(log, descriptor, 2, 310);
  const key = "/" + descriptor.path;
  const values = log.getNumber(key, 0, 3)!.values;
  assert.ok(Number.isNaN(values[0]));
  assert.equal(values[1], 310);

  const profile = channelProfile({ name: key, unit: "kelvin" });
  const tile = tileState(key, NaN, profile, { high: 60 });
  assert.equal(tile.text, "no reading");
  assert.equal(tile.unit, "");
  assert.equal(tile.severity, "ok");
  assert.equal(tileState(key, 340, profile, { high: 60 }).severity, "critical");
});

test("tiles are named by DBC signal, then source label, then path", () => {
  assert.equal(tileLabel(JSON.stringify({ dbcSignal: "ECU_AccuTempMax" }), "/a/ecu_accutempmax"), "ECU_AccuTempMax");
  assert.equal(tileLabel(JSON.stringify({ label: "Motor speed" }), "/a/motor_speed"), "Motor speed");
  assert.equal(tileLabel("", "/a/motor_speed"), "motor_speed");
  assert.equal(tileLabel("", "/a/ecu_accusoc", "ECU_AccuSOC"), "ECU_AccuSOC");
  const profile = channelProfile({ name: "x", unit: "volts" });
  assert.equal(
    tileState("/a/x", 4, profile, {}, null, undefined, "ENNOID_CellVoltageMin").label,
    "ENNOID_CellVoltageMin"
  );
});

test("a DBC fallback re-point reports the old and new keys, and Trackside limits follow it", () => {
  const log = new Log();
  log.createBlankField("ENNOID/ENNOID_CellVoltageMin", LoggableType.Number);
  log.setMetadataString("ENNOID/ENNOID_CellVoltageMin", JSON.stringify({ dbcSignal: "ENNOID_CellVoltageMin" }));
  (globalThis as any).window = { log, typeMemory: {} };
  const cellular = "/vehicles/mur27/can0/ennoid_summary/ennoid_cellvoltagemin";
  const list = Object.create(SourceList.prototype) as any;
  list.state = [
    {
      type: "tile",
      logKey: cellular,
      logType: "Number",
      dbcSignal: "ENNOID_CellVoltageMin",
      visible: true,
      options: {}
    }
  ];
  list.config = { types: [{ key: "tile", sourceTypes: ["Number"], options: [] }] };
  list.supplementalStateSuppliers = [];
  list.refreshLastFields = new Set();
  list.refreshLastStructTypes = {};
  list.LIST = { children: [{}], childElementCount: 1 };
  list.updateItem = () => {};
  list.updatePreview = () => {};

  const controller: TracksideController = Object.assign(Object.create(TracksideController.prototype), {
    limits: { [cellular]: { low: 2.5 } }
  });
  const moves: string[][] = [];
  list.onFieldRemapped = (from: string, to: string) => {
    moves.push([from, to]);
    controller.moveLimits(from, to);
  };
  list.refresh();
  assert.deepEqual(moves, [[cellular, "ENNOID/ENNOID_CellVoltageMin"]]);
  assert.deepEqual(controller.limits, { "ENNOID/ENNOID_CellVoltageMin": { low: 2.5 } });

  // A limit already set on the new key wins.
  controller.limits = { a: { low: 1 }, b: { low: 2 } };
  controller.moveLimits("a", "b");
  assert.deepEqual(controller.limits, { a: { low: 1 }, b: { low: 2 } });
});

test("the ?layout= link skips a layout whose tabs are already open, the menu always adds", () => {
  const layout = getDefaultLayout("default")!;
  const saved = layout.state.tabs.tabs.map(({ type, title }) => ({ type, title }));
  assert.equal(isLayoutOpen(layout, saved), true);
  assert.equal(isLayoutOpen(layout, [...saved, { type: TabType.LineGraph, title: "" }]), true);
  assert.equal(isLayoutOpen(layout, saved.slice(0, -1)), false);
  assert.equal(isLayoutOpen(layout, [{ type: TabType.Documentation, title: "" }]), false);
  // The hub saves a tab named after its type (the Cells tab) with the title "".
  const restored = saved.map((tab) => (tab.type === TabType.Cells ? { ...tab, title: "" } : tab));
  assert.ok(saved.some((tab) => tab.type === TabType.Cells && tab.title === "Cells"));
  assert.equal(isLayoutOpen(layout, restored), true);
});

test("live fields the publisher converted to SI display in their DBC unit, with limits in that unit", () => {
  const speed = sentinelDescriptor("DASH_SpeedCar", "Dashboard_Speed", "m/s");
  const rpm = { ...sentinelDescriptor("INV_MotorSpeedRPM", "INV_MotorPosition", "rad/s") };
  rpm.dbc = { signal: "INV_MotorSpeedRPM", message: "INV_MotorPosition", database: "Cascadia_PM100DZ.dbc" };
  const log = new Log();
  createField(log, speed);
  createField(log, rpm);
  const speedKey = "/" + speed.path;
  const speedProfile = log.getChannelProfile(speedKey);
  assert.equal(JSON.parse(log.getMetadataString(speedKey)).dbcUnit, "km/h");
  assert.equal(speedProfile.to, "kilometers/hour");
  assert.ok(Math.abs(convertChannelValue(50 / 3.6, speedProfile) - 50) < 1e-9);
  assert.equal(tileState(speedKey, 50 / 3.6, speedProfile, { high: 40 }).severity, "critical");
  assert.equal(tileState(speedKey, 50 / 3.6, speedProfile, { high: 60 }).severity, "ok");
  assert.equal(tileState(speedKey, 50 / 3.6, speedProfile).unit, speedProfile.unit);

  const rpmProfile = log.getChannelProfile("/" + rpm.path);
  assert.equal(rpmProfile.to, "rotations/minute");
  assert.ok(Math.abs(convertChannelValue((3000 * 2 * Math.PI) / 60, rpmProfile) - 3000) < 1e-6);

  // An MF4 field is already in the DBC unit, so the same limit means the same thing.
  const mf4 = channelProfile({ name: "DASHBOARD/DASH_SpeedCar", unit: "km/h" });
  assert.equal(tileState("DASH/DASH_SpeedCar", 50, mf4, { high: 40 }).severity, "critical");
  // Unconverted units (V) keep their own unit.
  const accu = sentinelDescriptor("ECU_AccuTempMax", "ECU_DashData", "K");
  createField(log, accu);
  assert.equal(log.getChannelProfile("/" + accu.path).to, "celsius");
});
