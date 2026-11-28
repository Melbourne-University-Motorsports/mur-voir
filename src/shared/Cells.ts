// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

export type CellsMode = "voltages" | "temperatures";
export type CellRange = [number, number];
export type CellsOptions = {
  low?: number;
  high?: number;
  segmentSize: number;
  lockedRange?: CellRange;
};
export type Cell = { number: number; key: string; value?: number; staleAge?: number };
export type CellsView = {
  cells: Cell[];
  options: CellsOptions;
};
export type CellsCommand = Record<CellsMode, CellsView>;

export const CELLS_PER_ROW = 36;
export const CELLS_MODES = ["voltages", "temperatures"] as const;
const VOLTAGE_RANGE: CellRange = [2, 4.35];
export const VOLTAGE_COLOR_STOPS = [
  { value: VOLTAGE_RANGE[0], rgb: [218, 30, 40] },
  { value: 3.175, rgb: [241, 194, 27] },
  { value: 3.9, rgb: [168, 217, 111] },
  { value: VOLTAGE_RANGE[1], rgb: [36, 161, 72] }
] as const;

export function isEnnoidCellSignal(signal: string): boolean {
  return /^ENNOID_(?:CellV\d+|Temp\d+|CellTemp\d+)$/i.test(signal);
}

export function fitCellAxis(values: number[], minimumSpan: number): CellRange {
  if (values.length === 0) return [0, minimumSpan];
  const low = Math.min(...values);
  const high = Math.max(...values);
  const middle = (low + high) / 2;
  const halfSpan = Math.max(minimumSpan / 2, (high - low) * 0.75);
  return [middle - halfSpan, middle + halfSpan];
}

export function cellsRange(view: CellsView, mode: CellsMode): CellRange {
  if (mode === "voltages") return VOLTAGE_RANGE;
  return (
    view.options.lockedRange ??
    fitCellAxis(
      view.cells.flatMap(({ value }) => (value === undefined ? [] : [value])),
      2
    )
  );
}

export function voltageColor(voltage: number): string {
  const [low, high] = VOLTAGE_RANGE;
  const clamped = Math.max(low, Math.min(high, voltage));
  let stop = 0;
  while (stop < VOLTAGE_COLOR_STOPS.length - 2 && clamped > VOLTAGE_COLOR_STOPS[stop + 1].value) stop++;
  const from = VOLTAGE_COLOR_STOPS[stop];
  const to = VOLTAGE_COLOR_STOPS[stop + 1];
  const ratio = (clamped - from.value) / (to.value - from.value);
  const mix = from.rgb.map((channel, index) => Math.round(channel + (to.rgb[index] - channel) * ratio));
  return `rgb(${mix.join(" ")})`;
}

export function classifyCell(cell: Cell, options: CellsOptions) {
  const { value, staleAge } = cell;
  if (value === undefined) return "missing";
  if (staleAge !== undefined) return "stale";
  if (value < (options.low ?? -Infinity) || value > (options.high ?? Infinity)) return "limit";
  return "normal";
}

export function cellSlot(index: number, width: number, segmentSize: number, gap: number) {
  const gaps = Math.floor((CELLS_PER_ROW - 1) / segmentSize);
  const step = (width - gaps * gap) / CELLS_PER_ROW;
  const slot = index % CELLS_PER_ROW;
  return { x: slot * step + Math.floor(slot / segmentSize) * gap, width: step };
}
