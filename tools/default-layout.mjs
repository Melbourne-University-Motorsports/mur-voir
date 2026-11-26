// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// Writes the bundled default layout, src/shared/layouts/default.json (File > Add Track Day Layout).
// Run from the repository root: node tools/default-layout.mjs
//
// Every field uses its live cellular path (vehicles/mur27/can<bus>/<message>/<signal>, lower case,
// as Wireless-telem's cellular.py builds it) and carries its DBC signal name, so SourceList's DBC
// fallback can re-point it at the same signal in an MF4 run or the mock backend.

import fs from "fs";
import path from "path";

const OUT = path.join("src", "shared", "layouts");
const VERSION = JSON.parse(fs.readFileSync("package.json", "utf8")).version;

// Bus ids are the Pi's logical buses (config/telem.toml), not its interface names:
// 0 = Control/Tractive (physical can1), 1 = Telemetry (physical can0).
const CELL_SIGNALS = Array.from({ length: 108 }, (_, i) => "ENNOID_CellV" + String(i + 1).padStart(3, "0"));
const MESSAGES = {
  0: {
    ECU_Status: ["ECU_ECUState", "ECU_TSActive", "ECU_FaultFlags", "ECU_DashInputsStale", "ECU_BrakeTorqueCut"],
    ECU_Control: ["ECU_TorqueRequest"],
    TTCS_Status: ["TTCS_SDCStatus1", "TTCS_SDCStatus2", "TTCS_IMDState"],
    TTCS_Diagnostics: ["TTCS_HVCurrent", "TTCS_IMDResistance"],
    TTCS_Limits: ["TTCS_DCL", "TTCS_CCL", "TTCS_BattHighTemp"],
    MUR_HB_TTCS: ["HB_TTCS_FaultBits"],
    MUR_HB_Pedalbox: ["HB_PEDAL_FaultBits"],
    MUR_HB_Rear: ["HB_REAR_FaultBits"],
    Pedal_Status: ["PEDAL_Position1", "PEDAL_Position2", "PEDAL_BrakePressure1", "PEDAL_BrakePressure2"],
    Rear_Dynamics: ["REAR_ShockPotRearLeft", "REAR_ShockPotRearRight"],
    Rear_Thermal: ["REAR_RadiatorTempIn", "REAR_RadiatorTempOut"],
    INV_MotorPosition: ["INV_MotorSpeedRPM"],
    INV_Voltages: ["INV_DCBusVoltage"],
    INV_Currents: ["INV_DCBusCurrent"],
    INV_TorqueTimer: ["INV_CommandedTorque", "INV_FeedbackTorque"],
    INV_Temperatures1: ["INV_ModuleATemp", "INV_ModuleBTemp", "INV_ModuleCTemp", "INV_GateDriverTemp"],
    INV_Temperatures2: ["INV_ControlBoardTemp"],
    INV_Temperatures3_Torque: ["INV_CoolantTemp", "INV_HotSpotTemp"],
    INV_InternalStates: [
      "INV_VSMState",
      "INV_InverterState",
      "INV_InverterEnableState",
      "INV_InverterEnableLockout",
      "INV_BMSLimitingTorque",
      "INV_LimitHotSpot",
      "INV_CoolantTempLimiting"
    ],
    INV_FaultCodes: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => "INV_FaultByte" + i),
    ENNOID_VCell: CELL_SIGNALS,
    ENNOID_VTot: ["ENNOID_PackVoltage"],
    ENNOID_Summary: ["ENNOID_CellVoltageMin", "ENNOID_CellVoltageMax", "ENNOID_SoC"]
  },
  1: {
    ECU_DashData: ["ECU_AccuTempMax", "ECU_AccuTempMin", "ECU_AccuSOC"],
    ECU_DashData2: ["ECU_MotorTemp", "ECU_InverterTemp"],
    ECU_DashData3: ["ECU_DashMode", "ECU_StartStage", "ECU_TorqueSet", "ECU_ABPCActive"],
    MUR_HB_Dash: ["HB_DASH_FaultBits"],
    Dashboard_Dynamics: ["DASH_SteeringAngle", "DASH_ShockPotFrontLeft", "DASH_ShockPotFrontRight"],
    Dashboard_Speed: ["DASH_SpeedFL", "DASH_SpeedFR", "DASH_SpeedRear", "DASH_SpeedCar"],
    Dashboard_Lap: ["DASH_CurrentLap", "DASH_LastLap", "DASH_BestLap", "DASH_LapCount"],
    Telemetry_LVBattery: ["TELEM_LVBatteryVoltage", "TELEM_LVBatterySOC"],
    PDU_Status: ["PDU_PumpState", "PDU_Fan1Duty", "PDU_Fan2Duty"],
    SBG_Front_Accel: ["SBG_FRONT_AccelX", "SBG_FRONT_AccelY"],
    SBG_Front_Gyro: ["SBG_FRONT_GyroZ"]
  }
};

