// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// Real Electron, real importer/source, real renderer. Run after npm run compile.
// node tools/perf/cloud-electron.mjs [file|live] [seconds=180] [decay=1]
import electronPath from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { _electron } from "playwright";
import { disablePayloadMirroring, freePort, options, ready } from "./cloud-process.mjs";
const cli = options();
const mode = cli.positionals[0] ?? "file",
  seconds = Number(cli.positionals[1] ?? 180),
  decay = cli.positionals[2] ?? "1";
if (
  !["file", "live", "ros"].includes(mode) ||
  !Number.isFinite(seconds) ||
  seconds <= 0 ||
  !Number.isInteger(Number(decay)) ||
  Number(decay) < 1 ||
  Number(decay) > 20
)
  throw Error("Expected mode file/live/ros, positive duration, and decay 1–20");
const port = Number(cli.values.port),
  rosPort = port + 1;
if (mode === "file" && !cli.values.input) throw Error("file mode requires --input path/to/cloud.mcap");
await fs.mkdir(cli.values["temp-root"], { recursive: true });
const root = process.cwd(),
  dir = await fs.mkdtemp(cli.values["temp-root"] + "/profile-"),
  shots = cli.values.output;
await fs.mkdir(dir, { recursive: true });
await fs.mkdir(shots, { recursive: true });
await fs.writeFile(dir + "/beta-2027.json", JSON.stringify({ welcomeComplete: true, surveyTime: Date.now() + 1e12 }));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app, backend;
try {
  if (mode === "ros") {
    await freePort(rosPort);
    backend = spawn(process.execPath, ["tools/mock-ros.mjs"], {
      cwd: root,
      env: { ...env, ROS_MOCK_PORT: String(rosPort), ROS_MOCK_RESET: "1" },
      stdio: ["ignore", "ignore", "inherit"]
    });
    await ready(backend, rosPort);
  }
  if (mode === "live") {
    await freePort(port);
    backend = spawn(
      process.execPath,
      [
        "tools/mock-backend/src/main.ts",
        "--port",
        String(port),
        "--point-cloud",
        "--point-cloud-points",
        "300000",
        "--point-cloud-hz",
        "10",
        "--sim-clock"
      ],
      { cwd: root, stdio: ["ignore", "ignore", "inherit"] }
    );
    await ready(backend, port);
  }
  app = await _electron.launch({
    executablePath: electronPath,
    args: [
      "bundles/main.js",
      "--enable-precise-memory-info",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--user-data-dir=" + dir,
      ...(mode === "file" ? [cli.values.input] : [])
    ],
    cwd: root,
    env
  });
  while (!app.windows().some((w) => w.url().endsWith("hub.html"))) await app.waitForEvent("window");
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.closeDevTools();
      if (w.webContents.getURL().includes("betaWelcome")) w.close();
      else if (w.webContents.getURL().endsWith("hub.html")) {
        w.webContents.setBackgroundThrottling(false);
        w.setContentSize(1440, 960);
      }
    }
  });
  const hub = app.windows().find((w) => w.url().endsWith("hub.html"));
  await hub.waitForFunction(() => window.tabs && window.preferences && document.querySelector(".connect-source"));
  await disablePayloadMirroring(hub);
  hub.on("pageerror", (e) => console.error("PAGE", String(e)));
  if (mode !== "file") {
    await hub.evaluate(() => {
      const Native = window.WebSocket;
      window.__cloudSockets = [];
      window.WebSocket = class extends Native {
        constructor(...args) {
          super(...args);
          window.__cloudSockets.push(this);
        }
      };
    });
    await hub.evaluate(() => window.dispatchEvent(new Event("welcome-connect")));
    console.log(
      await hub
        .locator(".connect-dialog")
        .innerText()
        .catch(() => hub.locator("body").innerText())
    );
    await hub
      .locator(".connect-dialog:visible select")
      .filter({ has: hub.locator('option[value="mur"]') })
      .selectOption(mode === "ros" ? "foxglove" : "mur");
    await hub
      .locator("input[placeholder]")
      .evaluateAll((es) => es.map((e) => ({ placeholder: e.placeholder, type: e.type })))
      .then(console.log);
    await hub
      .locator(".connect-address")
      .fill(mode === "ros" ? `ws://127.0.0.1:${rosPort}` : `http://127.0.0.1:${port}`);
    await hub.getByRole("button", { name: "Connect", exact: true }).click();
    await hub.waitForFunction(() =>
      window.log.getFieldKeys().some((k) => window.log.getStructuredType(k) === "sensor_msgs/PointCloud2")
    );
  }
  console.log(
    "setup",
    await hub.evaluate(
      ({ mode, decay }) => {
        window.__cloudPerfEnabled = true;
        window.preferences.field3dModeAc = "standard";
        window.preferences.field3dModeBattery = "standard";
        const tabs = window.tabs;
        const tab = tabs.tabList.find((t) => t.type === 3);
        tabs.selectedTab = tabs.tabList.indexOf(tab);
        tabs.updateElements();
        tab.controller.restoreState({
          game: "MUR:Grid",
          fixedFrame: "map",
          sources: [
            {
              type: "spatial",
              logKey: mode !== "live" ? "/lidar/points" : "/vehicles/mur27/perception/points",
              logType: "sensor_msgs/PointCloud2",
              visible: true,
              options: { field: "intensity", size: "3", map: "turbo", decay }
            }
          ]
        });
        if (mode === "file") window.selection.setSelectedTime(2.9);
        const frames = [];
        window.__cloudReady = { frames: 0, current: 0, held: 0, empty: 0, maxAge: 0 };
        let last = performance.now();
        function tick(t) {
          if (!window.__cloudMeasureUntil || t <= window.__cloudMeasureUntil) {
            frames.push(t - last);
            window.__cloudReady.frames++;
            const newest = Math.max(
              ...(tab.renderer.implementation?.objectManagers
                .filter((e) => e.active && e.type === "cloud")
                .map((e) => JSON.parse(e.cloudId)[1]) ?? [])
            );
            const key = tab.controller.saveState().sources[0]?.logKey;
            const cursor = window.selection.getSelectedTime();
            const wanted = window.log
              .getRaw(key, cursor, cursor)
              ?.timestamps.filter((s) => s <= cursor)
              .at(-1);
            if (!Number.isFinite(newest)) window.__cloudReady.empty++;
            else {
              const age = Math.max(0, (wanted ?? newest) - newest);
              window.__cloudReady[age < 0.00001 ? "current" : "held"]++;
              window.__cloudReady.maxAge = Math.max(window.__cloudReady.maxAge, age);
            }
          }
          last = t;
          if (frames.length > 10000) frames.shift();
          // Keep moving live scans in the frustum so the soak actually exercises GPU drawing.
          const impl = tab.renderer.implementation,
            points = impl?.objectManagers.find((e) => e.type === "cloud")?.manager.points;
          if (points) {
            if (!points.geometry.boundingSphere) points.geometry.computeBoundingSphere();
            const center = points.geometry.boundingSphere.center.clone();
            points.localToWorld(center);
            impl.controls.setLookAt(center.x + 14, center.y + 14, center.z + 14, center.x, center.y, center.z, false);
          }
          requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
        window.__cloudFrames = frames;
        return { keys: window.log.getFieldKeys().slice(0, 20), state: tab.controller.saveState() };
      },
      { mode, decay }
    )
  );
  await hub.waitForFunction(
    () =>
      window.tabs.tabList
        .find((t) => t.type === 3)
        ?.renderer.implementation?.objectManagers.some((e) => e.type === "cloud"),
    { timeout: 60000 }
  );
  console.log("machine", os.cpus()[0].model, await app.evaluate(async ({ app }) => await app.getGPUInfo("complete")));
  const sample = () =>
    hub.evaluate(() => {
      const modeKey = () =>
        window.log.getFieldKeys().find((k) => window.log.getStructuredType(k) === "sensor_msgs/PointCloud2");
      const t = window.tabs.tabList.find((t) => t.type === 3),
        impl = t.renderer.implementation,
        render = impl?.renderer;
      const times = window.__cloudFrames.splice(0).sort((a, b) => a - b);
      const entries = impl?.objectManagers.filter((e) => e.type === "cloud") ?? [];
      return {
        presentationAge: { ...window.__cloudReady },
        frameMedianMs: times[Math.floor(times.length * 0.5)],
        frameP95Ms: times[Math.floor(times.length * 0.95)],
        heapBytes: performance.memory?.usedJSHeapSize,
        renderMode: impl?.mode,
        gpu: render?.info.memory,
        upload: window.__cloudPerf,
        scans: entries.length,
        points: entries.reduce((n, e) => n + (e.manager.positions?.length ?? 0) / 3, 0),
        status: [...t.controller.sourceList.itemStatus.values()],
        decodeMs: entries.map((e) => e.manager.decodeMs),
        retainedClouds: window.log.getRaw(modeKey(), -Infinity, Infinity)?.values.length,
        rawBytes: window.log.getRaw(modeKey(), -Infinity, Infinity)?.values.reduce((n, v) => n + v.byteLength, 0),
        sockets: window.__cloudSockets?.map((s) => ({ url: s.url, state: s.readyState })),
        attributeBytes: entries.reduce(
          (n, e) => n + Object.values(e.manager.points.geometry.attributes).reduce((n, a) => n + a.array.byteLength, 0),
          0
        )
      };
    });
  await hub.evaluate((seconds) => {
    window.__cloudReady = { frames: 0, current: 0, held: 0, empty: 0, maxAge: 0 };
    window.__cloudFrames.splice(0);
    window.__cloudMeasureUntil = performance.now() + seconds * 1000;
  }, seconds);
  if (mode === "file" && process.env.CLOUD_PLAYBACK === "1")
    await hub.evaluate(() => {
      window.selection.setSelectedTime(0);
      window.selection.setPlaybackSpeed(8);
      window.selection.setPlaybackLooping(true);
      window.selection.play();
    });
  if (process.env.CLOUD_SATELLITE === "1") {
    const opened = app.waitForEvent("window");
    await hub.evaluate(() => window.tabs.newSatellite());
    const satellite = await opened;
    await satellite.waitForLoadState();
    await satellite.evaluate(() => {
      window.__satFrames = [];
      let last = performance.now();
      function tick(t) {
        window.__satFrames.push(t - last);
        last = t;
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
    app.__satellite = satellite;
  }
  const measurementStart = Date.now();
  while (Date.now() - measurementStart < seconds * 1000) {
    await new Promise((r) =>
      setTimeout(r, Math.min(10000, Math.max(0, seconds * 1000 - (Date.now() - measurementStart))))
    );
    const snapshot = await sample();
    console.log("sample", (Date.now() - measurementStart) / 1000, JSON.stringify(snapshot));
  }
  if (mode === "file") {
    const sets = [];
    for (const time of [2.9, 0.5, 2.9, 1, 2, 2.9]) {
      await hub.evaluate((time) => window.selection.setSelectedTime(time), time);
      await hub.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await hub.waitForFunction(
        () => window.tabs.tabList.find((t) => t.type === 3).controller.spatial.pending.size === 0
      );
      if (time === 2.9)
        sets.push(
          await hub.evaluate(() =>
            window.tabs.tabList
              .find((t) => t.type === 3)
              .renderer.implementation.objectManagers.filter((e) => e.type === "cloud")
              .map((e) => e.cloudId)
              .sort()
          )
        );
    }
    if (!sets.every((set) => JSON.stringify(set) === JSON.stringify(sets[0]))) throw Error("Seek scan sets differ");
    console.log("seek route sets match", JSON.stringify(sets));
    await hub.evaluate(() => {
      const controller = window.tabs.tabList.find((t) => t.type === 3).controller;
      const state = controller.saveState();
      state.sources[0].options.field = "not_a_field";
      controller.restoreState(state);
    });
    await hub.waitForFunction(() =>
      [...window.tabs.tabList.find((t) => t.type === 3).controller.sourceList.itemStatus.values()].some(
        (s) => s.error && s.text.includes("available:")
      )
    );
    await hub.waitForFunction(() =>
      [...window.tabs.tabList.find((t) => t.type === 3).controller.sourceList.LIST.querySelectorAll(".value")].some(
        (e) => e.title.includes("available:")
      )
    );
    const diagnostic = await hub.evaluate(() => {
      const list = window.tabs.tabList.find((t) => t.type === 3).controller.sourceList;
      return [...list.LIST.querySelectorAll(".value")].map((e) => ({ text: e.textContent, title: e.title }));
    });
    if (!diagnostic.some((d) => d.title.includes("available:") && d.title.includes("intensity")))
      throw Error("Missing field diagnostics absent from tooltip");
    console.log("missing-field tooltip", JSON.stringify(diagnostic));
    await hub.screenshot({ path: shots + `/${cli.values.prefix}-missing-colour.png` });
    await hub.evaluate(() => {
      const controller = window.tabs.tabList.find((t) => t.type === 3).controller;
      const state = controller.saveState();
      state.sources[0].options.field = "intensity";
      controller.restoreState(state);
    });
  }
  await hub.waitForFunction(
    () =>
      window.tabs.tabList
        .find((t) => t.type === 3)
        .renderer.implementation.objectManagers.some((e) => e.type === "cloud"),
    { timeout: 60000 }
  );
  await hub.screenshot({ path: shots + `/${cli.values.prefix}-${mode}-decay${decay}.png` });
  if (app.__satellite)
    await app.__satellite.screenshot({ path: shots + `/${cli.values.prefix}-satellite-decay${decay}.png` });
  if (app.__satellite)
    console.log(
      "satellite",
      await app.__satellite.evaluate(() => {
        const f = window.__satFrames.sort((a, b) => a - b);
        return {
          frames: f.length,
          p50: f[Math.floor(f.length * 0.5)],
          p95: f[Math.floor(f.length * 0.95)],
          max: Math.max(...f)
        };
      })
    );
  console.log("final", JSON.stringify(await sample()));
  if (mode === "live" && process.env.CLOUD_LIFECYCLE === "1") {
    const oldArgs = backend.spawnargs.slice(1);
    const exited = new Promise((r) => backend.once("exit", r));
    backend.kill("SIGTERM");
    await exited;
    await freePort(port);
    backend = spawn(process.execPath, oldArgs, { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
    await ready(backend, port);
    await hub.waitForFunction(() => {
      const t = window.log.getRaw("/vehicles/mur27/perception/points", -Infinity, Infinity)?.timestamps.at(-1);
      return t >= 10 && t < 20;
    });
    console.log("backend restart", JSON.stringify(await sample()));
    const rewound = await hub.evaluate(() =>
      window.log.getRaw("/vehicles/mur27/perception/points", -Infinity, Infinity)?.timestamps.at(-1)
    );
    if (!(rewound < 20)) throw Error("Restart left stale cloud clock: " + rewound);
    const stopped = new Promise((r) => backend.once("exit", r));
    backend.kill("SIGTERM");
    await stopped;
    await freePort(rosPort);
    backend = spawn(process.execPath, ["tools/mock-ros.mjs"], {
      cwd: root,
      env: { ...env, ROS_MOCK_PORT: String(rosPort) },
      stdio: ["ignore", "ignore", "inherit"]
    });
    await ready(backend, rosPort);
    await hub.evaluate(() => window.dispatchEvent(new Event("welcome-connect")));
    await hub.locator(".connect-source").selectOption("foxglove");
    await hub.locator(".connect-address").fill(`ws://127.0.0.1:${rosPort}`);
    await hub.getByRole("button", { name: "Connect", exact: true }).click();
    await hub.waitForFunction(() => window.log.getFieldKeys().includes("/lidar/points"));
    await hub.evaluate(() => {
      const controller = window.tabs.tabList.find((t) => t.type === 3).controller;
      const state = controller.saveState();
      state.sources[0].logKey = "/lidar/points";
      controller.restoreState(state);
    });
    await hub.waitForFunction(() =>
      window.tabs.tabList
        .find((t) => t.type === 3)
        .renderer.implementation.objectManagers.some((e) => e.active && e.type === "cloud")
    );
    console.log("source switch", JSON.stringify(await sample()));
    const clean = await hub.evaluate(() => !window.log.getFieldKeys().includes("/vehicles/mur27/perception/points"));
    if (!clean) throw Error("Source switch retained previous cloud topic");
  }
  await hub.evaluate(() => window.tabs.tabList.find((t) => t.type === 3).controller.sourceList.setState([]));
  await hub.waitForFunction(
    () =>
      !window.tabs.tabList
        .find((t) => t.type === 3)
        .renderer.implementation.objectManagers.some((e) => e.type === "cloud")
  );
  console.log("removed", JSON.stringify(await sample()));
} finally {
  await app?.close();
  backend?.kill("SIGTERM");
  await fs.rm(dir, { recursive: true, force: true });
}
