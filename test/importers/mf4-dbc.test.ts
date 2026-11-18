// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// MF4 runs that carry their DBC snapshots (bus<id>_<name>.dbc attachments) decode with them.
// Fixtures: tools/mf4/generate_dbc_snapshots.py.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";
import { BUNDLED_DBCS } from "../../src/hub/dataSources/can/BundledDBCs";
import { CandumpIndex, DATA_STRIDE } from "../../src/hub/dataSources/can/Candump";
import { createCandumpImporter } from "../../src/hub/dataSources/can/CandumpImporter";
import { MDF } from "../../src/hub/dataSources/mf4/MDF";
import { busDBCsFromAttachments, createMDFImporter } from "../../src/hub/dataSources/mf4/MDFImporter";

const fixture = (name: string) => new Uint8Array(fs.readFileSync("test/fixtures/mf4/" + name));
const PEDAL = "PEDALBOX/PEDAL_Position1";
// Rear_Dynamics is REAR's in the control DBC and ECU's in the telemetry one; the bundled set keys it
// REAR, and so must a run whose bus 1 snapshot is the telemetry DBC.
const SHOCK = "REAR/REAR_ShockPotRearLeft";

function open(name: string, dbcPack: Uint8Array | null = null) {
  const importer = createMDFImporter();
  const log = importer.start([fixture(name), null, null, dbcPack]);
  importer.decode([PEDAL, SHOCK]);
  const values = (key: string) => log.getNumber(key, -1, 10)!.values.map((v) => Math.round(v * 1000) / 1000);
  const meta = JSON.parse(log.getString("Metadata/Import", -Infinity, Infinity)!.values[0]);
  return { log, values, meta };
}

test("the reader returns embedded attachments, compressed or not, and skips external references", () => {
  const attached = new MDF(fixture("dbc-attached.mf4"));
  assert.deepEqual(
    attached.attachments.map((a) => a.fileName),
    ["bus0_mur_control_can.dbc", "bus1_mur_telemetry_can.dbc"]
  );
  assert.match(new TextDecoder().decode(attached.attachments[0].data), /PEDAL_Position1 : 0\|10@1\+ \(0\.2,0\)/);
  // Bus 1's snapshot is the telemetry DBC as bundled when the fixture was made, before #20 updated it:
  // an old run's DBC. Its hash checks the uncompressed attachment comes back byte for byte.
  assert.equal(
    createHash("sha256").update(attached.attachments[1].data).digest("hex"),
    "7fa6951fa0b21623854f2864a7bc188efd4e0dd1a5362f465f07b2970ea43799"
  );
  assert.notEqual(new TextDecoder().decode(attached.attachments[1].data), BUNDLED_DBCS["mur_telemetry_can.dbc"]);
  const oneBus = new MDF(fixture("dbc-one-bus.mf4"));
  assert.deepEqual(
    oneBus.attachments.map((a) => a.fileName),
    ["bus0_mur_control_can.dbc"],
    "The external reference for bus 1 is ignored"
  );
  assert.deepEqual(oneBus.attachmentErrors, []);
  assert.deepEqual(new MDF(fixture("dbc-none.mf4")).attachments, []);
});

test("attachment names map to interfaces by BusChannel; other attachments are ignored", () => {
  const data = new TextEncoder().encode('VERSION ""');
  const buses = busDBCsFromAttachments([
    { fileName: "bus0_mur_control_can.dbc", mimeType: "", data },
    { fileName: "runs/bus12_extra.DBC", mimeType: "", data },
    { fileName: "config.toml", mimeType: "", data },
    { fileName: "busX_bad.dbc", mimeType: "", data }
  ]);
  assert.deepEqual(Object.keys(buses), ["can0", "can12"]);
  assert.deepEqual(Object.keys(buses.can12), ["bus12_extra.DBC"]);
});

test("an attached DBC wins over the bundled one for its bus", () => {
  const { values, meta } = open("dbc-attached.mf4");
  assert.deepEqual(values(PEDAL), [20, 40, 60], "Scaled by the snapshot's 0.2, not the bundled 0.1");
  assert.deepEqual(values(SHOCK), [50, 60, 70]);
  assert.deepEqual(meta.dbcsByBus, {
    can0: { from: "attached", files: ["bus0_mur_control_can.dbc"] },
    can1: { from: "attached", files: ["bus1_mur_telemetry_can.dbc"] }
  });
});

test("a file without attachments decodes with the bundled DBCs, as before", () => {
  const { values, meta } = open("dbc-none.mf4");
  assert.deepEqual(values(PEDAL), [10, 20, 30]);
  assert.deepEqual(values(SHOCK), [50, 60, 70]);
  assert.equal(meta.dbcsByBus.can0.from, "bundled");
  assert.equal(meta.dbcsByBus.can1.from, "bundled");
});

