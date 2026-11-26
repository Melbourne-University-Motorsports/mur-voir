// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import {
  CELLS_MODES,
  CELLS_PER_ROW,
  Cell,
  CellsCommand,
  CellsMode,
  CellsView,
  cellSlot,
  cellsRange,
  classifyCell
} from "../Cells";
import TabRenderer from "./TabRenderer";

const LEGEND = [
  ["normal", "Normal"],
  ["limit", "Outside limits"],
  ["outlier", "Outlier"],
  ["stale", "Stale"]
] as const;

export default class CellsRenderer implements TabRenderer {
  private mode: CellsMode = "voltages";
  private command?: CellsCommand;
  private drawn?: CellsView;
  private canvas: HTMLCanvasElement;
  private stats: HTMLElement;
  private empty: HTMLElement;
  private legend: HTMLElement;
  private tooltip: HTMLElement;
  private buttons: HTMLButtonElement[];
  private resize: ResizeObserver;
  private theme = matchMedia("(prefers-color-scheme: dark)");
  private events = new AbortController();
  private hits: { x: number; y: number; width: number; height: number; index: number }[] = [];
  private mean = 0;
  private pointer?: { x: number; y: number };

  constructor(private root: HTMLElement) {
    root.classList.add("cells-monitor");
    root.innerHTML = `
      <div class="cells-heading">
        <div class="cells-view-switch" role="group" aria-label="Monitor view">
          <button type="button">Voltages</button><button type="button">Temperatures</button>
        </div>
        <div class="cells-stats"></div>
      </div>
      <canvas aria-label="Cell readings"></canvas>
      <div class="cells-empty" hidden></div>
      <div class="cells-legend"></div>
      <div class="cells-tooltip" role="tooltip" hidden></div>`;
    this.canvas = root.querySelector("canvas")!;
    this.stats = root.querySelector(".cells-stats")!;
    this.empty = root.querySelector(".cells-empty")!;
    this.legend = root.querySelector(".cells-legend")!;
    this.tooltip = root.querySelector(".cells-tooltip")!;
    this.buttons = [...root.querySelectorAll("button")];
    this.buttons.forEach((button, i) => (button.onclick = () => this.restoreState(CELLS_MODES[i])));
    this.syncMode();

    const signal = this.events.signal;
    this.canvas.addEventListener(
      "pointermove",
      (event) => {
        this.pointer = { x: event.offsetX, y: event.offsetY };
        this.updateTooltip();
      },
      { signal }
    );
    this.canvas.addEventListener(
      "pointerleave",
      () => {
        this.pointer = undefined;
        this.tooltip.hidden = true;
      },
      { signal }
    );
    this.theme.addEventListener("change", () => this.draw(), { signal });
    this.resize = new ResizeObserver(() => this.draw());
    this.resize.observe(this.canvas);
  }

  dispose() {
    this.resize.disconnect();
    this.events.abort();
  }

  saveState() {
    return this.mode;
  }

  restoreState(state: unknown) {
    this.mode = state === "temperatures" ? "temperatures" : "voltages";
    this.syncMode();
    this.pointer = undefined;
    this.draw();
  }

  getAspectRatio() {
    return null;
  }

  render(command: CellsCommand) {
    const view = command[this.mode];
    this.command = command;
    if (view === this.drawn) return;
    const previous = this.drawn;
    if (
      previous?.options === view.options &&
      previous.references.length === view.references.length &&
      previous.references.every(
        ({ value, label }, i) => value === view.references[i].value && label === view.references[i].label
      ) &&
      previous.cells.length === view.cells.length &&
      previous.cells.every((cell, i) => {
        const next = view.cells[i];
        return (
          cell.number === next.number &&
          cell.value === next.value &&
          (cell.staleAge === undefined) === (next.staleAge === undefined)
        );
      })
    ) {
      this.drawn = view;
      if (this.pointer) this.updateTooltip();
      return;
    }
    this.draw();
  }

