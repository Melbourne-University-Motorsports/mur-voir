// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// Hidden Electron windows never present to the screen. They omit real screen paint and GPU raster,
// so GPU cost is understated even when Chromium records renderer compositor commits.
// CPU and CDP Performance metrics are sampled before tracing to keep trace overhead out of them.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { _electron } from "playwright";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_STATE = "src/shared/layouts/default.json";
const HUB_SIZE = { width: 1100, height: 650 };
const DOCUMENTATION = 0;
const TRACKSIDE = 15;
const LOGICAL_CPUS = os.cpus().length;
const SCENARIOS = ["idle", "live-docs", "live-docs-only", "tabs", "satellite", "two-hubs"];
const MOCK_ARGS = ["--port", "0", "--host", "127.0.0.1", "--seed", "1", "--lap-counter"];
const DURATIONS = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"];
const COUNTS = ["LayoutCount", "RecalcStyleCount"];
const GAUGES = ["JSHeapUsedSize", "Nodes"];
const HELP = `Usage: npm run perf -- [options]
       npm run perf -- --compare <before.json> <after.json>

  --scenario <id>    repeatable, defaults to the suite below
  --state <file>     saved application state or layout JSON (default bundled Track Day)
  --repeats <n>      runs per scenario (default 3)
  --warmup <s>       seconds after setup (default 1)
  --seconds <s>      CPU and Performance sampling window (default 5.1)
  --trace <s>        separate tracing window (default 0.7)
  --mock-speed <x>   mock simulation speed (default 1)
  --out <file>       output JSON (default .screenshots/perf-bench.json)
  --no-build         reuse current desktop bundles
  -h, --help

  idle             disconnected Documentation with the full layout
  live-docs        live Documentation with the full layout
  live-docs-only   live Documentation with other tabs removed
  tabs             live with each other restored tab selected, one run per tab
  tab-<index>      select one restored tab by its zero-based index
  satellite        live Trackside in a hub and a satellite
  two-hubs         two live hubs with Trackside selected in both`;

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    scenario: { type: "string", multiple: true },
    state: { type: "string" },
    repeats: { type: "string", default: "3" },
    warmup: { type: "string", default: "1" },
    seconds: { type: "string", default: "5.1" },
    trace: { type: "string", default: "0.7" },
    "mock-speed": { type: "string", default: "1" },
    out: { type: "string", default: ".screenshots/perf-bench.json" },
    "no-build": { type: "boolean" },
    compare: { type: "string" },
    help: { type: "boolean", short: "h" }
  }
});

function numberOption(key, min, integer = false) {
  const value = Number(options[key]);
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw new Error(`--${key} must be ${integer ? "an integer" : "a number"} at least ${min}`);
  }
  return value;
}

async function withApp(states, findings, run) {
  const userData = await mkdtemp(path.join(os.tmpdir(), "mur-voir-perf-"));
  let app;
  try {
    const hubs = states.map((state, index) => ({ x: index * 30, y: 40, ...HUB_SIZE, state }));
    await writeFile(path.join(userData, "state-dev.json"), JSON.stringify({ hubs, satellites: [] }));
    await writeFile(path.join(userData, "prefs.json"), JSON.stringify({ theme: "dark" }));
    const env = { ...process.env, MURVOIR_HEADLESS: "1", MURVOIR_USER_DATA: userData };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      args: ["--force-device-scale-factor=1", "bundles/main.js"],
      cwd: ROOT,
      env,
      timeout: 15000
    });

    const finding = (line) => {
      findings.push(line);
      console.error(line);
    };
    for (const stream of [app.process().stdout, app.process().stderr]) {
      createInterface({ input: stream }).on("line", (line) => {
        if (line.startsWith("[headless] suppressed")) finding(line);
      });
    }
    const watch = (page) => {
      page.on("pageerror", (error) => finding(`[renderer error] ${error.message}`));
    };
    app.on("window", watch);
    app.windows().forEach(watch);
    const pages = await waitForWindows(app, "hub", states.length);
    await Promise.all(
      pages.map(async (page) => {
        await page.waitForFunction(() => window.messagePort && window.preferences && window.tabs, null, {
          polling: 50
        });
        await page.emulateMedia({ colorScheme: "dark" });
      })
    );
    return await run(app, pages);
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  }
}