test("a bus without an attachment falls back to the bundled DBCs, or the DBC folder when set", () => {
  const { values, meta } = open("dbc-one-bus.mf4");
  assert.deepEqual(values(PEDAL), [20, 40, 60], "bus 0: its snapshot");
  assert.deepEqual(values(SHOCK), [50, 60, 70], "bus 1: bundled");
  assert.equal(meta.dbcsByBus.can0.from, "attached");
  assert.equal(meta.dbcsByBus.can1.from, "bundled");

  // A DBC folder replaces the bundled set for buses without snapshots, exactly as for candump logs.
  const control = BUNDLED_DBCS["mur_control_can.dbc"];
  const folder = {
    "control.dbc": control.replace(
      "SG_ REAR_ShockPotRearLeft : 0|16@1+ (0.1,0)",
      "SG_ REAR_ShockPotRearLeft : 0|16@1+ (1,0)"
    )
  };
  assert.notEqual(folder["control.dbc"], control);
  const withFolder = open("dbc-one-bus.mf4", new TextEncoder().encode(JSON.stringify(folder)));
  assert.deepEqual(withFolder.values(PEDAL), [20, 40, 60]);
  assert.deepEqual(withFolder.values(SHOCK), [500, 600, 700]);
  assert.deepEqual(withFolder.meta.dbcsByBus.can1, { from: "DBC folder", files: ["control.dbc"] });
});

test("field keys and their metadata keys match between attached and bundled decodes", () => {
  const keys = (name: string) =>
    open(name)
      .log.getFieldKeys()
      .filter((key) => !key.startsWith("Metadata/"))
      .sort();
  const bundled = keys("dbc-none.mf4");
  assert.ok(bundled.includes(PEDAL) && bundled.includes(SHOCK));
  assert.deepEqual(keys("dbc-attached.mf4"), bundled);
  assert.deepEqual(keys("dbc-one-bus.mf4"), bundled);

  // The DBC fallback for layouts (PR #20) and Trackside limits read dbcSignal; dbc says which file decoded it.
  const meta = (name: string, key: string) => JSON.parse(open(name).log.getMetadataString(key));
  assert.equal(meta("dbc-attached.mf4", PEDAL).dbcSignal, meta("dbc-none.mf4", PEDAL).dbcSignal);
  assert.equal(meta("dbc-attached.mf4", PEDAL).dbc, "bus0_mur_control_can.dbc");
  assert.equal(meta("dbc-none.mf4", PEDAL).dbc, "mur_control_can.dbc");
  assert.equal(meta("dbc-one-bus.mf4", SHOCK).dbc, "mur_control_can.dbc", "Bundled: control wins the ID");
  assert.equal(meta("dbc-attached.mf4", SHOCK).dbc, "bus1_mur_telemetry_can.dbc");
  assert.equal(meta("dbc-attached.mf4", SHOCK).node, "ECU", "Metadata shows what the snapshot says");
});

test("the archive's run file decodes with its attached snapshots", () => {
  const importer = createMDFImporter();
  const log = importer.start([fixture("archive-run.mf4")]);
  importer.decode(["INVERTER/INV_MotorSpeedRPM"]);
  assert.deepEqual(log.getNumber("INVERTER/INV_MotorSpeedRPM", 0, 2)?.values, [1000, 2000, 3000, 4000]);
  const meta = JSON.parse(log.getString("Metadata/Import", -Infinity, Infinity)!.values[0]);
  assert.equal(meta.dbcsByBus.can0.from, "attached");
  assert.ok(meta.dbcsByBus.can0.files.includes("bus0_Cascadia_PM100DZ.dbc"));
});

test("a signal a snapshot renames keeps the name the file has", () => {
  const index: CandumpIndex = {
    count: 1,
    timestamps: new Float64Array([1]),
    ids: new Uint32Array([0x100]),
    ifaceIndex: new Uint8Array([0]),
    ifaces: ["can0"],
    flags: new Uint8Array([0]),
    dataLength: new Uint8Array([8]),
    data: new Uint8Array(DATA_STRIDE),
    malformedLines: 0
  };
  index.data[0] = 100;
  const renamed = BUNDLED_DBCS["mur_control_can.dbc"].replace("SG_ PEDAL_Position1 :", "SG_ PEDAL_Travel1 :");
  const importer = createCandumpImporter();
  const log = importer.start([null, null, null, null], index, { can0: { "bus0_mur_control_can.dbc": renamed } });
  assert.ok(log.getFieldKeys().includes("PEDALBOX/PEDAL_Travel1"));
  assert.ok(!log.getFieldKeys().includes(PEDAL));
  assert.ok(log.getFieldKeys().includes("PEDALBOX/PEDAL_Position2"), "Unchanged signals keep their keys");
});