  private syncMode() {
    this.buttons.forEach((button, i) => button.setAttribute("aria-pressed", String(this.mode === CELLS_MODES[i])));
    this.canvas.setAttribute("aria-label", this.mode === "voltages" ? "Cell voltages" : "Cell temperatures");
  }

  private format(value: number) {
    return this.mode === "voltages" ? `${value.toFixed(3)} V` : `${value.toFixed(1)} °C`;
  }

  private delta(value: number, signed = false) {
    const text = this.mode === "voltages" ? `${(value * 1000).toFixed(0)} mV` : `${value.toFixed(1)} °C`;
    return signed && value > 0 ? "+" + text : text;
  }

  private cellName(cell: Cell) {
    return (this.mode === "voltages" ? "C" : "T") + cell.number;
  }

  private updateTooltip() {
    const point = this.pointer;
    const hit =
      point &&
      this.hits.find(
        ({ x, y, width, height }) => point.x >= x && point.x < x + width && point.y >= y && point.y <= y + height
      );
    const cell = hit && this.command?.[this.mode].cells[hit.index];
    this.tooltip.hidden = !cell;
    if (!point || !cell) return;
    const value =
      cell.value === undefined
        ? "No reading"
        : `${this.format(cell.value)} · ${this.delta(cell.value - this.mean, true)} from mean`;
    const age = cell.staleAge === undefined ? "" : `\nStale · ${cell.staleAge.toFixed(1)} s old`;
    this.tooltip.textContent = `${this.cellName(cell)} · ${value}${age}\n${cell.key}`;
    this.tooltip.style.left =
      Math.max(0, Math.min(this.canvas.offsetLeft + point.x + 10, this.root.clientWidth - this.tooltip.offsetWidth)) +
      "px";
    this.tooltip.style.top =
      Math.max(0, Math.min(this.canvas.offsetTop + point.y + 12, this.root.clientHeight - this.tooltip.offsetHeight)) +
      "px";
  }

