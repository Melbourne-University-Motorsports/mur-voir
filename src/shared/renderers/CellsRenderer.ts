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
  VOLTAGE_COLOR_STOPS,
  cellSlot,
  cellsRange,
  classifyCell,
  voltageColor
} from "../Cells";
import TabRenderer from "./TabRenderer";

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
    const { cells, options } = view;
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
          : "Drag per-sensor temperature fields into Temperatures.";
      return;
    }

    const voltage = this.mode === "voltages";
    const values = cells.filter((cell): cell is Cell & { value: number } => cell.value !== undefined);
    const [low, high] = cellsRange(view, this.mode);
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
    if (voltage) {
      const range = document.createElement("span");
      const ramp = document.createElement("i");
      ramp.className = "cells-gradient";
      const stops = VOLTAGE_COLOR_STOPS.map(
        ({ value, rgb }) => `rgb(${rgb.join(" ")}) ${((value - low) / (high - low)) * 100}%`
      );
      ramp.style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
      range.append(`${low.toFixed(2)} V`, ramp, `${high.toFixed(2)} V`);
      this.legend.append(range);
    } else {
      legendItem("Normal", "normal");
      if (options.low !== undefined || options.high !== undefined) legendItem("Outside limits", "limit");
    }
    legendItem("Stale", "stale");

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
    const colors = { normal: color("normal"), limit: color("limit"), stale: color("stale") };
    const muted = color("muted");
    const plotWidth = width - left - 2;
    const readingFont = `10px ${style.fontFamily}`;
    context.textBaseline = "middle";
    const readingText = (cell: Cell) => (cell.value === undefined ? "[Missing Data]" : this.format(cell.value));
    const compact = plotWidth / CELLS_PER_ROW < 11;
    const segmentGap = compact ? 2 : 7;
    const slotWidth = cellSlot(0, plotWidth, options.segmentSize, segmentGap).width;
    if (slotWidth <= 0) return;
    const inset = compact ? 0.5 : 1.5;
    const barWidth = Math.max(1, slotWidth - inset * 2);
    const voltageFontSize = Math.min(10, barWidth);
    const voltageFont = `600 ${voltageFontSize}px ${style.fontFamily}`;
    const labelWidth = slotWidth * (compact ? 5 : 1) - 2;
    context.font = `600 12px ${style.fontFamily}`;
    const widestNumber = cells.reduce(
      (widest, { number }) => Math.max(widest, context.measureText(String(number)).width),
      0
    );
    const numberSize = Math.max(9, Math.min(12, (12 * labelWidth) / widestNumber));
    const numberFont = `600 ${numberSize}px ${style.fontFamily}`;
    const readingOffset = 22;
    context.font = readingFont;
    const labelHeight = voltage
      ? readingOffset
      : readingOffset +
        Math.ceil(cells.reduce((longest, cell) => Math.max(longest, context.measureText(readingText(cell)).width), 0)) +
        4;
    const rowHeight = height / Math.ceil(cells.length / CELLS_PER_ROW);
    const plotHeight = rowHeight - labelHeight - 8;
    if (plotHeight <= 0) return;
    const padding = Math.min(4, plotHeight / 4);

    for (let start = 0; start < cells.length; start += CELLS_PER_ROW) {
      const top = (start / CELLS_PER_ROW) * rowHeight + 6;
      const base = top + plotHeight;
      const mapY = (value: number) => base - plotHeight * Math.max(0, Math.min(1, (value - low) / (high - low)));
      context.font = readingFont;
      context.fillStyle = muted;
      context.textAlign = "right";
      if (voltage || values.length > 0 || options.lockedRange) {
        context.fillText(high.toFixed(voltage ? 2 : 1), left - 5, top + 4);
        context.fillText(low.toFixed(voltage ? 2 : 1), left - 5, base);
      }
      const end = Math.min(cells.length, start + CELLS_PER_ROW);
      for (let index = start; index < end; index++) {
        const cell = cells[index];
        const slot = cellSlot(index, plotWidth, options.segmentSize, segmentGap);
        const x = left + slot.x;
        const center = x + slot.width / 2;
        const showLabel = !compact || cell.number % 5 === 0;
        const kind = classifyCell(cell, options);
        const barTop = cell.value === undefined ? base : Math.min(base - 1, mapY(cell.value));
        if (kind !== "missing" && cell.value !== undefined) {
          context.fillStyle = voltage && kind !== "stale" ? voltageColor(cell.value) : colors[kind];
          context.fillRect(x + inset, barTop, barWidth, base - barTop);
        }
        if (voltage) {
          context.font = voltageFont;
          const reading = readingText(cell);
          const readingWidth = Math.min(context.measureText(reading).width, plotHeight - padding * 2);
          const fitsInside = readingWidth + padding * 2 <= base - barTop;
          const labelBottom = fitsInside ? base - padding : Math.max(barTop - padding, top + padding + readingWidth);
          if (kind !== "missing" && !fitsInside && labelBottom + 2 > barTop) {
            // On short rows, clear the part of the bar under the label for contrast.
            const backingWidth = Math.min(barWidth, voltageFontSize + 4);
            context.clearRect(
              center - backingWidth / 2,
              labelBottom - readingWidth - 2,
              backingWidth,
              readingWidth + 4
            );
          }
          let ink = kind === "missing" ? muted : style.color;
          if (fitsInside && cell.value !== undefined) ink = kind !== "stale" && cell.value < 2.15 ? "#fff" : "#000";
          context.save();
          context.translate(center, labelBottom);
          context.rotate(-Math.PI / 2);
          context.textAlign = "left";
          context.fillStyle = ink;
          context.fillText(reading, 0, 0, readingWidth);
          context.restore();
        }
        if (showLabel) {
          context.font = numberFont;
          context.textAlign = "center";
          context.fillStyle = style.color;
          const numberWidth = Math.min(labelWidth, (width - center) * 2 - 2);
          context.fillText(String(cell.number), center, base + 12, numberWidth);
          if (!voltage) {
            context.save();
            context.translate(center, base + readingOffset);
            context.rotate(-Math.PI / 2);
            context.font = readingFont;
            context.textAlign = "right";
            context.fillStyle = muted;
            context.fillText(readingText(cell), 0, 0);
            context.restore();
          }
        }
        this.hits.push({ x, y: top, width: slot.width, height: plotHeight + labelHeight, index });
      }
    }
    this.updateTooltip();
  }
}