async function waitForWindows(app, name, count) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const pages = app.windows().filter((page) => page.url().endsWith(`/${name}.html`));
    if (pages.length === count) {
      pages.forEach((page) => page.setDefaultTimeout(10000));
      return pages;
    }
    await delay(50);
  }
  throw new Error(`Expected ${count} ${name} window(s)`);
}

async function withMock(live, mockArgs, run) {
  if (!live) return run();
  const mock = spawn(process.execPath, ["tools/mock-backend/src/main.ts", ...mockArgs], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"]
  });
  const lines = createInterface({ input: mock.stdout });
  const port = new Promise((resolve, reject) => {
    lines.on("line", (line) => {
      const match = /^mock backend: http:\/\/localhost:(\d+)\/api\/v1\/catalogue/.exec(line);
      if (match) resolve(Number(match[1]));
    });
    mock.once("error", reject);
    mock.once("exit", (code, signal) => reject(new Error(`Mock backend exited (${code ?? signal})`)));
  });
  const timeout = setTimeout(() => mock.kill("SIGKILL"), 10000);
  try {
    const address = `http://127.0.0.1:${await port}`;
    clearTimeout(timeout);
    const result = await run(address);
    if (mock.exitCode !== null || mock.signalCode !== null) throw new Error("Mock backend stopped during the run");
    return result;
  } finally {
    clearTimeout(timeout);
    lines.close();
    if (mock.pid && mock.exitCode === null && mock.signalCode === null) {
      const exited = once(mock, "exit");
      mock.kill("SIGTERM");
      const force = setTimeout(() => mock.kill("SIGKILL"), 2000);
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
    }
  }
}

async function connect(page, address) {
  await page.evaluate(() => window.messagePort.onmessage({ data: { name: "show-connect-dialog" } }));
  await page.locator(".connect-source").selectOption("mur");
  await page.locator(".connect-address").fill(address);
  await page.locator(".connect-confirm").click();
  await page.locator(".connect-dialog-backdrop").waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => {
      const status = window.liveStatus?.getLiveStatus();
      return status?.backend === "connected" && status.hasFreshData;
    },
    null,
    { polling: 50 }
  );
}

async function selectTab(page, uuid) {
  await page.evaluate((uuid) => {
    const index = window.tabs.saveState().tabs.findIndex((tab) => tab.controllerUUID === uuid);
    if (index < 0) throw new Error(`The selected tab did not restore (${uuid})`);
    window.tabs.setSelected(index);
  }, uuid);
}

async function prepare(app, hubs, scenario, address) {
  const windows = await Promise.all(
    hubs.map(async (page, index) => {
      const browserWindow = await app.browserWindow(page);
      await browserWindow.evaluate((window, size) => window.setContentSize(size.width, size.height), HUB_SIZE);
      await selectTab(page, scenario.uuid);
      return { id: `hub-${index + 1}`, page, browserWindow };
    })
  );
  if (address) await Promise.all(hubs.map((hub) => connect(hub, address)));
  if (scenario.id === "satellite") {
    await hubs[0].evaluate(() => window.tabs.newSatellite());
    const [page] = await waitForWindows(app, "satellite", 1);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(
      () => !document.getElementById("renderer15")?.hidden && document.title.includes(" — mur-voir"),
      null,
      { polling: 50 }
    );
    windows.push({ id: "satellite", page, browserWindow: await app.browserWindow(page) });
  }

  for (const window of windows) {
    window.pid = await window.browserWindow.evaluate((win) => win.webContents.getOSProcessId());
    window.cdp = await window.page.context().newCDPSession(window.page);
    await window.cdp.send("Performance.enable", { timeDomain: "timeTicks" });
    if (window.id.startsWith("hub-")) {
      // Count only actual app MessagePort sends. Skip payload traversal and all main-to-hub traffic.
      await window.page.evaluate(() => {
        const port = window.messagePort;
        const original = port.postMessage;
        const counts = Object.create(null);
        port.postMessage = function (message, ...rest) {
          original.call(this, message, ...rest);
          counts[message.name] = (counts[message.name] ?? 0) + 1;
        };
        window.perfBenchIpc = counts;
      });
    }
  }
  if (new Set(windows.map((window) => window.pid)).size !== windows.length) {
    throw new Error("Windows share a renderer process, so PID-based frame counts cannot be attributed to windows");
  }
  return windows;
}

