// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// Run after npm run compile: node --test tools/satellite-smoke.mjs
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { _electron } from "playwright";

test("hubs restored with the same tab UUID publish independent satellite revisions", { timeout: 30000 }, async () => {
  const userData = await mkdtemp(join(tmpdir(), "mur-voir-satellite-test-"));
  let app;
  try {
    const layout = JSON.parse(await readFile("src/shared/layouts/default.json", "utf8")).hubs[0];
    const trackside = layout.tabs.tabs.find((tab) => tab.type === 15);
    const uuid = trackside.controllerUUID;
    const state = { ...layout, tabs: { selected: 1, tabs: [layout.tabs.tabs[0], trackside] } };
    const preferenceFile = join(userData, "prefs.json");
    await writeFile(preferenceFile, JSON.stringify({ theme: "dark" }));

    const saved = {
      hubs: [0, 1].map((index) => ({
        x: 40 + index * 30,
        y: 40,
        width: 900,
        height: 650,
        state: {
          ...state,
          tabs: { ...state.tabs, tabs: [state.tabs.tabs[0], { ...trackside, title: "Hub " + index }] }
        }
      })),
      satellites: []
    };
    await writeFile(join(userData, "state-dev.json"), JSON.stringify(saved));
    const env = { ...process.env, MURVOIR_HEADLESS: "1", MURVOIR_USER_DATA: userData };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ args: ["bundles/main.js"], env });
    await app.firstWindow();
    const nextWindow = async (name, count) => {
      for (let attempt = 0; attempt < 160; attempt++) {
        const existing = app.windows().filter((page) => page.url().endsWith("/" + name + ".html"));
        if (existing.length === count) return existing;
        await delay(50);
      }
      throw new Error(`Expected ${count} ${name} windows`);
    };
    const hubs = await nextWindow("hub", 2);
    await Promise.all(
      hubs.map((hub) => hub.waitForFunction((uuid) => window.tabs?.saveState().tabs[1]?.controllerUUID === uuid, uuid))
    );
    const [owner, other] = hubs;

    const tile = (text) => ({
      label: "Voltage",
      text,
      unit: "V",
      state: "",
      severity: "normal",
      freshness: null
    });
    const snapshot = (title, revision, text) => ({
      uuid,
      title,
      revision,
      command: { tiles: [tile(text)], graph: null }
    });
    const patch = (title, baseRevision, revision, text) => ({
      uuid,
      title,
      revision,
      baseRevision,
      patch: { tiles: [[0, tile(text)]] }
    });
    const send = (hub, message) =>
      hub.evaluate((update) => window.sendMainMessage("update-satellite", update), message);
    const expectValue = (satellite, value) =>
      satellite.waitForFunction(
        (value) => document.querySelector(".trackside-tile .trackside-reading span")?.textContent === value,
        value
      );

    await owner.evaluate(() => window.tabs.newSatellite());
    const [satellite] = await nextWindow("satellite", 1);
    await satellite.waitForFunction(() => !document.getElementById("renderer15")?.hidden);
    assert.deepEqual(await other.evaluate(() => window.tabs.activeSatellites), []);
    await send(owner, snapshot("Owner", "owner:1", "101"));
    await expectValue(satellite, "101");
    await send(other, snapshot("Other", "other:1", "202"));
    await send(owner, patch("Owner", "owner:1", "owner:2", "102"));
    await expectValue(satellite, "102");

    await other.evaluate(() => window.tabs.newSatellite());
    const satellites = await nextWindow("satellite", 2);
    const otherSatellite = satellites.find((page) => page !== satellite);
    await otherSatellite.waitForFunction(() => !document.getElementById("renderer15")?.hidden);
    await send(other, snapshot("Other", "other:2", "203"));
    await expectValue(otherSatellite, "203");
    await send(owner, patch("Owner", "owner:2", "owner:3", "103"));
    await expectValue(satellite, "103");
    assert.equal(await otherSatellite.locator(".trackside-tile .trackside-reading span").first().textContent(), "203");

    const stateFile = join(userData, "state-dev.json");
    for (let attempt = 0; attempt < 80; attempt++) {
      const savedState = JSON.parse(await readFile(stateFile, "utf8"));
      if (savedState.satellites.length === 2) {
        assert.deepEqual(savedState.satellites.map((item) => item.hubIndex).sort(), [0, 1]);
        return;
      }
      await delay(50);
    }
    assert.fail("Both satellites should save their hub");
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  }
});