// Enum signals arrive as String fields (labels) over cellular and from MF4.
const ENUMS = new Set([
  "ECU_ECUState",
  "TTCS_IMDState",
  "INV_VSMState",
  "INV_InverterState",
  "INV_InverterEnableLockout",
  "ECU_DashMode",
  "ECU_StartStage"
]);

const SIGNALS = {};
for (const [bus, messages] of Object.entries(MESSAGES)) {
  for (const [message, signals] of Object.entries(messages)) {
    for (const signal of signals) {
      SIGNALS[signal] = `/vehicles/mur27/can${bus}/${message.toLowerCase()}/${signal.toLowerCase()}`;
    }
  }
}

const COLORS = ["#2b66a2", "#e5b31b", "#af2437", "#80588e", "#e48b32", "#3b875a", "#d993aa", "#858584"];

function item(signal, type, options = {}) {
  if (!(signal in SIGNALS)) throw new Error("Unknown signal " + signal);
  return {
    type,
    logKey: SIGNALS[signal],
    logType: ENUMS.has(signal) ? "String" : "Number",
    dbcSignal: signal,
    visible: true,
    options
  };
}

const lines = (signals, start = 0) =>
  signals.map((s, i) => item(s, "stepped", { color: COLORS[(start + i) % COLORS.length], size: "normal" }));
const stripes = (signals) => signals.map((s, i) => item(s, "stripes", { color: COLORS[i % COLORS.length] }));
const unit = (autoTarget) => ({ autoTarget, preset: null });

let uuid = 0;
function tab(type, title, controller, renderer = null) {
  return { type, title, controller, controllerUUID: "defaultview" + uuid++, renderer, controlsHeight: 260 };
}

function trackside(title, tiles, limits = {}) {
  return tab(15, title, {
    sources: tiles.map((s) => item(s, "tile")),
    limits: Object.fromEntries(Object.entries(limits).map(([signal, range]) => [SIGNALS[signal], range]))
  });
}

function lineGraph(title, { left = [], right = [], discrete = [], leftUnit = null, rightUnit = null }) {
  return tab(1, title, {
    leftSources: lines(left),
    rightSources: lines(right, left.length),
    discreteSources: stripes(discrete),
    leftLockedRange: null,
    rightLockedRange: null,
    leftUnitConversion: unit(leftUnit),
    rightUnitConversion: unit(rightUnit),
    leftFilter: 0,
    rightFilter: 0,
    showRobotMode: false,
    lapMode: "time"
  });
}

// Limits come from firmware, not guesses: TTCS ttcs/src/main.c gs_batt_cal and gs_current_cal.
const ACCU_LIMITS = {
  ECU_AccuTempMax: { high: 60 },
  ENNOID_CellVoltageMin: { low: 2.5 },
  ENNOID_CellVoltageMax: { high: 4.2 },
  ENNOID_PackVoltage: { low: 270, high: 453.6 }
};