async function processSample(app) {
  return app.evaluate(({ app }) => ({
    ms: Number(process.hrtime.bigint()) / 1e6,
    processes: app.getAppMetrics().map(({ pid, type, cpu }) => ({ pid, type, ...cpu }))
  }));
}

function processMetrics(samples) {
  const total = { percentCPUUsage: 0, coreCPUPercent: 0, idleWakeupsPerSecond: 0 };
  const pids = {};
  const types = {};
  const wallMs = samples.at(-1).ms - samples[0].ms;
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1];
    const sample = samples[i];
    const interval = sample.ms - previous.ms;
    const previousByPid = new Map(previous.processes.map((process) => [process.pid, process]));
    for (const process of sample.processes) {
      const before = previousByPid.get(process.pid);
      if (!before) continue; // No usable interval yet for a newly started process.
      const weight = interval / wallMs;
      const coreCPUPercent =
        process.cumulativeCPUUsage === undefined || before.cumulativeCPUUsage === undefined
          ? process.percentCPUUsage * LOGICAL_CPUS
          : (100_000 * (process.cumulativeCPUUsage - before.cumulativeCPUUsage)) / interval;
      for (const bucket of [
        total,
        (types[process.type] ??= { ...totalZero }),
        (pids[process.pid] ??= { ...totalZero })
      ]) {
        bucket.percentCPUUsage += process.percentCPUUsage * weight;
        bucket.coreCPUPercent += coreCPUPercent * weight;
        bucket.idleWakeupsPerSecond += process.idleWakeupsPerSecond * weight;
      }
    }
  }
  return { seconds: wallMs / 1000, total, types, pids };
}

const totalZero = { percentCPUUsage: 0, coreCPUPercent: 0, idleWakeupsPerSecond: 0 };

async function cdpMetrics(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
}

async function snapshot({ id, cdp, page }, live) {
  const metrics = await cdpMetrics(cdp);
  if (id === "satellite") return { metrics };
  const hub = await page.evaluate((live) => {
    const connection = live ? window.liveStatus?.getLiveStatus() : null;
    return {
      ms: performance.now(),
      ipc: { ...window.perfBenchIpc },
      live: connection?.backend === "connected" && connection.hasFreshData,
      logEnd: window.log.getTimestampRange()[1]
    };
  }, live);
  if (live && !hub.live) throw new Error(`${id} is no longer receiving live data`);
  return { metrics, hub };
}

function windowMetrics(start, end) {
  const seconds = end.metrics.Timestamp - start.metrics.Timestamp;
  const performanceMetrics = {};
  for (const metric of [...DURATIONS, ...COUNTS]) {
    const unit = DURATIONS.includes(metric) ? "MsPerSecond" : "PerSecond";
    const multiplier = DURATIONS.includes(metric) ? 1000 : 1;
    performanceMetrics[metric + unit] = ((end.metrics[metric] - start.metrics[metric]) / seconds) * multiplier;
  }
  for (const metric of GAUGES) performanceMetrics[metric] = end.metrics[metric];
  if (!Object.values(performanceMetrics).every(Number.isFinite)) throw new Error("CDP Performance metrics are missing");

  if (!end.hub) return { seconds, performance: performanceMetrics };
  const ipcSeconds = (end.hub.ms - start.hub.ms) / 1000;
  const ipc = Object.fromEntries(
    Object.entries(end.hub.ipc).map(([name, count]) => [name, (count - (start.hub.ipc[name] ?? 0)) / ipcSeconds])
  );
  return {
    seconds,
    performance: performanceMetrics,
    hubToMainPerSecond: Object.values(ipc).reduce((sum, rate) => sum + rate, 0),
    ipcByMessagePerSecond: ipc,
    logTimeAdvancedSeconds: end.hub.logEnd - start.hub.logEnd
  };
}

