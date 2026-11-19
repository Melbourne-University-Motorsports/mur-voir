// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// A bus decoded with attached snapshots falls back to the default set's definition of a frame the
// default set multiplexes and the snapshot doesn't (old runs carry ENNOID_VCell with flat cells).
// The bundled DBCs aren't multiplexed yet, so the default set here is a DBC folder.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUNDLED_DBCS } from "../../src/hub/dataSources/can/BundledDBCs";
import { CandumpIndex, DATA_STRIDE, FLAG_EXTENDED } from "../../src/hub/dataSources/can/Candump";
import { BusDBCs, createCandumpImporter } from "../../src/hub/dataSources/can/CandumpImporter";

const OLD_ENNOID = BUNDLED_DBCS["vendor/ENNOID_BMS.dbc"];
const VCELL_BLOCK = /(BO_ 2147494154 ENNOID_VCell: )8( ENNOID\r?\n)((?: SG_ [^\n]*\n)+)/;
const VCELL_ID = 0x290a;
const cellKey = (cell: number) => "ENNOID/ENNOID_CellV" + cell.toString().padStart(3, "0");
const cellMillivolts = (cell: number) => (cell === 108 ? -1 : 3300 + cell);

/** The ENNOID DBC with ENNOID_VCell multiplexed by CellIndex, as mur-msgs will ship it. */
function multiplexedEnnoid(factor = 0.001, length = 8): string {
  const signals = [
    ' SG_ ENNOID_CellIndex M : 7|8@0+ (1,0) [0|255] "" TTCS',
    ' SG_ ENNOID_CellTotal : 15|8@0+ (1,0) [0|255] "" TTCS'
  ];
  for (let first = 0; first < 108; first += 3) {
    for (let j = 0; j < 3; j++) {
      const name = "ENNOID_CellV" + (first + j + 1).toString().padStart(3, "0");
      signals.push(` SG_ ${name} m${first} : ${23 + 16 * j}|16@0- (${factor},0) [-32.768|32.767] "V" TTCS`);
    }
  }
  assert.match(OLD_ENNOID, VCELL_BLOCK);
  return OLD_ENNOID.replace(VCELL_BLOCK, `$1${length}$2${signals.join("\n")}\n`);
}

/** The DBC folder: the bundled set with ENNOID_VCell multiplexed. */
const MUX_FOLDER = new TextEncoder().encode(
  JSON.stringify({ ...BUNDLED_DBCS, "vendor/ENNOID_BMS.dbc": multiplexedEnnoid() })
);

/** One 1 Hz ENNOID_VCell burst (36 frames) on each interface. */
function burst(ifaces: string[]): CandumpIndex {
  const count = 36 * ifaces.length;
  const index: CandumpIndex = {
    count,
    timestamps: new Float64Array(count),
    ids: new Uint32Array(count).fill(VCELL_ID),
    ifaceIndex: new Uint8Array(count),
    ifaces,
    flags: new Uint8Array(count).fill(FLAG_EXTENDED),
    dataLength: new Uint8Array(count).fill(8),
    data: new Uint8Array(count * DATA_STRIDE),
    malformedLines: 0
  };
  for (let i = 0; i < count; i++) {
    const first = (i % 36) * 3;
    index.timestamps[i] = 1 + i * 0.001;
    index.ifaceIndex[i] = Math.floor(i / 36);
    const offset = i * DATA_STRIDE;
    index.data[offset] = first;
    index.data[offset + 1] = 108;
    for (let j = 0; j < 3; j++) {
      const raw = cellMillivolts(first + j + 1) & 0xffff;
      index.data[offset + 2 + 2 * j] = raw >> 8;
      index.data[offset + 3 + 2 * j] = raw & 0xff;
    }
  }
  return index;
}

function open(ifaces: string[], busDBCs: BusDBCs, folder: Uint8Array | null = MUX_FOLDER) {
  const importer = createCandumpImporter();
  const log = importer.start([null, null, null, folder], burst(ifaces), busDBCs);
  const cells = log.getFieldKeys().filter((key) => key.startsWith("ENNOID/ENNOID_CellV"));
  importer.decode(cells);
  const values = (key: string) => log.getNumber(key, -Infinity, Infinity)!.values.map((v) => Math.round(v * 1e4) / 1e4);
  const meta = JSON.parse(log.getString("Metadata/Import", -Infinity, Infinity)!.values[0]);
  return { log, cells: cells.sort(), values, meta };
}

