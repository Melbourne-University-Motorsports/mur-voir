// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BUNDLED_DBCS } from "../src/hub/dataSources/can/BundledDBCs";
import { parseDBC } from "../src/hub/dataSources/can/DBC";
import { classifyDBCFault, faultBits } from "../src/shared/DBCFault";
test("DBC enums distinguish faults, warnings, initialization and clear states", () => {
  const def = {
    name: "TTCS_IMDState",
    values: { 0: "Normal", 4: "Earth Fault", 5: "Ground Fault Warning", 255: "Invalid/Init" }
  };
  for (const [value, severity] of [
    [0, "ok"],
    [4, "critical"],
    [5, "warn"],
    [255, "unknown"],
    [9, "unknown"]
  ] as const)
    assert.equal(classifyDBCFault(def, value)?.severity, severity);
  assert.equal(classifyDBCFault(def, "Earth Fault")?.severity, "critical");
  assert.equal(classifyDBCFault({ name: "SBG_SolAidingFlags" }, 1), null);
});
test("DBC fault bits use comments when available", () => {
  const def = { name: "ECU_FaultFlags", comment: "bit 0: Motor; bit 1: Battery" };
  assert.equal(classifyDBCFault(def, 0)?.severity, "ok");
  const fault = classifyDBCFault(def, 3);
  assert.equal(fault?.severity, "critical");
  assert.equal(fault?.label, "Motor, Battery");
});

// mur-msgs v0.2.1 grammar, as in HB_TTCS_FaultBits: one bit per line, short name; full name; grade.
const graded = {
  name: "HB_TTCS_FaultBits",
  comment: [
    "Low 16 bits of the TTCS latched fault mask. Bits 0 to 2 mirror the MSS lines.",
    "bit 0: IMD trip; IMD fault, shutdown circuit opened; shutdown",
    "bit 3: HV overcurrent; HV overcurrent measured by the TTCS; shutdown",
    "bit 16: Cell imbalance; Cell voltage spread above the limit; warning",
    "bit 7: IMD no signal; No PWM edges from the IMD; warning"
  ].join("\n")
};

test("graded fault bits: shutdown is critical, warning-only is warn, names are the short names", () => {
  const shutdown = classifyDBCFault(graded, 2 ** 3 + 2 ** 16)!;
  assert.equal(shutdown.severity, "critical");
  assert.equal(shutdown.label, "HV overcurrent, Cell imbalance");
  assert.equal(
    shutdown.detail,
    "bit 3: HV overcurrent measured by the TTCS (shutdown)\nbit 16: Cell voltage spread above the limit (warning)"
  );
  const warning = classifyDBCFault(graded, 2 ** 16 + 2 ** 7)!;
  assert.equal(warning.severity, "warn");
  assert.equal(warning.label, "IMD no signal, Cell imbalance");
  assert.equal(classifyDBCFault(graded, 1)!.label, "IMD trip");
  assert.equal(classifyDBCFault(graded, 0)!.severity, "ok");
});

test("a set bit with no entry is appended as hex and counts as critical", () => {
  const unknown = classifyDBCFault(graded, 2 ** 16 + 0x40)!;
  assert.equal(unknown.label, "Cell imbalance, 0x40");
  assert.equal(unknown.severity, "critical");
  assert.equal(classifyDBCFault(graded, 0x40)!.label, "0x40");
  // Older ungraded entries stay critical.
  assert.equal(classifyDBCFault({ name: "ECU_FaultFlags", comment: "bit 2: Pump" }, 4)!.severity, "critical");
});

test("the bundled Cascadia and TTCS comments name and grade every documented bit", () => {
  const signals = Object.entries(BUNDLED_DBCS).flatMap(([path, text]) =>
    parseDBC(text, path).messages.flatMap((message) => message.signals)
  );
  const byte0 = signals.find((signal) => signal.name === "INV_FaultByte0")!;
  assert.equal(faultBits(byte0.comment).size, 8);
  assert.equal(
    classifyDBCFault({ name: "INV_FaultByte0", comment: byte0.comment }, 3)!.label,
    "HW gate/desat, HW overcurrent"
  );
  const ttcs = signals.find((signal) => signal.name === "HB_TTCS_FaultBits")!;
  assert.ok([...faultBits(ttcs.comment).values()].every((bit) => bit.grade !== null));
});

test("MUR_Fault names each node's bits under its own signal", () => {
  for (const path of ["mur_control_can.dbc", "mur_telemetry_can.dbc"]) {
    const message = parseDBC(BUNDLED_DBCS[path], path).messages.find((m) => m.name === "MUR_Fault")!;
    assert.ok(message.signals.find((signal) => signal.name === "FAULT_Node")!.isMultiplexor);
    const label = (name: string, value: number) => {
      const signal = message.signals.find((s) => s.name === name)!;
      return classifyDBCFault({ name, comment: signal.comment }, value);
    };
    // Bit 4 is a different fault on each node.
    assert.deepEqual(
      ["FAULT_Bitmask_TTCS", "FAULT_Bitmask_Pedalbox"].map((name) => label(name, 1 << 4)!.label),
      ["ENNOID comms lost", "APPS A out of range"]
    );
    assert.deepEqual(
      { ...label("FAULT_Bitmask_TTCS", 1 << 16), detail: undefined },
      { severity: "warn", label: "Cell imbalance", detail: undefined }
    );
    assert.equal(label("FAULT_Bitmask_TTCS", 1 << 17)!.severity, "critical");
  }
});

test("fault bytes and timeout flags are active when nonzero", () => {
  for (const name of ["INV_FaultByte0", "TELEM_TimeoutFlags", "FAULT_Bitmask", "HB_CHG_FaultBits"]) {
    assert.equal(classifyDBCFault({ name }, 1)?.severity, "critical");
    assert.equal(classifyDBCFault({ name }, 0)?.severity, "ok");
  }
});