async function traceWindows(windows, seconds) {
  const cdp = windows[0].cdp;
  await cdp.send("Tracing.start", {
    traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] },
    transferMode: "ReturnAsStream"
  });
  const start = await Promise.all(windows.map((window) => cdpMetrics(window.cdp)));
  await delay(seconds * 1000);
  const end = await Promise.all(windows.map((window) => cdpMetrics(window.cdp)));
  const [[{ stream, dataLossOccurred }]] = await Promise.all([
    once(cdp, "Tracing.tracingComplete", { signal: AbortSignal.timeout(10000) }),
    cdp.send("Tracing.end")
  ]);
  if (!stream || dataLossOccurred) throw new Error("CDP tracing did not return a complete stream");
  const chunks = [];
  try {
    for (;;) {
      const { data, eof, base64Encoded } = await cdp.send("IO.read", { handle: stream });
      chunks.push(Buffer.from(data, base64Encoded ? "base64" : "utf8"));
      if (eof) break;
    }
  } finally {
    await cdp.send("IO.close", { handle: stream });
  }
  const { traceEvents } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return windows.map(({ pid }, index) => {
    const thread = traceEvents.find(
      (event) => event.pid === pid && event.name === "thread_name" && event.args.name === "CrRendererMain"
    );
    if (!thread) throw new Error(`Trace did not identify CrRendererMain for PID ${pid}`);
    const from = start[index].Timestamp * 1e6;
    const to = end[index].Timestamp * 1e6;
    const duration = (to - from) / 1e6;
    let callbacks = 0;
    let frames = 0;
    let commits = 0;
    for (const { pid: eventPid, tid, ts, name, ph } of traceEvents) {
      if (eventPid !== pid || tid !== thread.tid || ts < from || ts >= to) continue;
      if (name === "FireAnimationFrame" && (ph === "X" || ph === "B")) callbacks++;
      if (name === "AnimationFrame::Render" && ph === "b") frames++;
      if (name === "Commit" && (ph === "X" || ph === "B")) commits++;
    }
    return {
      seconds: duration,
      callbackCount: callbacks,
      renderFrameCount: frames,
      commitCount: commits,
      callbacksPerSecond: callbacks / duration,
      renderFramesPerSecond: frames / duration,
      callbacksPerRenderFrame: frames > 0 ? callbacks / frames : null,
      commitsPerSecond: commits / duration
    };
  });
}

async function measure(app, windows, address, config) {
  await delay(config.warmup * 1000);
  const start = await Promise.all(windows.map((window) => snapshot(window, !!address)));
  const samples = [await processSample(app)];
  const deadline = performance.now() + config.seconds * 1000;
  let nextSample = performance.now() + 1000;
  while (nextSample < deadline - 300) {
    await delay(Math.max(0, nextSample - performance.now()));
    samples.push(await processSample(app));
    nextSample += 1000;
  }
  await delay(Math.max(0, deadline - performance.now()));
  samples.push(await processSample(app));
  const end = await Promise.all(windows.map((window) => snapshot(window, !!address)));
  const cpu = processMetrics(samples);
  const trace = await traceWindows(windows, config.trace);
  return {
    cpu: { seconds: cpu.seconds, total: cpu.total, types: cpu.types, samples },
    windows: Object.fromEntries(
      windows.map(({ id, pid }, i) => {
        if (!cpu.pids[pid]) throw new Error(`No CPU samples for ${id} (PID ${pid})`);
        return [id, { pid, cpu: cpu.pids[pid], ...windowMetrics(start[i], end[i]), trace: trace[i] }];
      })
    )
  };
}

function readHubState(data) {
  const firstHub = data?.hubs?.[0] ?? data;
  const state = firstHub?.state ?? firstHub;
  if (!Array.isArray(state?.tabs?.tabs) || !state.sidebar) {
    throw new Error("Expected a saved state with a hub, sidebar, and tabs");
  }
  return state;
}

