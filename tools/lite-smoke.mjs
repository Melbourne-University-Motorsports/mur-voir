// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const children = [];
let browser;
let tlsProxy;
let tlsDirectory;
function start(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  children.push(child);
  return child;
}
async function ready(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not start: " + url);
}
try {
  if (!process.argv.includes("--skip-build")) {
    const build = start("npm", ["run", "lite-build"]);
    assert.equal((await once(build, "exit"))[0], 0, "Lite build failed");
  }
  const port = Number(process.env.LITE_SMOKE_PORT ?? 15808);
  const mockPort = Number(process.env.LITE_SMOKE_MOCK_PORT ?? 18091);
  start(process.execPath, [
    "tools/mock-backend/src/main.ts",
    "--port",
    String(mockPort),
    "--seed",
    "1",
    "--lap-counter"
  ]);
  await ready(`http://127.0.0.1:${mockPort}/api/v1/catalogue`);
  start(process.execPath, [
    process.env.LITE_SMOKE_SERVER ?? "tools/lite-serve/main.mjs",
    "--port",
    String(port),
    "--backend",
    `http://127.0.0.1:${mockPort}`
  ]);
  await ready(`http://127.0.0.1:${port}`);
  browser = await chromium.launch({ headless: true });
  // LITE_SCREENSHOTS=<dir> saves screenshots there; LITE_COLOR_SCHEME=dark takes them in dark mode.
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    colorScheme: process.env.LITE_COLOR_SCHEME === "dark" ? "dark" : "light"
  });
  /** Saves a screenshot of the page, or of the open popup when `popup` is set. */
  const shot = async (name, popup = false) => {
    if (!process.env.LITE_SCREENSHOTS) return;
    await page.waitForTimeout(500); // let popups and fades settle
    const path = process.env.LITE_SCREENSHOTS + "/" + name + ".png";
    await (popup ? page.locator(".popup-frame").screenshot({ path }) : page.screenshot({ path }));
  };
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  const hub = page.frameLocator(".hub-frame");
  await hub.locator(".connect-source").waitFor({ state: "attached" });
  await hub.locator("body").press("Control+k");
  await hub.locator(".connect-source").selectOption("mur");
  assert.equal(await hub.locator(".connect-address").inputValue(), `http://127.0.0.1:${port}`);
  await hub.locator(".connect-confirm").click();
  await hub.locator(".connect-dialog-backdrop").waitFor({ state: "hidden" });
  const frame = page.frames().find((frame) => frame.url().endsWith("hub.html"));
  // Check that the live connection imports values. The default layout's ENNOID_CellVoltageMin tile
  // re-points from its cellular path to the mock's field by DBC signal name and subscribes to it.
  await frame
    .waitForFunction(() => {
      const key = window.log.getFieldKeys().find((key) => key.endsWith("/cell_voltage_min"));
      return key && window.log.getNumber(key, -Infinity, Infinity)?.values.some(Number.isFinite);
    })
    .catch(async (error) => {
      console.error(await frame.evaluate(() => ({ keys: window.log.getFieldKeys(), text: document.body.innerText })));
      throw error;
    });
  // The sidebar filters fields by text and live state, and a cleared filter shows them all again.
  // Every path starts with "vehicles", so this finds each speed field, including vehicle_speed.
  await hub.locator(".side-bar-search").fill("vehicle_speed");
  const filterTitle = hub.locator(".side-bar-title", { hasText: /^\d+ of \d+ fields/ });
  await filterTitle.waitFor();
  const [shown, total] = (await filterTitle.innerText())
    .match(/^(\d+) of (\d+)/)
    .slice(1)
    .map(Number);
  assert.ok(shown >= 1 && shown < total, `Filter shows ${shown} of ${total} fields`);
  assert.equal(await hub.locator(".field-item-container.filter-match").count(), shown);
  await hub.locator(".side-bar-live-filter").selectOption("not-live");
  await hub.locator(".side-bar-empty").waitFor();
  await hub.locator(".side-bar-live-filter").selectOption("all");
  await hub.locator(".side-bar-search").fill("");
  await hub.locator(".side-bar-title", { hasText: /^\d+ fields/ }).waitFor();
  // A browser with no saved layout opens with the bundled default layout.
  const defaultTitles = ["", "Track day", "Faults", "States", "HV voltage", "Accu temp and current"];
  const tabTitles = () => frame.evaluate(() => window.tabs.saveState().tabs.map((tab) => tab.title));
  assert.deepEqual((await tabTitles()).slice(0, defaultTitles.length), defaultTitles);
  assert.equal((await tabTitles()).length, 10);
  assert.ok(await frame.evaluate(() => window.tabs.saveState().tabs.some((tab) => tab.type === 1)));
  await frame.evaluate(() => window.tabs.setSelected(window.tabs.tabList.findIndex((tab) => tab.type === 1)));
  await hub.locator(".timeline").waitFor({ state: "hidden" });
  const axisMode = hub.locator(".lap-axis-mode:visible");
  for (const mode of ["lapTime", "distance", "time"]) {
    if (mode !== "time") assert.match(await axisMode.locator(`option[value="${mode}"]`).textContent(), /experimental/);
    await axisMode.selectOption(mode);
    assert.equal(await hub.locator(".timeline").isVisible(), false, `Line Graph uses its own timeline in ${mode} mode`);
  }
  await frame.evaluate(() => {
    if (!window.tabs.tabList.some((tab) => tab.type === 13)) window.tabs.addTab(13);
    window.tabs.setSelected(window.tabs.tabList.findIndex((tab) => tab.type === 13));
  });
  await hub.locator(".timeline").waitFor({ state: "visible" });
  await frame.evaluate(() => window.tabs.addTab(15));
  await hub.locator(".timeline").waitFor({ state: "hidden" });
  await frame.evaluate(() => window.tabs.setSelected(window.tabs.tabList.findIndex((tab) => tab.type === 1)));
  await shot("lite_mur");

  await hub.getByText("File", { exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page.getByText("Export Layout…", { exact: true }).click();
  const download = await downloading;
  const layoutPath = await download.path();
  await hub.getByText("File", { exact: true }).click();
  const layoutPicker = page.waitForEvent("filechooser");
  await page.getByText("Import Layout…", { exact: true }).click();
  await (await layoutPicker).setFiles(layoutPath);
  await page.waitForTimeout(500);
  assert.ok(await frame.evaluate(() => window.tabs.saveState().tabs.some((tab) => tab.type === 1)));

  // File > Add Track Day Layout adds the layout's tabs after the open ones.
  const beforeDefault = (await tabTitles()).length;
  await hub.getByText("File", { exact: true }).click();
  await page.getByText("Add Track Day Layout", { exact: true }).click();
  await frame.waitForFunction((count) => window.tabs.saveState().tabs.length === count + 9, beforeDefault);
  assert.equal((await tabTitles())[beforeDefault], "Track day");

  // ?layout=default in a fresh browser loads the layout once and leaves the URL.
  const linkContext = await browser.newContext();
  const linkPage = await linkContext.newPage();
  linkPage.on("pageerror", (error) => errors.push(error.message));
  await linkPage.goto(`http://127.0.0.1:${port}/?layout=default`);
  await linkPage.frameLocator(".hub-frame").locator(".connect-source").waitFor({ state: "attached" });
  const linkFrame = linkPage.frames().find((frame) => frame.url().endsWith("hub.html"));
  await linkFrame.waitForFunction(() => window.tabs.saveState().tabs.some((tab) => tab.title === "Track day"));
  await linkPage.waitForTimeout(500);
  assert.equal(await linkFrame.evaluate(() => window.tabs.saveState().tabs.length), 10);
  assert.equal(new URL(linkPage.url()).searchParams.has("layout"), false);
  // Opening the link again in that browser, with its layout saved (plus a tab of its own), adds nothing.
  await linkFrame.evaluate(() => window.tabs.addTab(15));
  await linkPage.waitForFunction(() =>
    Object.keys(localStorage).some(
      (key) => key.endsWith("/state") && JSON.parse(localStorage.getItem(key)).tabs.tabs.length === 11
    )
  );
  await linkPage.goto(`http://127.0.0.1:${port}/?layout=default`);
  await linkPage.frameLocator(".hub-frame").locator(".connect-source").waitFor({ state: "attached" });
  const reopenedFrame = linkPage.frames().find((frame) => frame.url().endsWith("hub.html"));
  await reopenedFrame.waitForFunction(() => window.tabs.saveState().tabs.length === 11);
  await linkPage.waitForTimeout(500);
  assert.equal(await reopenedFrame.evaluate(() => window.tabs.saveState().tabs.length), 11);
  await linkContext.close();

  // The hosted server forwards the archive API, including Range requests, to the backend.
  const archiveCheck = await frame.evaluate(async () => {
    const list = await fetch("/api/v1/archive/runs?vehicle=mur27&limit=1");
    const range = await fetch("/api/v1/archive/runs/pending_3/file", { headers: { Range: "bytes=10-" } });
    return {
      list: list.status,
      version: (await list.json()).version,
      range: range.status,
      from: range.headers.get("content-range")
    };
  });
  assert.deepEqual([archiveCheck.list, archiveCheck.version, archiveCheck.range], [200, 1, 206]);
  assert.match(archiveCheck.from, /^bytes 10-/);

  // File > Download Runs… lists the mock archive's runs.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://127.0.0.1:${port}` });
  await hub.getByText("File", { exact: true }).click();
  await page.getByText("Download Runs…", { exact: true }).click();
  const runsPopup = page.frameLocator(".popup-frame");
  const rows = runsPopup.locator(".run");
  await rows.first().waitFor();
  assert.equal(await rows.count(), 13);
  const listText = await runsPopup.locator(".runs").innerText();
  for (const text of [
    "Live now",
    "Uploading, 11 of 18 min in",
    "Last 5 min still on the car",
    "Summary not built yet",
    "Parked at Test track pits",
    "tractive system on 2 min",
    "Brake pressure sensor ×2",
    "+1 more",
    "Not dated"
  ]) {
    assert.ok(listText.includes(text), `Download runs shows "${text}"`);
  }
  // Stock file list: an MF4 icon on every row, icon buttons in the control bar.
  assert.equal(await runsPopup.locator('.run img[src="../icons/mf4-icon.png"]').count(), 13);
  for (const id of ["open", "download", "copy-link", "exit"]) {
    assert.equal(await runsPopup.locator(`button#${id} > img`).count(), 1, `#${id} is an icon button`);
  }
  await runsPopup.locator("select.filter").selectOption("parked");
  assert.equal(await rows.count(), 3);
  await runsPopup.locator("select.filter").selectOption("all");
  await shot("lite_runs", true);

  // One ticked run shows its faults in the footer; Open and Copy link need exactly one run.
  const faultRow = rows.filter({ has: runsPopup.locator(".more") });
  await faultRow.click();
  assert.match(await runsPopup.locator(".fault-list").innerText(), /IMD fault, shutdown circuit opened.*16:05, 16:09/s);
  assert.equal(await runsPopup.locator("button#open").isEnabled(), true);
  await shot("lite_runs_faults", true);
  await runsPopup.locator("button#copy-link").click();
  await runsPopup.locator(".alert-text", { hasText: "Link copied" }).waitFor();
  const faultRunName = await faultRow.getAttribute("data-name");
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    `http://127.0.0.1:${port}/?run=${faultRunName}`
  );

  // Download takes any number of runs, one MF4 each; the uploading run answers 202 first.
  const uploadingRow = rows.filter({ hasText: "Uploading, 11 of 18 min in" });
  await uploadingRow.click();
  assert.equal(await runsPopup.locator("button#open").isEnabled(), false);
  assert.equal(await runsPopup.locator("button#copy-link").isEnabled(), false);
  const downloads = [];
  page.on("download", (download) => downloads.push(download));
  await runsPopup.locator('button#download[title="Download 2 runs"]').click();
  await runsPopup.locator(".job.done", { hasText: "Downloaded 2 runs to Downloads" }).waitFor();
  const expectedFiles = [faultRunName, await uploadingRow.getAttribute("data-name")].map((name) => name + ".mf4");
  assert.deepEqual(downloads.map((download) => download.suggestedFilename()).sort(), expectedFiles.sort());
  const mf4 = await readFile(await downloads[0].path());
  assert.deepEqual(mf4, await readFile("test/fixtures/mf4/bus.mf4"));

  // Opening over live telemetry asks first. Stop live and open replaces the log with the run.
  const openRow = rows.filter({ hasText: "13:20" });
  const runName = await openRow.getAttribute("data-name");
  await openRow.dblclick();
  await runsPopup
    .locator(".scrim")
    .waitFor({ state: "visible", timeout: 3000 })
    .catch(async (error) => {
      console.error(await runsPopup.locator("body").innerText(), await frame.evaluate(() => document.title));
      throw error;
    });
  assert.deepEqual(await runsPopup.locator(".dialog-buttons button").allInnerTexts(), [
    "Cancel",
    "Stop live and open",
    "Open in new tab"
  ]);
  await shot("lite_runs_live", true);
  await runsPopup.locator('[data-choice="replace"]').click();
  await page.locator(".popup-frame").waitFor({ state: "hidden" });
  await frame.waitForFunction(() => window.log.getFieldKeys().some((key) => key.includes("INVERTER")));
  await page.waitForFunction((name) => new URL(location.href).searchParams.get("run") === name, runName);
  await shot("lite_run_open");
  await hub.locator(".copy-run-link").click();
  await hub.locator('.copy-run-link img[src="symbols/check.svg"]').waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `http://127.0.0.1:${port}/?run=${runName}`);

  // A ?run= link opens that run in a fresh browser and keeps the parameter.
  const runContext = await browser.newContext();
  const runPage = await runContext.newPage();
  runPage.on("pageerror", (error) => errors.push(error.message));
  await runPage.goto(`http://127.0.0.1:${port}/?run=${runName}`);
  await runPage
    .locator(".popup-frame")
    .waitFor({ state: "hidden", timeout: 20000 })
    .catch(() => {});
  const runFrame = () => runPage.frames().find((frame) => frame.url().endsWith("hub.html"));
  await runPage.waitForFunction(() => document.querySelector(".hub-frame").contentWindow.window.log !== undefined);
  await runFrame().waitForFunction(() => window.log.getFieldKeys().some((key) => key.includes("INVERTER")));
  assert.equal(new URL(runPage.url()).searchParams.get("run"), runName);
  await runPage.frameLocator(".hub-frame").locator(".copy-run-link").waitFor({ state: "visible" });
  await runContext.close();

  const picking = page.waitForEvent("filechooser");
  await hub.locator("body").press("Control+Shift+o");
  const picker = await picking;
  await picker.setFiles({
    name: "smoke.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("time,Speed [m/s]\n0,1\n1,2\n2,3\n")
  });
  await frame.waitForFunction(() => window.log.getFieldKeys().some((key) => key.includes("Speed")));
  assert.deepEqual(errors, [], "Browser errors");

  // Exercise the same TLS termination used by the hosted dashboard.
  tlsDirectory = await mkdtemp(path.join(os.tmpdir(), "mur-voir-lite-tls-"));
  const key = path.join(tlsDirectory, "key.pem");
  const cert = path.join(tlsDirectory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-keyout",
      key,
      "-out",
      cert
    ],
    { stdio: "ignore" }
  );
  tlsProxy = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    const upstream = http.request(
      { hostname: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers },
      (reply) => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      }
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  tlsProxy.on("upgrade", (req, socket, head) => {
    const peer = net.connect(port, "127.0.0.1", () => {
      peer.write(
        `${req.method} ${req.url} HTTP/1.1\r\n${req.rawHeaders.reduce(
          (lines, value, i) => lines + value + (i % 2 ? "\r\n" : ": "),
          ""
        )}\r\n`
      );
      if (head.length) peer.write(head);
      socket.pipe(peer).pipe(socket);
    });
    peer.on("error", () => socket.destroy());
    socket.on("error", () => peer.destroy());
    socket.on("close", () => peer.destroy());
  });
  tlsProxy.listen(0, "127.0.0.1");
  await once(tlsProxy, "listening");
  const secureOrigin = `https://127.0.0.1:${tlsProxy.address().port}`;
  const securePage = await browser.newPage({ ignoreHTTPSErrors: true });
  const secureErrors = [];
  const sockets = [];
  securePage.on("pageerror", (error) => secureErrors.push(error.message));
  securePage.on("console", (message) => {
    if (message.type() === "error") secureErrors.push(message.text());
  });
  securePage.on("websocket", (socket) => sockets.push(socket.url()));
  await securePage.goto(secureOrigin);
  const secureHub = securePage.frameLocator(".hub-frame");
  await secureHub.locator(".connect-source").waitFor({ state: "attached" });
  await secureHub.locator("body").press("Control+k");
  await secureHub.locator(".connect-source").selectOption("mur");
  assert.equal(await secureHub.locator(".connect-address").inputValue(), secureOrigin);
  await secureHub.locator(".connect-confirm").click();
  await secureHub.locator(".connect-dialog-backdrop").waitFor({ state: "hidden" });
  const secureFrame = securePage.frames().find((frame) => frame.url().endsWith("hub.html"));
  await secureFrame.waitForFunction(() => {
    const key = window.log.getFieldKeys().find((key) => key.endsWith("/cell_voltage_min"));
    return key && window.log.getNumber(key, -Infinity, Infinity)?.values.some(Number.isFinite);
  });
  const secureFetch = await secureFrame.evaluate(async () => {
    const response = await fetch("/api/v1/catalogue");
    return { status: response.status, signals: (await response.json()).signals.length };
  });
  assert.equal(secureFetch.status, 200);
  assert.ok(secureFetch.signals > 0);
  assert.ok(sockets.includes(secureOrigin.replace("https:", "wss:") + "/api/v1/live"));
  assert.deepEqual(secureErrors, [], "HTTPS browser errors");
  console.log(
    "Lite smoke passed: same-host MUR HTTP/WS and HTTPS/WSS, live value, sidebar filter, graph, shared timeline, experimental lap modes, layout download/upload, default layout on first open, from the menu and from ?layout=, Download runs (list, filters, faults, 202, downloads, open over live, links, ?run=), CSV picker."
  );
} finally {
  await browser?.close();
  tlsProxy?.closeAllConnections();
  if (tlsProxy) await new Promise((resolve) => tlsProxy.close(resolve));
  if (tlsDirectory) await rm(tlsDirectory, { recursive: true, force: true });
  for (const child of children.reverse()) if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.all(children.filter((child) => child.exitCode === null).map((child) => once(child, "exit")));
}
