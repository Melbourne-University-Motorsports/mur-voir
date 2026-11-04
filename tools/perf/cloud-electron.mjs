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
import { freePort, options, ready } from "./cloud-process.mjs";
const cli = options();
const mode = cli.positionals[0] ?? "file",
  seconds = Number(cli.positionals[1] ?? 180),
  decay = cli.positionals[2] ?? "1";
const port = Number(cli.values.port),
  rosPort = port + 1;
if (mode === "file" && !cli.values.input) throw Error("file mode requires --input path/to/cloud.mcap");
await fs.mkdir("/tmp/mur-point-clouds/r2", { recursive: true });
const root = process.cwd(),
  dir = await fs.mkdtemp("/tmp/mur-point-clouds/r2/profile-"),
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
  await new Promise((r) => setTimeout(r, 5000));
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
        .locator("dialog")
        .innerText()
        .catch(() => hub.locator("body").innerText())
    );
    await hub
      .locator("select")
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
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(
    "setup",
    await hub.evaluate(
      ({ mode, decay }) => {
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
        window.__cloudReady = { frames: 0, ready: 0 };
        let last = performance.now();
        function tick(t) {
          frames.push(t - last);
          window.__cloudReady.frames++;
          if (
            tab.renderer.implementation?.objectManagers.some((e) => e.type === "cloud" && e.manager.positions?.length)
          )
            window.__cloudReady.ready++;
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
  await new Promise((r) => setTimeout(r, 5000));
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
        readiness: { ...window.__cloudReady },
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
  await hub.evaluate(() => {
    window.__cloudReady = { frames: 0, ready: 0 };
    window.__cloudFrames.splice(0);
  });
  for (let elapsed = 0; elapsed < seconds; elapsed += 10) {
    console.log("sample", elapsed, JSON.stringify(await sample()));
    await new Promise((r) => setTimeout(r, Math.min(10, seconds - elapsed) * 1000));
  }
  if (mode === "file") {
    const sets = [];
    for (const time of [2.9, 0.5, 2.9, 1, 2, 2.9]) {
      await hub.evaluate((time) => window.selection.setSelectedTime(time), time);
      await new Promise((r) => setTimeout(r, 1000));
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
  }
  await hub.waitForFunction(
    () =>
      window.tabs.tabList
        .find((t) => t.type === 3)
        .renderer.implementation.objectManagers.some((e) => e.type === "cloud"),
    { timeout: 60000 }
  );
  await hub.screenshot({ path: shots + `/${cli.values.prefix}-${mode}-decay${decay}.png` });
  console.log("final", JSON.stringify(await sample()));
  if (mode === "live" && process.env.CLOUD_LIFECYCLE === "1") {
    const oldArgs = backend.spawnargs.slice(1);
    backend.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 2000));
    backend = spawn(process.execPath, oldArgs, { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
    await new Promise((r) => setTimeout(r, 12000));
    console.log("backend restart", JSON.stringify(await sample()));
    const rewound = await hub.evaluate(() =>
      window.log.getRaw("/vehicles/mur27/perception/points", -Infinity, Infinity)?.timestamps.at(-1)
    );
    if (!(rewound < 20)) throw Error("Restart left stale cloud clock: " + rewound);
    backend.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    backend = spawn(process.execPath, ["tools/mock-ros.mjs"], {
      cwd: root,
      env: { ...env, ROS_MOCK_PORT: String(rosPort) },
      stdio: ["ignore", "ignore", "inherit"]
    });
    await new Promise((r) => setTimeout(r, 1000));
    await hub.evaluate(() => window.dispatchEvent(new Event("welcome-connect")));
    await hub.locator(".connect-source").selectOption("foxglove");
    await hub.locator(".connect-address").fill(`ws://127.0.0.1:${rosPort}`);
    await hub.getByRole("button", { name: "Connect", exact: true }).click();
    await new Promise((r) => setTimeout(r, 5000));
    await hub.evaluate(() => {
      const controller = window.tabs.tabList.find((t) => t.type === 3).controller;
      const state = controller.saveState();
      state.sources[0].logKey = "/lidar/points";
      controller.restoreState(state);
    });
    await new Promise((r) => setTimeout(r, 3000));
    console.log("source switch", JSON.stringify(await sample()));
    const clean = await hub.evaluate(() => !window.log.getFieldKeys().includes("/vehicles/mur27/perception/points"));
    if (!clean) throw Error("Source switch retained previous cloud topic");
  }
  await hub.evaluate(() => window.tabs.tabList.find((t) => t.type === 3).controller.sourceList.setState([]));
  await new Promise((r) => setTimeout(r, 2000));
  console.log("removed", JSON.stringify(await sample()));
} finally {
  await app?.close();
  backend?.kill("SIGTERM");
  await fs.rm(dir, { recursive: true, force: true });
}