async function plan(state, template, requested, findings) {
  const tabs = state.tabs.tabs.map((tab, i) => ({
    ...tab,
    controllerUUID: tab.controllerUUID ?? `perf-tab-${i}`
  }));
  if (!tabs.some((tab) => tab.type === DOCUMENTATION)) {
    tabs.unshift({ ...template.tabs.tabs[0], controllerUUID: "perf-documentation" });
  }
  const layout = { ...state, tabs: { selected: 0, tabs } };
  const restored = await withApp([layout], findings, (_app, [hub]) =>
    hub.evaluate(() => {
      const labels = [...document.querySelectorAll(".tab-bar > .tab")];
      return window.tabs.saveState().tabs.map(({ type, controllerUUID }, i) => ({
        type,
        uuid: controllerUUID,
        title: labels[i]?.innerText.replace(/^\S+\s+/, "").trim() || (type === 0 ? "Documentation" : `Tab ${i}`)
      }));
    })
  );
  const docs = restored.find((tab) => tab.type === DOCUMENTATION);
  if (!docs) throw new Error("The Documentation tab did not restore");
  const onlyDocs = { ...layout, tabs: { selected: 0, tabs: tabs.filter((tab) => tab.controllerUUID === docs.uuid) } };
  const trackside = restored.find((tab) => tab.type === TRACKSIDE);
  const fallback = {
    ...template.tabs.tabs.find((tab) => tab.type === TRACKSIDE),
    controllerUUID: "perf-trackside"
  };
  const tracksideLayout = trackside ? layout : { ...layout, tabs: { ...layout.tabs, tabs: [...tabs, fallback] } };
  const tracksideUuid = trackside?.uuid ?? fallback.controllerUUID;
  const scenarios = [
    { id: "idle", label: "Idle / Documentation", uuid: docs.uuid, states: [layout] },
    { id: "live-docs", label: "Live / Documentation", uuid: docs.uuid, states: [layout], live: true },
    { id: "live-docs-only", label: "Live / Documentation only", uuid: docs.uuid, states: [onlyDocs], live: true },
    ...restored.flatMap((tab, index) =>
      tab.uuid === docs.uuid
        ? []
        : [{ id: `tab-${index}`, label: `Live / ${tab.title}`, uuid: tab.uuid, states: [layout], live: true }]
    ),
    {
      id: "satellite",
      label: `Live / ${trackside?.title ?? "Track day"} + satellite`,
      uuid: tracksideUuid,
      states: [tracksideLayout],
      live: true
    },
    {
      id: "two-hubs",
      label: `Live / ${trackside?.title ?? "Track day"} × 2 hubs`,
      uuid: tracksideUuid,
      states: [tracksideLayout, tracksideLayout],
      live: true
    }
  ];
  const docsIndex = restored.indexOf(docs);
  const ids = new Set(
    requested.flatMap((id) => {
      if (id === "tabs")
        return ["live-docs", ...scenarios.filter(({ id }) => id.startsWith("tab-")).map(({ id }) => id)];
      if (id === `tab-${docsIndex}`) return ["live-docs"];
      if (!scenarios.some((scenario) => scenario.id === id)) throw new Error(`Unknown scenario: ${id}`);
      return [id];
    })
  );
  return {
    tabs: restored,
    tracksideControl: trackside ? `tab-${restored.indexOf(trackside)}` : null,
    scenarios: scenarios
      .filter(({ id }) => ids.has(id))
      .map((scenario) => ({
        ...scenario,
        states: scenario.states.map((state) => ({
          ...state,
          tabs: {
            ...state.tabs,
            selected: state.tabs.tabs.findIndex((tab) => tab.controllerUUID === scenario.uuid)
          }
        }))
      }))
  };
}

function flatten(value, prefix = "") {
  if (typeof value === "number") return [[prefix, value]];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key));
}

function stats(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { median, min: sorted[0], max: sorted.at(-1) };
}

function summarize(runs) {
  const samples = runs.map(({ cpu, windows }) =>
    Object.fromEntries(
      flatten({
        cpu: { total: cpu.total, types: cpu.types },
        windows: Object.fromEntries(Object.entries(windows).map(([id, { pid, ...window }]) => [id, window]))
      })
    )
  );
  return Object.fromEntries(
    [...new Set(samples.flatMap(Object.keys))].map((key) => [
      key,
      stats(
        samples.flatMap((sample) => {
          if (key in sample) return [sample[key]];
          // A type or named message absent in a run contributed zero in that run.
          return /^(cpu\.types\.)|\.ipcByMessagePerSecond\./.test(key) ? [0] : [];
        })
      )
    ])
  );
}

const TOTAL = "cpu.total.";
const IPC = "ipcByMessagePerSecond.update-satellite";
const TASK = "performance.TaskDurationMsPerSecond";
const tableLabel = (label) => label.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
const value = (n, digits) => n.toFixed(digits);
function range(stat, digits = 1) {
  if (!stat) return "—";
  return `${value(stat.median, digits)} [${value(stat.min, digits)}–${value(stat.max, digits)}]`;
}