// One default layout. Values shared between the earlier per-view drafts appear once: car state
// and the headline numbers on "Track day", fault words on "Faults", history on named graphs.
const TABS = [
  // Tab 0 is always Documentation; the hub never closes it.
  { ...tab(0, "", null, ""), controlsHeight: 0 },
  trackside(
    "Track day",
    [
      "ECU_ECUState",
      "ECU_StartStage",
      "ECU_TSActive",
      "INV_VSMState",
      "ECU_DashMode",
      "ECU_TorqueSet",
      "ECU_AccuSOC",
      "ECU_AccuTempMax",
      "ENNOID_CellVoltageMin",
      "ENNOID_CellVoltageMax",
      "ENNOID_PackVoltage",
      "TTCS_DCL",
      "ECU_MotorTemp",
      "ECU_InverterTemp",
      "TELEM_LVBatteryVoltage",
      "DASH_SpeedCar",
      "DASH_SpeedRear",
      "DASH_CurrentLap",
      "DASH_LastLap",
      "DASH_BestLap",
      "TTCS_IMDState",
      "ECU_ABPCActive",
      "ECU_DashInputsStale"
    ],
    ACCU_LIMITS
  ),
  trackside("Faults", [
    "TTCS_SDCStatus1",
    "TTCS_SDCStatus2",
    "INV_InverterEnableLockout",
    "HB_TTCS_FaultBits",
    "HB_PEDAL_FaultBits",
    "HB_DASH_FaultBits",
    "HB_REAR_FaultBits",
    "ECU_FaultFlags",
    "INV_FaultByte0",
    "INV_FaultByte1",
    "INV_FaultByte2",
    "INV_FaultByte3",
    "INV_FaultByte4",
    "INV_FaultByte5",
    "INV_FaultByte6",
    "INV_FaultByte7"
  ]),
  lineGraph("States", {
    discrete: [
      "ECU_ECUState",
      "ECU_TSActive",
      "TTCS_SDCStatus1",
      "TTCS_SDCStatus2",
      "INV_VSMState",
      "INV_InverterEnableState",
      "TTCS_IMDState",
      "ECU_ABPCActive"
    ]
  }),
  lineGraph("HV voltage", {
    left: ["ENNOID_PackVoltage", "INV_DCBusVoltage"],
    right: ["ENNOID_CellVoltageMin", "ENNOID_CellVoltageMax"],
    leftUnit: "volts",
    rightUnit: "volts"
  }),
  lineGraph("Accu temp and current", {
    left: ["ECU_AccuTempMax", "ECU_AccuTempMin", "TTCS_BattHighTemp"],
    right: ["INV_DCBusCurrent", "TTCS_HVCurrent", "TTCS_DCL", "TTCS_CCL"],
    leftUnit: "celsius"
  }),
  lineGraph("Motor and torque", {
    left: ["INV_MotorSpeedRPM"],
    right: ["ECU_TorqueRequest", "INV_CommandedTorque", "INV_FeedbackTorque"],
    discrete: ["INV_BMSLimitingTorque"],
    leftUnit: "rotations/minute"
  }),
  lineGraph("Drive temps", {
    left: [
      "ECU_MotorTemp",
      "ECU_InverterTemp",
      "INV_ModuleATemp",
      "INV_ModuleBTemp",
      "INV_ModuleCTemp",
      "INV_GateDriverTemp",
      "INV_ControlBoardTemp",
      "INV_CoolantTemp",
      "INV_HotSpotTemp",
      "REAR_RadiatorTempIn",
      "REAR_RadiatorTempOut"
    ],
    right: ["PDU_Fan1Duty", "PDU_Fan2Duty"],
    discrete: ["PDU_PumpState", "INV_CoolantTempLimiting", "INV_LimitHotSpot"],
    leftUnit: "celsius"
  }),
  lineGraph("Pedals", {
    left: ["PEDAL_Position1", "PEDAL_Position2"],
    right: ["PEDAL_BrakePressure1", "PEDAL_BrakePressure2"],
    discrete: ["ECU_BrakeTorqueCut"],
    leftUnit: "percent",
    rightUnit: "psi"
  }),
  tab(
    17,
    "Car",
    {
      sources: [
        item("DASH_SteeringAngle", "steering", { invert: "normal" }),
        item("DASH_SpeedFL", "speedFL"),
        item("DASH_SpeedFR", "speedFR"),
        item("SBG_FRONT_GyroZ", "yawRate", { invert: "normal" }),
        // SBG body frame is X right, Y back, Z down: longitudinal is -Y, lateral is X.
        item("SBG_FRONT_AccelY", "accelX", { invert: "inverted" }),
        item("SBG_FRONT_AccelX", "accelY", { invert: "normal" }),
        item("DASH_ShockPotFrontLeft", "shockFL"),
        item("DASH_ShockPotFrontRight", "shockFR"),
        item("REAR_ShockPotRearLeft", "shockRL"),
        item("REAR_ShockPotRearRight", "shockRR")
      ]
    },
    null
  )
];

TABS.splice(2, 0, {
  type: 18,
  title: "Cells",
  controller: {
    voltages: {
      sources: CELL_SIGNALS.map((signal) => item(signal, "number")),
      options: { low: 2.5, high: 4.2, outlier: 150, segmentSize: 18 }
    },
    temperatures: { sources: [], options: { segmentSize: 18 } },
    minimum: [item("ENNOID_CellVoltageMin", "number")],
    maximum: [item("ENNOID_CellVoltageMax", "number")]
  },
  controllerUUID: "defaultview-cells",
  renderer: "voltages",
  controlsHeight: 0
});

fs.mkdirSync(OUT, { recursive: true });
const state = { sidebar: { width: 300, expanded: [] }, tabs: { selected: 1, tabs: TABS } };
const file = path.join(OUT, "default.json");
fs.writeFileSync(file, JSON.stringify({ version: VERSION, hubs: [state], satellites: [] }, null, 2) + "\n");
console.log(file);
