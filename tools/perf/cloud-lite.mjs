// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { freePort, options, ready } from "./cloud-process.mjs";
const cli = options(),
  port = Number(cli.values.port),
  litePort = Number(cli.values["lite-port"]);
await fs.mkdir(cli.values.output, { recursive: true });
let browser;
const children = [];
try {
  await freePort(port);
  await freePort(litePort);
  children.push(
    spawn(
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
      { stdio: ["ignore", "ignore", "inherit"] }
    )
  );
  await ready(children[0], port);
  children.push(
    spawn(
      process.execPath,
      ["tools/lite-serve/main.mjs", "--port", String(litePort), "--backend", `http://127.0.0.1:${port}`],
      {
        stdio: ["ignore", "ignore", "inherit"]
      }
    )
  );
  await ready(children[1], litePort);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.goto(`http://127.0.0.1:${litePort}`);
  const hub = page.frameLocator(".hub-frame");
  await hub.locator(".connect-source").waitFor({ state: "attached" });
  const frame = page.frames().find((f) => f.url().endsWith("hub.html"));
  await frame.evaluate(() => window.dispatchEvent(new Event("welcome-connect")));
  await hub.locator(".connect-source").selectOption("mur");
  await hub.locator(".connect-address").fill(`http://127.0.0.1:${litePort}`);
  await hub.locator(".connect-confirm").click();
  await frame.waitForFunction(() => window.log.getFieldKeys().includes("/vehicles/mur27/perception/points"));
  await frame.evaluate(() => {
    window.preferences.field3dModeAc = "standard";
    window.preferences.field3dModeBattery = "standard";
    const tabs = window.tabs,
      tab = tabs.tabList.find((t) => t.type === 3);
    tabs.selectedTab = tabs.tabList.indexOf(tab);
    tabs.updateElements();
    tab.controller.restoreState({
      game: "MUR:Grid",
      fixedFrame: "map",
      sources: [
        {
          type: "spatial",
          logKey: "/vehicles/mur27/perception/points",
          logType: "sensor_msgs/PointCloud2",
          visible: true,
          options: { field: "intensity", decay: "1", size: "3", map: "turbo" }
        }
      ]
    });
  });
  await frame.evaluate(() => {
    function follow() {
      const impl = window.tabs.tabList.find((t) => t.type === 3)?.renderer.implementation,
        points = impl?.objectManagers.find((e) => e.type === "cloud")?.manager.points;
      if (points) {
        if (!points.geometry.boundingSphere) points.geometry.computeBoundingSphere();
        const c = points.geometry.boundingSphere.center.clone();
        points.localToWorld(c);
        impl.controls.setLookAt(c.x + 14, c.y + 14, c.z + 14, c.x, c.y, c.z, false);
      }
      requestAnimationFrame(follow);
    }
    follow();
  });
  await frame.waitForFunction(
    () =>
      window.tabs.tabList
        .find((t) => t.type === 3)
        ?.renderer.implementation?.objectManagers.some(
          (e) => e.type === "cloud" && e.manager.positions.length === 900000
        ) && window.tabs.tabList.find((t) => t.type === 3).renderer.implementation.renderer.info.memory.textures > 0,
    { timeout: 60000 }
  );
  console.log(
    "Lite cloud worker decoded 300000 points",
    await frame.evaluate(() => {
      const impl = window.tabs.tabList.find((t) => t.type === 3).renderer.implementation,
        gl = impl.renderer.getContext(),
        debug = gl.getExtension("WEBGL_debug_renderer_info");
      return { renderer: debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL), memory: impl.renderer.info.memory };
    })
  );
  await page.waitForTimeout(2000);
  await page.screenshot({
    path: cli.values.output + "/" + cli.values.prefix + "-lite-cloud.png"
  });
} finally {
  await browser?.close();
  for (const c of children) c.kill("SIGTERM");
}
