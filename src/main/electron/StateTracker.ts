// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { app, BrowserWindow, screen } from "electron";
import fs from "fs";
import jsonfile from "jsonfile";
import { getAllTabTypes } from "../../shared/TabType";
import {
  HUB_DEFAULT_HEIGHT,
  HUB_DEFAULT_WIDTH,
  SATELLITE_DEFAULT_HEIGHT,
  SATELLITE_DEFAULT_WIDTH,
  STATE_FILENAME
} from "./ElectronConstants";

export default class StateTracker {
  private SAVE_PERIOD_MS = 1000;
  private lastSaved = "";
  private rendererStates: { [id: number]: any } = {};
  private satellites = new Map<number, { hubId: number; uuid: string }>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.lastSaved = JSON.stringify(this.getSavedApplicationState(false));
    // Save a second after something changes: a renderer's state, the satellite set, or a window's
    // bounds. A stable app never builds or serializes the state.
    const watch = (window: BrowserWindow) => {
      window.on("move", () => this.markChanged());
      window.on("resize", () => this.markChanged());
      window.on("closed", () => this.markChanged());
    };
    BrowserWindow.getAllWindows().forEach(watch);
    app.on("browser-window-created", (_, window) => watch(window));
  }

  private markChanged() {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, this.SAVE_PERIOD_MS);
  }

  /** Writes the state file if the state changed. Also called before quitting, so the last second is kept. */
  save() {
    let state: ApplicationState = this.getCurrentApplicationState();
    if (state.hubs.length === 0) return;
    const serialized = JSON.stringify(state);
    if (serialized === this.lastSaved) return;
    jsonfile.writeFileSync(STATE_FILENAME, state);
    this.lastSaved = serialized;
  }

  /** Reads the full application state based on the saved file. */
  getSavedApplicationState(allowReset = true): ApplicationState | null {
    if (fs.existsSync(STATE_FILENAME)) {
      try {
        let state: ApplicationState = jsonfile.readFileSync(STATE_FILENAME);
        state.satellites = state.satellites.filter((satellite) => getAllTabTypes().includes(satellite.state.type));
        [...state.hubs, ...state.satellites].forEach((window, index) => {
          if (allowReset) {
            let reset = !screen
              .getAllDisplays()
              .some(
                (display) =>
                  window.x >= display.bounds.x &&
                  window.y >= display.bounds.y &&
                  window.x + window.width <= display.bounds.x + display.bounds.width &&
                  window.y + window.height <= display.bounds.y + display.bounds.height
              );
            if (reset) {
              const primaryBounds = screen.getPrimaryDisplay().bounds;
              const isHub = index < state.hubs.length;
              const defaultWidth = isHub ? HUB_DEFAULT_WIDTH : SATELLITE_DEFAULT_WIDTH;
              const defaultHeight = isHub ? HUB_DEFAULT_HEIGHT : SATELLITE_DEFAULT_HEIGHT;
              window.x = primaryBounds.x + primaryBounds.width / 2 - defaultWidth / 2;
              window.y = primaryBounds.y + primaryBounds.height / 2 - defaultHeight / 2;
              window.width = defaultWidth;
              window.height = defaultHeight;
            }
          }
        });
        return state;
      } catch (e) {
        console.error("Unable to load state. Reverting to default settings.", e);
        fs.copyFileSync(STATE_FILENAME, STATE_FILENAME.slice(0, -5) + "-corrupted.json");
        return null;
      }
    } else {
      return null;
    }
  }

  /** Returns the full application state. */
  getCurrentApplicationState(): ApplicationState {
    let state: ApplicationState = { hubs: [], satellites: [] };
    const hubIndices = new Map<number, number>();
    const satellites: { bounds: Electron.Rectangle; state: any; hubId: number; uuid: string }[] = [];
    for (const [id, rendererState] of Object.entries(this.rendererStates)) {
      const windowId = Number(id);
      const window = BrowserWindow.fromId(windowId);
      if (window === null) continue;
      const bounds = window.getBounds();
      const satellite = this.satellites.get(windowId);
      if (satellite === undefined) {
        hubIndices.set(windowId, state.hubs.length);
        state.hubs.push({ ...bounds, state: rendererState });
      } else {
        satellites.push({ bounds, state: rendererState, ...satellite });
      }
    }
    for (const { bounds, state: rendererState, hubId, uuid } of satellites) {
      const hubIndex = hubIndices.get(hubId);
      if (hubIndex !== undefined) state.satellites.push({ ...bounds, state: rendererState, uuid, hubIndex });
    }
    return state;
  }

  /** Caches the renderer state for a window. */
  saveRendererState(window: BrowserWindow, rendererState: any) {
    this.rendererStates[window.id] = rendererState;
    this.markChanged();
  }

  /** Returns the cached renderer state for a window. */
  getRendererState(window: BrowserWindow): any {
    return this.rendererStates[window.id];
  }

  /** Records which hub owns a satellite so it can be restored with the same hub. */
  trackSatellite(window: BrowserWindow, hub: BrowserWindow, uuid: string) {
    const id = window.id;
    this.satellites.set(id, { hubId: hub.id, uuid });
    window.once("closed", () => {
      this.satellites.delete(id);
      delete this.rendererStates[id];
      this.markChanged();
    });
    this.markChanged();
  }
}

export type ApplicationState = { hubs: WindowState[]; satellites: SatelliteWindowState[] };

export type WindowState = {
  x: number;
  y: number;
  width: number;
  height: number;
  state: any;
};

export type SatelliteWindowState = WindowState & {
  uuid: string;
  hubIndex?: number;
};
