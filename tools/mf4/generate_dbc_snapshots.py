# Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
# https://github.com/Melbourne-University-Motorsports/mur-voir
#
# Use of this source code is governed by a BSD
# license that can be found in the LICENSE file
# at the root directory of this project.

"""Builds the MF4 fixtures for DBC snapshots attached to a run (test/importers/mf4-dbc.test.ts).

Wireless-telem attaches each run's DBC snapshots to the merged MF4 as ``bus<id>_<name>.dbc``,
where ``<id>`` is the ``CAN_DataFrame.BusChannel`` its frames carry. The frames here use the same
CAN_DataFrame layout as Wireless-telem's ``storage.py``.

Run from the mur-voir root with an environment that has asammdf, for example Wireless-telem's:

    uv run --project ~/code/Wireless-telem python tools/mf4/generate_dbc_snapshots.py

Writes to test/fixtures/mf4/:
  dbc-none.mf4      bus 0 and bus 1 frames, no attachments
  dbc-attached.mf4  both buses attached; bus 0's snapshot scales PEDAL_Position1 by 0.2 instead of
                    0.1 (compressed attachment), bus 1's is the bundled telemetry DBC (uncompressed)
  dbc-one-bus.mf4   only bus 0 attached (uncompressed), plus an external file reference for bus 1
                    that readers must ignore
  archive-run.mf4   bus.mf4 with every bundled DBC attached for bus 0, uncompressed, the way the
                    archive serves runs (the mock backend's run file)
"""

from pathlib import Path

import numpy as np
from asammdf import MDF, Signal, Source

ROOT = Path(__file__).resolve().parents[2]
HERE = ROOT / "test" / "fixtures" / "mf4"
DBC = ROOT / "src" / "hub" / "dataSources" / "can" / "dbc"

CAN_FIELDS = [
    ("BusChannel", "u1"),
    ("ID", "<u4"),
    ("IDE", "u1"),
    ("DLC", "u1"),
    ("DataLength", "u1"),
    ("DataBytes", "u1", (64,)),
    ("Dir", "u1"),
    ("EDL", "u1"),
    ("BRS", "u1"),
    ("ESI", "u1"),
]

# (time, bus, id, payload). Pedal_Status (0x100) on bus 0: PEDAL_Position1 raw 100, 200, 300.
# Rear_Dynamics (0x150) on bus 1: REAR_ShockPotRearLeft raw 500, 600, 700.
FRAMES = []
for i, raw in enumerate((100, 200, 300)):
    FRAMES.append((0.1 * i, 0, 0x100, raw.to_bytes(2, "little") + bytes(6)))
for i, raw in enumerate((500, 600, 700)):
    FRAMES.append((0.1 * i + 0.05, 1, 0x150, raw.to_bytes(2, "little") + bytes(6)))
FRAMES.sort()


def frames_mdf():
    mdf = MDF(version="4.10")
    dtype = np.dtype([(f"CAN_DataFrame.{f[0]}", *f[1:]) for f in CAN_FIELDS])
    data = np.zeros(len(FRAMES), dtype=dtype)
    for i, (_, bus, can_id, payload) in enumerate(FRAMES):
        data[i]["CAN_DataFrame.BusChannel"] = bus
        data[i]["CAN_DataFrame.ID"] = can_id
        data[i]["CAN_DataFrame.DLC"] = len(payload)
        data[i]["CAN_DataFrame.DataLength"] = len(payload)
        data[i]["CAN_DataFrame.DataBytes"][: len(payload)] = list(payload)
    mdf.append(
        Signal(
            name="CAN_DataFrame",
            samples=data,
            timestamps=np.array([t for t, *_ in FRAMES]),
            source=Source("CAN", "", "", 2, 2),
        )
    )
    return mdf


def rescaled_control_dbc():
    text = (DBC / "mur_control_can.dbc").read_text()
    old = ' SG_ PEDAL_Position1 : 0|10@1+ (0.1,0) [0|100] "%"'
    assert old in text, "the bundled control DBC changed; update this fixture"
    return text.replace(old, ' SG_ PEDAL_Position1 : 0|10@1+ (0.2,0) [0|200] "%"').encode()


def save(mdf, name):
    mdf.save(HERE / name, overwrite=True)
    mdf.close()


save(frames_mdf(), "dbc-none.mf4")

mdf = frames_mdf()
mdf.attach(rescaled_control_dbc(), file_name="bus0_mur_control_can.dbc", compression=True)
mdf.attach(
    (DBC / "mur_telemetry_can.dbc").read_bytes(), file_name="bus1_mur_telemetry_can.dbc", compression=False
)
save(mdf, "dbc-attached.mf4")

mdf = frames_mdf()
mdf.attach(rescaled_control_dbc(), file_name="bus0_mur_control_can.dbc", compression=False)
mdf.attach(b"", file_name="bus1_mur_telemetry_can.dbc", embedded=False)
save(mdf, "dbc-one-bus.mf4")

mdf = MDF(HERE / "bus.mf4")
for path in sorted(DBC.rglob("*.dbc")):
    mdf.attach(path.read_bytes(), file_name=f"bus0_{path.name}", compression=False)
save(mdf, "archive-run.mf4")
