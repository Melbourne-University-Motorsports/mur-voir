// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { setText } from "../domWrite";
import { sameTracksideTile, TracksidePatch, TracksideTile } from "../Trackside";
import LineGraphRenderer, { LineGraphRendererCommand } from "./LineGraphRenderer";
import TabRenderer from "./TabRenderer";

export type TracksideRendererCommand = {
  tiles: TracksideTile[];
  message: string;
  graph: LineGraphRendererCommand | null;
};

export default class TracksideRenderer implements TabRenderer {
  private events = new AbortController();
  private finishDrag = () => {};
  private grid: HTMLElement;
  private graphRoot: HTMLElement;
  private graph: LineGraphRenderer;
  private renderedTiles: TracksideTile[] = [];
  constructor(root: HTMLElement, reorder?: (from: number, to: number) => void) {
    this.grid = root.firstElementChild as HTMLElement;
    this.graphRoot = document.createElement("div");
    this.graphRoot.className = "trackside-graph";
    this.graphRoot.innerHTML = document.getElementById("renderer1")!.innerHTML;
    root.append(this.graphRoot);
    this.graph = new LineGraphRenderer(this.graphRoot, !!reorder);
    if (!reorder) return;
    let pressed: { x: number; y: number; cell: HTMLElement } | null = null;
    let cancelled: AbortController;
    let finish = () => {};
    let clearDrag = () => {};
    this.grid.addEventListener(
      "mousedown",
      (event) => {
        if (event.button !== 0) return;
        const cell = (event.target as HTMLElement).closest<HTMLElement>(".trackside-tile");
        if (!cell) return;
        finish();
        cancelled = new AbortController();
        pressed = { x: event.clientX, y: event.clientY, cell };
        finish = () => {
          pressed = null;
          this.finishDrag = () => {};
          cancelled.abort();
          clearDrag();
          clearDrag = () => {};
          document.getElementById("dragItem")!.hidden = true;
          document.body.style.cursor = "";
        };
        this.finishDrag = finish;
        window.addEventListener("mouseup", finish, { signal: cancelled.signal });
        window.addEventListener("keydown", (event) => event.key === "Escape" && finish(), { signal: cancelled.signal });
        window.addEventListener("pointercancel", finish, { signal: cancelled.signal });
        window.addEventListener("blur", finish, { signal: cancelled.signal });
      },
      { signal: this.events.signal }
    );
    this.grid.addEventListener(
      "mousemove",
      (event) => {
        if (!pressed || (Math.abs(event.clientX - pressed.x) < 5 && Math.abs(event.clientY - pressed.y) < 5)) return;
        const { cell } = pressed;
        pressed = null;
        const from = Array.from(this.grid.children).indexOf(cell);
        if (from < 0) {
          finish();
          return;
        }
        const rect = cell.getBoundingClientRect();
        const ghost = cell.cloneNode(true) as HTMLElement;
        ghost.style.width = rect.width + "px";
        ghost.style.height = rect.height + "px";
        ghost.style.boxSizing = "border-box";
        document.getElementById("dragItem")!.replaceChildren(ghost);
        const highlight = document.createElement("div");
        highlight.className = "trackside-drag-highlight";
        root.append(highlight);
        const data = { trackside: this };
        const update = (event: Event) => {
          const drag = (event as CustomEvent).detail;
          if (drag.data !== data) return;
          const gridRect = this.grid.getBoundingClientRect();
          const inside =
            this.grid.offsetParent !== null &&
            drag.x >= gridRect.left &&
            drag.x <= gridRect.right &&
            drag.y >= gridRect.top &&
            drag.y <= gridRect.bottom;
          highlight.hidden = !inside;
          let to = 0;
          let distance = Infinity;
          let target: DOMRect = rect;
          let edge = rect.left;
          Array.from(this.grid.children).forEach((element, index) => {
            const bounds = element.getBoundingClientRect();
            for (const after of [false, true]) {
              const x = after ? bounds.right : bounds.left;
              const d = Math.hypot(drag.x - x, drag.y - Math.max(bounds.top, Math.min(bounds.bottom, drag.y)));
              if (d < distance) {
                distance = d;
                to = index + Number(after);
                target = bounds;
                edge = x;
              }
            }
          });
          if (drag.end) {
            finish();
            if (inside) reorder(from, to);
          } else {
            const rootRect = root.getBoundingClientRect();
            highlight.style.left = edge - rootRect.left - 6 + "px";
            highlight.style.top = target.top - rootRect.top + "px";
            highlight.style.height = target.height + "px";
          }
        };
        clearDrag = () => highlight.remove();
        window.addEventListener("drag-update", update, { signal: cancelled.signal });
        window.startDrag(event.clientX, event.clientY, event.clientX - rect.left, event.clientY - rect.top, data);
      },
      { signal: this.events.signal }
    );
  }
  dispose() {
    this.finishDrag();
    this.events.abort();
    this.graph.dispose();
  }
  saveState() {
    return this.graph.saveState();
  }
  restoreState(state: unknown) {
    this.graph.restoreState(state);
  }
  getAspectRatio() {
    return null;
  }
  render(command: TracksideRendererCommand, patch?: TracksidePatch) {
    // Runs every frame, so every DOM write below happens only when its value changed.
    // Rewriting unchanged text or attributes still invalidates style and layout.
    const showGraph = !!command.graph;
    if (this.graphRoot.hidden === showGraph) this.graphRoot.hidden = !showGraph;
    if (this.grid.classList.contains("with-graph") !== showGraph) this.grid.classList.toggle("with-graph", showGraph);
    if (command.graph && (!patch || patch.graph !== undefined)) this.graph.render(command.graph);
    if (command.message || !command.tiles.length) {
      const text = command.message || "Drag fields into the tile list below.";
      const current = this.grid.firstElementChild;
      if (
        this.grid.children.length !== 1 ||
        !current?.classList.contains("tab-centered") ||
        current.textContent !== text
      ) {
        const message = document.createElement("div");
        message.className = "tab-centered";
        message.textContent = text;
        this.grid.replaceChildren(message);
      }
      this.renderedTiles = [];
      return;
    }
    if (
      this.grid.children.length !== command.tiles.length ||
      !this.grid.firstElementChild?.classList.contains("trackside-tile")
    ) {
      patch = undefined;
      this.renderedTiles = [];
      this.grid.replaceChildren(
        ...command.tiles.map(() => {
          const cell = document.createElement("div");
          cell.className = "trackside-tile";
          for (const name of ["label", "reading", "state"]) {
            const element = document.createElement("div");
            element.className = "trackside-" + name;
            cell.append(element);
          }
          const unit = document.createElement("span");
          unit.className = "trackside-unit";
          cell.children[1].append(document.createElement("span"), unit);
          return cell;
        })
      );
    }
    if (command.tiles === this.renderedTiles) return;
    const updateTile = (tile: TracksideTile, index: number) => {
      const previous = this.renderedTiles[index];
      if (previous && sameTracksideTile(previous, tile)) return;
      const cell = this.grid.children[index] as HTMLElement;
      const freshness = tile.state.includes("link lost") ? "offline" : tile.freshness ?? "";
      if (cell.dataset.severity !== tile.severity) cell.dataset.severity = tile.severity;
      if (cell.dataset.freshness !== freshness) cell.dataset.freshness = freshness;
      setText(cell.children[0], tile.label);
      setText(cell.children[1].children[0], tile.text);
      setText(cell.children[1].children[1], tile.unit ? " " + tile.unit : "");
      setText(cell.children[2], tile.state);
      const title = `${tile.label}: ${tile.text} ${tile.unit} ${tile.state}` + (tile.detail ? "\n" + tile.detail : "");
      if (cell.title !== title) cell.title = title;
    };
    if (patch) {
      for (const [index, tile] of patch.tiles) updateTile(tile, index);
    } else {
      command.tiles.forEach(updateTile);
    }
    this.renderedTiles = command.tiles;
  }
}
