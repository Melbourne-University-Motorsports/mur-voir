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
  outlier?: number;
  segmentSize: number;
  lockedRange?: CellRange;
};
export type Cell = { number: number; key: string; value?: number; staleAge?: number };
export type CellsView = {
  cells: Cell[];
  options: CellsOptions;
  references: { label: string; value: number }[];
};
export type CellsCommand = Record<CellsMode, CellsView>;

export const CELLS_PER_ROW = 54;
export const CELLS_MODES = ["voltages", "temperatures"] as const;

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
  return (
    view.options.lockedRange ??
    fitCellAxis(
      [
        ...view.cells.flatMap(({ value }) => (value === undefined ? [] : [value])),
        ...view.references.map(({ value }) => value)
      ],
      mode === "voltages" ? 0.2 : 2
    )
  );
}

export function classifyCell(cell: Cell, mean: number, options: CellsOptions, mode: CellsMode) {
  const { value, staleAge } = cell;
  if (value === undefined) return "missing";
  if (staleAge !== undefined) return "stale";
  if (value < (options.low ?? -Infinity) || value > (options.high ?? Infinity)) return "limit";
  const delta = Math.abs(value - mean) * (mode === "voltages" ? 1000 : 1);
  if (delta - (options.outlier ?? Infinity) > 1e-9) return "outlier";
  return "normal";
}

export function cellSlot(index: number, width: number, segmentSize: number, gap: number) {
  const gaps = Math.floor((CELLS_PER_ROW - 1) / segmentSize);
  const step = (width - gaps * gap) / CELLS_PER_ROW;
  const slot = index % CELLS_PER_ROW;
  return { x: slot * step + Math.floor(slot / segmentSize) * gap, width: step };
}
