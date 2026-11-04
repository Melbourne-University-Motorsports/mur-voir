// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// Real Electron, real importer/source, real renderer. Run after npm run compile.
// node tools/perf/cloud-electron.mjs [file|live] [seconds=180] [decay=1]
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { _electron } from "playwright";
const mode = process.argv[2] ?? "file",
  seconds = Number(process.argv[3] ?? 180),
  decay = process.argv[4] ?? "1";
const root = process.cwd(),
  dir = "/tmp/mur-point-clouds/profile-" + Date.now();
const shots = "/Users/jasper/code/telemetry-dashboard/research/mur-voir/screenshots/point-clouds";
await fs.mkdir(dir, { recursive: true });
await fs.mkdir(shots, { recursive: true });
await fs.writeFile(dir + "/beta-2027.json", JSON.stringify({ welcomeComplete: true, surveyTime: Date.now() + 1e12 }));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app, backend;
try {
  if (mode === "ros") {
    backend = spawn(process.execPath, ["tools/mock-ros.mjs"], {
      cwd: root,
      env: { ...env, ROS_MOCK_PORT: "18094", ROS_MOCK_RESET: "1" },
      stdio: "ignore"
    });
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (mode === "live") {
    backend = spawn(
      process.execPath,
      [
        "tools/mock-backend/src/main.ts",
        "--port",
        "18093",
        "--point-cloud",
        "--point-cloud-points",
        "300000",
        "--point-cloud-hz",
        "10",
        "--sim-clock"
      ],
      { cwd: root, stdio: "ignore" }
    );
    await new Promise((r) => setTimeout(r, 1500));
  }
  app = await _electron.launch({
    executablePath: root + "/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    args: [
      "bundles/main.js",
      "--enable-precise-memory-info",
      "--user-data-dir=" + dir,
      ...(mode === "file" ? ["/tmp/mur-point-clouds/reference.mcap"] : [])
    ],
    cwd: root,
    env
  });
  await new Promise((r) => setTimeout(r, 5000));
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows())
      if (w.webContents.getURL().includes("betaWelcome")) w.close();
      else if (w.webContents.getURL().endsWith("hub.html")) w.setContentSize(1440, 960);
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
    await hub.locator(".connect-address").fill(mode === "ros" ? "ws://127.0.0.1:18094" : "http://127.0.0.1:18093");
    await hub.getByRole("button", { name: "Connect", exact: true }).click();
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(
    "setup",
    await hub.evaluate(
      ({ mode, decay }) => {
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
        let last = performance.now();
        function tick(t) {
          frames.push(t - last);
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
        frameMedianMs: times[Math.floor(times.length * 0.5)],
        frameP95Ms: times[Math.floor(times.length * 0.95)],
        heapBytes: performance.memory?.usedJSHeapSize,
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
  for (let elapsed = 0; elapsed < seconds; elapsed += 10) {
    console.log("sample", elapsed, JSON.stringify(await sample()));
    await new Promise((r) => setTimeout(r, Math.min(10, seconds - elapsed) * 1000));
  }
  await hub.screenshot({ path: shots + `/r1-${mode}-decay${decay}.png` });
  console.log("final", JSON.stringify(await sample()));
  await hub.evaluate(() => window.tabs.tabList.find((t) => t.type === 3).controller.sourceList.setState([]));
  await new Promise((r) => setTimeout(r, 2000));
  console.log("removed", JSON.stringify(await sample()));
} finally {
  await app?.close();
  backend?.kill("SIGTERM");
  await fs.rm(dir, { recursive: true, force: true });
}