const ALL_CELLS = Array.from({ length: 108 }, (_, i) => cellKey(i + 1)).sort();
const OLD_CELLS = ["ENNOID/ENNOID_CellV0", "ENNOID/ENNOID_CellV1", "ENNOID/ENNOID_CellV2"];

test("an old run's flat ENNOID_VCell snapshot decodes with the multiplexed default definition", () => {
  const { cells, values, meta, log } = open(["can0"], { can0: { "bus0_ENNOID_BMS.dbc": OLD_ENNOID } });
  assert.deepEqual(cells, ALL_CELLS);
  for (let cell = 1; cell <= 108; cell++) {
    assert.deepEqual(values(cellKey(cell)), [cellMillivolts(cell) / 1000], cellKey(cell));
  }
  assert.deepEqual(meta.dbcsByBus.can0, {
    from: "attached",
    files: ["bus0_ENNOID_BMS.dbc"],
    overrides: ["ENNOID_VCell"],
    overridesFrom: "DBC folder"
  });
  assert.equal(JSON.parse(log.getMetadataString(cellKey(1))).dbc, "vendor/ENNOID_BMS.dbc");
});

test("both definitions flat: the attached one decodes, as before", () => {
  const attached = OLD_ENNOID.replace(/\(0\.001,0\)/g, "(0.01,0)");
  const { cells, values, meta } = open(["can0"], { can0: { "bus0_ENNOID_BMS.dbc": attached } }, null);
  assert.deepEqual(cells, OLD_CELLS);
  assert.equal(values("ENNOID/ENNOID_CellV0").length, 36, "Every group lands in the same three fields");
  assert.equal(values("ENNOID/ENNOID_CellV0")[0], 33.01, "Scaled by the snapshot");
  assert.deepEqual(meta.dbcsByBus.can0, { from: "attached", files: ["bus0_ENNOID_BMS.dbc"] });
});

test("an attached multiplexed definition wins over the default one", () => {
  const { cells, values, meta } = open(["can0"], { can0: { "bus0_ENNOID_BMS.dbc": multiplexedEnnoid(0.01) } });
  assert.deepEqual(cells, ALL_CELLS);
  assert.deepEqual(values(cellKey(1)), [33.01], "Scaled by the snapshot");
  assert.equal(meta.dbcsByBus.can0.overrides, undefined);
});

test("a different length keeps the attached definition", () => {
  const attached = OLD_ENNOID.replace(VCELL_BLOCK, "$16$2$3");
  assert.notEqual(attached, OLD_ENNOID);
  const { cells, meta } = open(["can0"], { can0: { "bus0_ENNOID_BMS.dbc": attached } });
  assert.deepEqual(cells, OLD_CELLS);
  assert.equal(meta.dbcsByBus.can0.overrides, undefined);
});

test("a bus without attachments decodes with the default set and lists no overrides", () => {
  const { cells, values, meta, log } = open(["can0", "can1"], { can0: { "bus0_ENNOID_BMS.dbc": OLD_ENNOID } });
  assert.deepEqual(cells, ALL_CELLS, "Both buses share the multiplexed fields");
  assert.deepEqual(values(cellKey(4)), [3.304]);
  assert.equal(JSON.parse(log.getMetadataString(cellKey(4))).buses, "can0, can1");
  assert.deepEqual(meta.dbcsByBus.can0.overrides, ["ENNOID_VCell"]);
  assert.deepEqual(Object.keys(meta.dbcsByBus.can1), ["from", "files"]);
  assert.equal(meta.dbcsByBus.can1.from, "DBC folder");

  // With the bundled (flat) set and no attachments, nothing changes
  const bundled = open(["can0"], {}, null);
  assert.deepEqual(bundled.cells, OLD_CELLS);
  assert.deepEqual(bundled.meta.dbcsByBus.can0, { from: "bundled", files: bundled.meta.dbcsByBus.can0.files });
  assert.equal(bundled.meta.dbcsByBus.can0.overrides, undefined);
});