  private draw() {
    const view = this.command?.[this.mode];
    if (!view) return;
    this.drawn = view;
    this.hits = [];
    const { cells, options, references } = view;
    const hasSources = cells.length > 0;
    this.empty.hidden = hasSources;
    this.canvas.hidden = !hasSources;
    this.legend.hidden = !hasSources;
    this.stats.replaceChildren();
    this.updateTooltip();
    if (!hasSources) {
      this.empty.textContent =
        this.mode === "voltages"
          ? "Drag numeric fields into Voltages."
          : "No temperature fields configured. Add ENNOID temperature channels (ENNOID_Temp0, ENNOID_Temp1, ENNOID_Temp2) when available.";
      return;
    }

    const values = cells.filter((cell): cell is Cell & { value: number } => cell.value !== undefined);
    if (values.length) {
      const minimum = values.reduce((a, b) => (b.value < a.value ? b : a));
      const maximum = values.reduce((a, b) => (b.value > a.value ? b : a));
      this.mean = values.reduce((sum, cell) => sum + cell.value, 0) / values.length;
      const labels = [
        `min ${this.format(minimum.value)} (${this.cellName(minimum)})`,
        `max ${this.format(maximum.value)} (${this.cellName(maximum)})`,
        `spread ${this.delta(maximum.value - minimum.value)}`,
        `mean ${this.format(this.mean)}`
      ];
      this.stats.replaceChildren(
        ...labels.map((label) => {
          const part = document.createElement("span");
          part.textContent = label;
          return part;
        })
      );
    } else {
      this.stats.textContent = "No readings at the cursor";
    }

    this.legend.replaceChildren();
    const legendItem = (label: string, kind: string) => {
      const item = document.createElement("span");
      const swatch = document.createElement("i");
      swatch.className = "cells-swatch cells-" + kind;
      item.append(swatch, label);
      this.legend.append(item);
    };
    LEGEND.forEach(([kind, label]) => legendItem(label, kind));
    references.forEach(({ label, value }, index) => legendItem(`${label} ${this.format(value)}`, String(index + 1)));

    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const context = this.canvas.getContext("2d");
    const left = 42;
    if (!context || width <= left || !height) return;
    const scale = devicePixelRatio;
    this.canvas.width = Math.round(width * scale);
    this.canvas.height = Math.round(height * scale);
    context.scale(scale, scale);
    const style = getComputedStyle(this.root);
    const color = (name: string) => style.getPropertyValue("--cells-" + name).trim();
    const colors = { normal: color("normal"), limit: color("limit"), outlier: color("outlier"), stale: color("stale") };
    const [low, high] = cellsRange(view, this.mode);
    const plotWidth = width - left - 2;
    context.font = `10px ${style.fontFamily}`;
    context.textBaseline = "middle";
    const labelText = (cell: Cell) => [`[ ${cell.number} ] `, cell.value === undefined ? "—" : this.format(cell.value)];
    // The band under each row fits the longest label, so 3-digit cell numbers never run into the bars.
    const labelHeight =
      Math.ceil(
        cells.reduce((longest, cell) => Math.max(longest, context.measureText(labelText(cell).join("")).width), 0)
      ) + 8;
    const rowHeight = height / Math.ceil(cells.length / CELLS_PER_ROW);
    const plotHeight = rowHeight - labelHeight - 8;
    const compact = plotWidth / CELLS_PER_ROW < 11;
    if (plotHeight <= 0) return;

    for (let start = 0; start < cells.length; start += CELLS_PER_ROW) {
      const top = (start / CELLS_PER_ROW) * rowHeight + 6;
      const base = top + plotHeight;
      const mapY = (value: number) => base - plotHeight * Math.max(0, Math.min(1, (value - low) / (high - low)));
      context.fillStyle = color("muted");
      context.textAlign = "right";
      context.fillText(high.toFixed(this.mode === "voltages" ? 3 : 1), left - 5, top + 4);
      context.fillText(low.toFixed(this.mode === "voltages" ? 3 : 1), left - 5, base);
      context.textAlign = "left";
      context.fillRect(left, base, plotWidth, 1);
      const end = Math.min(cells.length, start + CELLS_PER_ROW);
      for (let index = start; index < end; index++) {
        const cell = cells[index];
        const slot = cellSlot(index, plotWidth, options.segmentSize, compact ? 2 : 7);
        const x = left + slot.x;
        const kind = classifyCell(cell, this.mean, options, this.mode);
        if (kind !== "missing" && cell.value !== undefined) {
          const y = Math.min(base - 1, mapY(cell.value));
          const inset = compact ? 0.5 : 1.5;
          context.fillStyle = colors[kind];
          context.fillRect(x + inset, y, Math.max(1, slot.width - inset * 2), base - y);
        }
        if (!compact || cell.number % 5 === 0) {
          // Rotated to read bottom to top, ending just under the bar
          const [number, reading] = labelText(cell);
          context.save();
          context.translate(x + slot.width / 2, base + 4);
          context.rotate(-Math.PI / 2);
          context.textAlign = "right";
          context.fillStyle = style.color;
          context.fillText(reading, 0, 0);
          context.fillStyle = color("muted");
          context.fillText(number, -context.measureText(reading).width, 0);
          context.restore();
        }
        this.hits.push({ x, y: top, width: slot.width, height: plotHeight + labelHeight, index });
      }

      const line = (value: number | undefined, stroke: string, dash: number[]) => {
        if (value === undefined || value < low || value > high) return;
        const y = Math.round(mapY(value)) + 0.5;
        context.strokeStyle = stroke;
        context.setLineDash(dash);
        context.beginPath();
        context.moveTo(left, y);
        context.lineTo(width - 2, y);
        context.stroke();
      };
      line(options.low, colors.limit, [4, 3]);
      line(options.high, colors.limit, [4, 3]);
      references.forEach(({ value }, index) => line(value, color(String(index + 1)), index === 0 ? [2, 3] : [7, 3]));
    }
    this.updateTooltip();
  }
}
