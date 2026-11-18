// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createField } from "../../src/hub/dataSources/mur/MURLogAdapter";
import { classifyDBCFault } from "../../src/shared/DBCFault";
import Log from "../../src/shared/log/Log";
import type { SignalDescriptor } from "../../src/shared/mur/contract";

const descriptor: SignalDescriptor = {
  path: "vehicles/mur27/powertrain/inverter/motor_speed",
  type: "float64",
  unit: "rad/s",
  description: "Motor shaft speed",
  source: "control-can",
  nominal_rate_hz: 100,
  stale_after_ms: 250,
  tags: [],
  schema_version: 1
};

test("live fields preserve the DBC signal name for saved layout lookup", () => {
  const log = new Log();
  createField(log, { ...descriptor, dbc: { signal: "INV_MotorSpeedRPM", message: "INV_Motor_Position_Info" } });
  const metadata = JSON.parse(log.getMetadataString("/" + descriptor.path)!);
  assert.equal(metadata.dbcSignal, "INV_MotorSpeedRPM");
  assert.equal(metadata.unit, "rad/s");
});

test("live fields without a DBC signal omit dbcSignal", () => {
  for (const dbc of [undefined, { signal: "", message: "INV_Motor_Position_Info" }]) {
    const log = new Log();
    createField(log, { ...descriptor, dbc });
    assert.equal(Object.hasOwn(JSON.parse(log.getMetadataString("/" + descriptor.path)!), "dbcSignal"), false);
  }
});

test("live fault fields carry the bundled DBC comment, so fault tiles name their bits", () => {
  const fault = (path: string, signal: string, message: string, database: string): SignalDescriptor => ({
    ...descriptor,
    path,
    type: "int64",
    unit: null,
    dbc: { signal, message, database }
  });
  const log = new Log();
  const inverter = fault(
    "vehicles/mur27/can0/inv_faultcodes/inv_faultbyte0",
    "INV_FaultByte0",
    "INV_FaultCodes",
    "Cascadia_PM100DZ.dbc"
  );
  const ttcs = fault(
    "vehicles/mur27/can0/mur_hb_ttcs/hb_ttcs_faultbits",
    "HB_TTCS_FaultBits",
    "MUR_HB_TTCS",
    "mur_control_can.dbc"
  );
  createField(log, inverter);
  createField(log, ttcs);
  const inverterMeta = JSON.parse(log.getMetadataString("/" + inverter.path));
  const ttcsMeta = JSON.parse(log.getMetadataString("/" + ttcs.path));
  assert.match(inverterMeta.comment, /bit 0: HW gate\/desat;/);
  assert.match(ttcsMeta.comment, /bit 3: HV overcurrent;.*; shutdown/);
  assert.equal(
    classifyDBCFault({ name: "INV_FaultByte0", comment: inverterMeta.comment }, 0x41)?.label,
    "HW gate/desat, " + classifyDBCFault({ name: "INV_FaultByte0", comment: inverterMeta.comment }, 0x40)?.label
  );
  // A field with no DBC signal gets no comment.
  createField(log, { ...descriptor, path: "vehicles/mur27/system/cpu_load" });
  assert.equal(Object.hasOwn(JSON.parse(log.getMetadataString("/vehicles/mur27/system/cpu_load")), "comment"), false);
});