function printTable(results, format = (scenario, key, digits) => range(scenario.summary[key], digits)) {
  const cpuTypes = [
    ...new Set(
      results.flatMap(({ summary }) =>
        Object.keys(summary).flatMap((key) => (key.startsWith("cpu.types.") ? [key.split(".")[2]] : []))
      )
    )
  ].sort();
  const overview = [
    ["App CPU, % of one core", TOTAL + "coreCPUPercent"],
    ["Electron CPU, %", TOTAL + "percentCPUUsage", 2],
    ["Wakeups/s", TOTAL + "idleWakeupsPerSecond"],
    ...cpuTypes.map((type) => [`${type} CPU, % of one core`, `cpu.types.${type}.coreCPUPercent`])
  ];
  const renderer = [
    ["CPU, % of one core", "cpu.coreCPUPercent"],
    ["Task, ms/s", TASK],
    ["Script, ms/s", "performance.ScriptDurationMsPerSecond"],
    ["Layout, ms/s", "performance.LayoutDurationMsPerSecond"],
    ["Style, ms/s", "performance.RecalcStyleDurationMsPerSecond"],
    ["Layouts/s", "performance.LayoutCountPerSecond"],
    ["Style recalcs/s", "performance.RecalcStyleCountPerSecond"],
    ["Heap, bytes", "performance.JSHeapUsedSize", 0],
    ["Nodes", "performance.Nodes", 0],
    ["rAF/s", "trace.callbacksPerSecond"],
    ["rAF/frame", "trace.callbacksPerRenderFrame"],
    ["Commits/s", "trace.commitsPerSecond"],
    ["Hub → main/s", "hubToMainPerSecond"],
    ["Satellite updates/s", IPC]
  ];
  const header = (labels) => {
    console.log(`| ${labels.join(" | ")} |`);
    console.log(`| ${labels.map((_, i) => (i ? "---:" : "---")).join(" | ")} |`);
  };
  const row = (label, values) => console.log(`| ${tableLabel(label)} | ${values.join(" | ")} |`);
  header(["Scenario", ...overview.map(([label]) => label)]);
  for (const scenario of results) {
    row(
      scenario.label,
      overview.map(([, key, digits]) => format(scenario, key, digits))
    );
  }
  console.log("");
  header(["Scenario / window", ...renderer.map(([label]) => label)]);
  for (const scenario of results) {
    for (const id of Object.keys(scenario.runs[0].windows)) {
      const label = Object.keys(scenario.runs[0].windows).length > 1 ? `${scenario.label} / ${id}` : scenario.label;
      row(
        label,
        renderer.map(([, key, digits]) => format(scenario, `windows.${id}.${key}`, digits))
      );
    }
  }
}

async function compare(beforePath, afterPath) {
  const [before, after] = await Promise.all(
    [beforePath, afterPath].map(async (file) => JSON.parse(await readFile(file)))
  );
  if (before.schemaVersion !== 1 || after.schemaVersion !== 1) throw new Error("Unsupported benchmark JSON version");
  for (const key of ["machine", "config", "layoutHash", "electron"]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      console.error(`[compare] ${key} differs between reports`);
    }
  }
  const prior = new Map(before.scenarios.map((scenario) => [scenario.id, scenario]));
  const added = after.scenarios.filter(({ id }) => !prior.has(id)).map(({ label }) => label);
  const removed = before.scenarios.filter(({ id }) => !after.scenarios.some((scenario) => scenario.id === id));
  if (added.length) console.error(`[compare] Only in after: ${added.join(", ")}`);
  if (removed.length) console.error(`[compare] Only in before: ${removed.map(({ label }) => label).join(", ")}`);
  console.log("Median deltas (after minus before).");
  printTable(
    after.scenarios.filter(({ id }) => prior.has(id)),
    (scenario, key, digits = 1) => {
      const previous = prior.get(scenario.id).summary[key];
      const current = scenario.summary[key];
      if (!current || !previous) return "—";
      const delta = Number((current.median - previous.median).toFixed(digits));
      return (delta > 0 ? "+" : "") + value(delta, digits);
    }
  );
}

async function main() {
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.compare !== undefined) {
    if (positionals.length !== 1) throw new Error("Use --compare <before.json> <after.json>");
    await compare(options.compare, positionals[0]);
    return;
  }
  if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
  const requested = options.scenario ?? SCENARIOS;
  if (requested.some((id) => !SCENARIOS.includes(id) && !/^tab-\d+$/.test(id))) {
    throw new Error("Unknown --scenario. See --help for the valid scenario IDs.");
  }
  const config = {
    repeats: numberOption("repeats", 1, true),
    warmup: numberOption("warmup", 0),
    seconds: numberOption("seconds", 0.5),
    trace: numberOption("trace", 0.5),
    mockSpeed: numberOption("mock-speed", 0.01)
  };
  if (config.mockSpeed > 100) throw new Error("--mock-speed must be at most 100");
  const mockArgs = [...MOCK_ARGS, "--speed", String(config.mockSpeed)];
  const started = performance.now();
  const fixture = await readFile(path.join(ROOT, DEFAULT_STATE), "utf8");
  const layoutFile = options.state ? await readFile(options.state, "utf8") : fixture;
  const template = readHubState(JSON.parse(fixture));
  const state = readHubState(JSON.parse(layoutFile));
  if (!options["no-build"]) {
    if (!existsSync(path.join(ROOT, "src/licenses.json"))) {
      execFileSync(process.execPath, ["getLicenses.mjs"], { cwd: ROOT, stdio: "inherit" });
    }
    execFileSync("npm", ["run", "compile"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
  }
  if (!existsSync(path.join(ROOT, "bundles/main.js")))
    throw new Error("Missing desktop bundles. Run without --no-build.");

  const findings = [];
  const { scenarios, tabs, tracksideControl } = await plan(state, template, requested, findings);
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    appChanges: execFileSync(
      "git",
      ["status", "--porcelain", "--", "src", "www", "bundledAssets", "rolldown.config.mjs"],
      {
        cwd: ROOT,
        encoding: "utf8"
      }
    ).trim(),
    noBuild: !!options["no-build"],
    machine: {
      cpu: os.cpus()[0]?.model,
      logicalCpus: LOGICAL_CPUS,
      platform: process.platform,
      release: os.release(),
      arch: process.arch
    },
    config,
    electron: JSON.parse(await readFile(path.join(ROOT, "node_modules/electron/package.json"), "utf8")).version,
    layout: options.state ?? DEFAULT_STATE,
    layoutHash: createHash("sha256").update(layoutFile).digest("hex"),
    hubSize: HUB_SIZE,
    mockArgs,
    tabs,
    tracksideControl,
    findings,
    scenarios: scenarios.map(({ id, label }) => ({ id, label, runs: [] }))
  };
  const byId = new Map(report.scenarios.map((scenario) => [scenario.id, scenario]));
  const tabSuite = scenarios.filter(({ id }) => id === "live-docs" || id.startsWith("tab-"));
  const groups = scenarios.flatMap((scenario) => {
    if (!tabSuite.includes(scenario)) return [[scenario]];
    return scenario === tabSuite[0] ? [tabSuite] : [];
  });
  for (let repeat = 0; repeat < config.repeats; repeat++) {
    for (const group of groups) {
      const [first] = group;
      const findings = [];
      await withMock(first.live, mockArgs, (address) =>
        withApp(first.states, findings, async (app, hubs) => {
          const windows = await prepare(app, hubs, first, address);
          for (const scenario of group) {
            console.error(`[perf] ${repeat + 1}/${config.repeats} ${scenario.id} (${scenario.label})`);
            if (scenario !== first) await selectTab(hubs[0], scenario.uuid);
            const metrics = await measure(app, windows, address, config);
            byId.get(scenario.id).runs.push({ ...metrics, findings: findings.splice(0) });
          }
        })
      );
      report.findings.push(...findings);
    }
  }
  for (const scenario of report.scenarios) scenario.summary = summarize(scenario.runs);
  report.elapsedSeconds = (performance.now() - started) / 1000;
  const out = path.resolve(options.out);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + "\n");
  console.log(`Median [min–max] across ${config.repeats} runs.\n`);
  printTable(report.scenarios);
  console.error(`[perf] ${out} (${report.elapsedSeconds.toFixed(1)} s)`);
}

main().catch((error) => {
  console.error("perf:", error.message);
  process.exitCode = 1;
});
