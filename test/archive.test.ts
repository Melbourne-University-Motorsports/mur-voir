// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  archiveBase,
  ArchiveClient,
  ArchiveError,
  ArchiveFault,
  ArchiveFetch,
  ArchiveRun,
  MemorySink,
  parseRunsPage,
  readRunParam,
  retryAfterSeconds,
  runLink,
  RunTransfer,
  TransferProgress,
  withRunParam
} from "../src/shared/mur/archive";
import { ArchiveJob, JobState } from "../src/shared/mur/archiveJob";
import {
  dayHeading,
  faultColumn,
  faultLineText,
  faultListText,
  groupByDay,
  groupFaults,
  matchesFilter,
  mergeRuns,
  openChoices,
  openTarget,
  pruneSelection,
  resumesJob,
  runActivityText,
  runLabel,
  runLengthText,
  runNumbersText,
  runStatus,
  selectionActions,
  sizeText,
  toggleRun,
  toggleRuns
} from "../src/shared/mur/archiveView";

const DAY = "2026-11-17";

function run(fields: Partial<ArchiveRun> = {}): ArchiveRun {
  return {
    name: "2026-11-17_tue_13-20-41",
    start: "2026-11-17T13:20:41+11:00",
    dated: true,
    duration_s: 1860,
    state: "complete",
    end: "clean_stop",
    on_car_s: 0,
    size_bytes: 74_000_000,
    summary: {
      covers_s: 1860,
      activity: "driving",
      place: "Test track",
      distance_m: 23600,
      top_speed_kmh: 97,
      soc_start_pct: 97,
      soc_end_pct: 55,
      ts_on_s: 1740,
      faults: []
    },
    ...fields
  };
}

function fault(
  name: string,
  severity: ArchiveFault["severity"],
  times: string[],
  code = 0,
  count = times.length
): ArchiveFault {
  const start = Date.parse(`${DAY}T09:00:00+11:00`);
  const stamps = times.map((time) => `${DAY}T${time}:00+11:00`);
  return {
    signal: "HB_TTCS_FaultBits",
    code,
    name,
    full_name: name + " (full)",
    severity,
    times: stamps,
    at_s: stamps.map((time) => (Date.parse(time) - start) / 1000) as ArchiveFault["at_s"],
    count
  };
}

// Archive client

/** A scripted fetch: each call takes the next response and records the request. */
function scripted(responses: (() => Response)[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: ArchiveFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request " + url);
    return next();
  };
  return { fetchImpl, calls };
}

const noWait = async () => {};

/** What a MemorySink holds, read back from its Blob. */
async function bytesOf(sink: MemorySink): Promise<Uint8Array> {
  return new Uint8Array(await sink.blob().arrayBuffer());
}

/** A job sink over a MemorySink that records what each finished run held. */
function recordingSink(name: string, finished: string[]) {
  const sink = new MemorySink();
  return {
    write: (chunk: Uint8Array) => sink.write(chunk),
    reset: () => sink.reset(),
    size: () => sink.size(),
    discard: async () => {},
    finish: async (size: number) => {
      assert.equal(size, sink.size());
      finished.push(`${name}:${(await bytesOf(sink)).join(",")}`);
    }
  };
}

/** A body that sends `bytes` and then fails, like a dropped connection. */
function droppingBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) controller.error(new TypeError("terminated"));
      else {
        sent = true;
        controller.enqueue(bytes);
      }
    }
  });
}

test("archiveBase accepts host:port, origins and WebSocket addresses", () => {
  assert.equal(archiveBase("mur-base.tailnet.internal:8080"), "http://mur-base.tailnet.internal:8080");
  assert.equal(archiveBase("https://voir.melbourneuniracing.com/"), "https://voir.melbourneuniracing.com");
  assert.equal(archiveBase("ws://127.0.0.1:8090"), "http://127.0.0.1:8090");
  assert.equal(archiveBase("wss://example.org"), "https://example.org");
});

test("listRuns asks for the vehicle, limit and cursor and validates the page", async () => {
  const body = { version: 1, runs: [run(), { name: "../evil" }, run({ name: "pending_3", start: null })], next: "x_1" };
  const { fetchImpl, calls } = scripted([() => Response.json(body)]);
  const client = new ArchiveClient("http://car:8080", fetchImpl);
  const page = await client.listRuns({ before: "2026-11-17_tue_13-20-41", limit: 50 });
  assert.equal(
    calls[0].url,
    "http://car:8080/api/v1/archive/runs?vehicle=mur27&limit=50&before=2026-11-17_tue_13-20-41"
  );
  assert.deepEqual(
    page.runs.map((run) => run.name),
    ["2026-11-17_tue_13-20-41", "pending_3"],
    "Invalid runs are dropped"
  );
  assert.equal(page.next, "x_1");
});

test("listRuns rejects other API versions, non-JSON and HTTP errors with readable messages", async () => {
  assert.throws(() => parseRunsPage({ version: 2, runs: [] }), /version 2/);
  assert.throws(() => parseRunsPage([]), ArchiveError);
  const notJson = new ArchiveClient("http://car", scripted([() => new Response("<html>")]).fetchImpl);
  await assert.rejects(notJson.listRuns(), /isn't JSON/);
  const failing = new ArchiveClient(
    "http://car",
    scripted([() => Response.json({ error: "bad_gateway", message: "telemetry-api down" }, { status: 502 })]).fetchImpl
  );
  await assert.rejects(failing.listRuns(), (error: ArchiveError) => {
    assert.equal(error.kind, "http");
    assert.match(error.message, /502: telemetry-api down/);
    return true;
  });
  const offline = new ArchiveClient("http://car", async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(offline.listRuns(), (error: ArchiveError) => error.kind === "network");
});

test("Retry-After accepts seconds and HTTP dates and stays between 1 and 30 seconds", () => {
  assert.equal(retryAfterSeconds("3"), 3);
  assert.equal(retryAfterSeconds(null), 2);
  assert.equal(retryAfterSeconds("600"), 30);
  assert.equal(retryAfterSeconds("0"), 1);
  assert.equal(retryAfterSeconds(new Date(10_000).toUTCString(), 5_000), 5);
});

test("a transfer waits through 202 preparing, then fetches the file", async () => {
  const file = new Uint8Array([1, 2, 3, 4]);
  const { fetchImpl, calls } = scripted([
    () => Response.json({ state: "preparing" }, { status: 202, headers: { "Retry-After": "4" } }),
    () => new Response(file, { headers: { "Content-Length": "4", ETag: '"v1"' } })
  ]);
  const waits: number[] = [];
  const client = new ArchiveClient("http://car", fetchImpl, "mur27", async (ms) => void waits.push(ms));
  const sink = new MemorySink();
  const progress: TransferProgress[] = [];
  await new RunTransfer(client, "2026-11-17_tue_13-20-41", sink, (p) => progress.push(p)).run();
  assert.equal(calls[0].url, "http://car/api/v1/archive/runs/2026-11-17_tue_13-20-41/file?vehicle=mur27");
  assert.deepEqual(waits, [4000]);
  assert.deepEqual(progress[0], { phase: "preparing", retryInS: 4 });
  assert.deepEqual(progress[progress.length - 1], { phase: "fetching", received: 4, total: 4 });
  assert.deepEqual(await bytesOf(sink), file);
});

test("a dropped transfer resumes with a Range request for the missing bytes", async () => {
  const { fetchImpl, calls } = scripted([
    () => new Response(droppingBody(new Uint8Array([1, 2, 3])), { headers: { "Content-Length": "6", ETag: '"v1"' } }),
    () =>
      new Response(new Uint8Array([4, 5, 6]), {
        status: 206,
        headers: { "Content-Range": "bytes 3-5/6", "Content-Length": "3", ETag: '"v1"' }
      })
  ]);
  const sink = new MemorySink();
  const transfer = new RunTransfer(new ArchiveClient("http://car", fetchImpl, "mur27", noWait), "r", sink);
  await assert.rejects(transfer.run(), (error: ArchiveError) => error.kind === "network");
  assert.equal(transfer.received, 3);
  await transfer.run();
  assert.deepEqual(calls[1].headers, { Range: "bytes=3-", "If-Range": '"v1"' });
  assert.deepEqual(await bytesOf(sink), new Uint8Array([1, 2, 3, 4, 5, 6]));
});

test("a resume that gets the whole file again (new parts, new ETag) starts over", async () => {
  const { fetchImpl } = scripted([
    () => new Response(droppingBody(new Uint8Array([1, 2])), { headers: { "Content-Length": "4", ETag: '"v1"' } }),
    () => new Response(new Uint8Array([9, 8, 7, 6, 5]), { headers: { "Content-Length": "5", ETag: '"v2"' } })
  ]);
  const sink = new MemorySink();
  const transfer = new RunTransfer(new ArchiveClient("http://car", fetchImpl, "mur27", noWait), "r", sink);
  await assert.rejects(transfer.run());
  await transfer.run();
  assert.deepEqual(await bytesOf(sink), new Uint8Array([9, 8, 7, 6, 5]));
  assert.equal(transfer.etag, '"v2"');
});

test("a resume answered from the wrong offset fails instead of corrupting the file", async () => {
  const { fetchImpl } = scripted([
    () => new Response(droppingBody(new Uint8Array([1, 2])), { headers: { "Content-Length": "4" } }),
    () => new Response(new Uint8Array([3]), { status: 206, headers: { "Content-Range": "bytes 1-3/4" } })
  ]);
  const transfer = new RunTransfer(new ArchiveClient("http://car", fetchImpl, "mur27", noWait), "r", new MemorySink());
  await assert.rejects(transfer.run());
  await assert.rejects(transfer.run(), /wrong place/);
});

test("a 416 resume counts as complete only when the sink holds the whole file", async () => {
  const file = new Uint8Array([1, 2, 3, 4]);
  const { fetchImpl, calls } = scripted([
    () => new Response(file, { headers: { "Content-Length": "4", ETag: '"v1"' } }),
    () => Response.json({ error: "range_not_satisfiable" }, { status: 416, headers: { "Content-Range": "bytes */4" } })
  ]);
  const sink = new MemorySink();
  const transfer = new RunTransfer(new ArchiveClient("http://car", fetchImpl, "mur27", noWait), "r", sink);
  await transfer.run();
  // Saving failed after the transfer finished; Try again asks for bytes 4- and gets 416.
  await transfer.run();
  assert.deepEqual(calls[1].headers, { Range: "bytes=4-", "If-Range": '"v1"' });
  assert.deepEqual(await bytesOf(sink), file);
});

test("a 416 resume over a short or missing partial file starts the download over", async () => {
  const file = new Uint8Array([1, 2, 3, 4]);
  const { fetchImpl, calls } = scripted([
    () => new Response(file, { headers: { "Content-Length": "4", ETag: '"v1"' } }),
    () => Response.json({ error: "range_not_satisfiable" }, { status: 416, headers: { "Content-Range": "bytes */4" } }),
    () => new Response(file, { headers: { "Content-Length": "4", ETag: '"v1"' } })
  ]);
  const sink = new MemorySink();
  const transfer = new RunTransfer(new ArchiveClient("http://car", fetchImpl, "mur27", noWait), "r", sink);
  await transfer.run();
  sink.reset(); // e.g. the .part file was emptied or deleted
  await transfer.run();
  assert.deepEqual(calls[2].headers, {}, "The restart asks for the whole file");
  assert.equal(transfer.received, 4);
  assert.deepEqual(await bytesOf(sink), file);
});

test("MemorySink folds chunks into Blob parts as it goes, so a run isn't held twice", async () => {
  const sink = new MemorySink();
  const chunk = new Uint8Array(1024 * 1024).fill(7);
  for (let i = 0; i < 10; i++) sink.write(chunk);
  assert.equal(sink.size(), 10 * chunk.byteLength);
  assert.ok(sink.unflushedBytes < 4 * 1024 * 1024, "At most one batch waits as chunks");
  const file = sink.file("run.mf4");
  assert.equal(file.name, "run.mf4");
  assert.equal(file.size, 10 * chunk.byteLength);
  assert.equal(sink.unflushedBytes, 0);
  const bytes = new Uint8Array(await file.arrayBuffer());
  assert.ok(bytes.every((byte) => byte === 7));
  sink.reset();
  assert.equal(sink.size(), 0);
  assert.equal(sink.blob().size, 0);
});

test("a run with nothing on the server yet (409 no_data) fails with a readable message", async () => {
  const { fetchImpl } = scripted([
    () => Response.json({ error: "no_data", message: "No part of this run is in Blob" }, { status: 409 })
  ]);
  const transfer = new RunTransfer(new ArchiveClient("http://car", fetchImpl), "r", new MemorySink());
  await assert.rejects(transfer.run(), (error: ArchiveError) => error.kind === "no_data");
});

test("faults from a server without at_s or count still list, with count from the times", () => {
  const legacy = { ...fault("IMD trip", "shutdown", ["10:00", "10:02"]) } as Partial<ArchiveFault>;
  delete legacy.at_s;
  delete legacy.count;
  const page = parseRunsPage({
    version: 1,
    runs: [run({ summary: { ...run().summary!, faults: [legacy] } as any })],
    next: null
  });
  assert.equal(page.runs.length, 1);
  assert.equal(page.runs[0].summary!.faults[0].count, 2);
});

test("an unknown run fails with not_found", async () => {
  const { fetchImpl } = scripted([
    () => Response.json({ error: "not_found", message: "Unknown run" }, { status: 404 })
  ]);
  const transfer = new RunTransfer(new ArchiveClient("http://car", fetchImpl), "gone", new MemorySink());
  await assert.rejects(transfer.run(), (error: ArchiveError) => error.kind === "not_found");
});

test("a job fetches each run in turn, resumes after a drop and reports progress", async () => {
  const { fetchImpl } = scripted([
    () => new Response(new Uint8Array([1, 2]), { headers: { "Content-Length": "2" } }),
    () => new Response(droppingBody(new Uint8Array([3])), { headers: { "Content-Length": "2", ETag: '"b"' } }),
    () => new Response(new Uint8Array([4]), { status: 206, headers: { "Content-Range": "bytes 1-1/2", ETag: '"b"' } })
  ]);
  const finished: string[] = [];
  const states: JobState[] = [];
  const job = new ArchiveJob(
    new ArchiveClient("http://car", fetchImpl, "mur27", noWait),
    "download",
    ["a", "b"],
    (name) => recordingSink(name, finished),
    (state) => states.push(state),
    "Downloads"
  );
  assert.equal(await job.run(), false);
  assert.equal(states[states.length - 1].phase, "failed");
  assert.equal(states[states.length - 1].error, "Connection lost");
  assert.equal(states[states.length - 1].index, 1);
  assert.equal(await job.run(), true);
  assert.deepEqual(finished, ["a:1,2", "b:3,4"]);
  const last = states[states.length - 1];
  assert.equal(last.phase, "done");
  assert.equal(last.finishedBytes, 4);
  assert.equal(last.destination, "Downloads");
});

test("cancelling a job aborts the transfer and discards the partial file", async () => {
  let discarded = false;
  const fetchImpl: ArchiveFetch = (_, init) =>
    new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  const job = new ArchiveJob(
    new ArchiveClient("http://car", fetchImpl),
    "open",
    ["a"],
    () => ({
      write() {},
      reset() {},
      size: () => 0,
      finish: async () => {},
      discard: async () => void (discarded = true)
    }),
    () => {}
  );
  const running = job.run();
  await new Promise((resolve) => setTimeout(resolve, 10));
  job.cancel();
  assert.equal(await running, false);
  assert.equal(discarded, true);
  assert.equal(job.running, false);
});

// Faults

test("faults group repeats, put shutdowns first, then order by first time", () => {
  const groups = groupFaults([
    fault("Motor derate", "warning", ["16:02"], 7),
    fault("Inverter overtemp", "warning", ["16:09", "16:05"], 3),
    fault("IMD trip", "shutdown", ["16:19"], 1)
  ]);
  assert.deepEqual(
    groups.map((group) => [group.name, group.severity, group.times]),
    [
      ["IMD trip", "shutdown", ["16:19"]],
      ["Motor derate", "warning", ["16:02"]],
      ["Inverter overtemp", "warning", ["16:05", "16:09"]]
    ]
  );
  assert.deepEqual(faultLineText(groups[2]), { at: "16:05", label: "Inverter overtemp ×2" });
  assert.deepEqual(faultLineText(groups[0]), { at: "16:19", label: "IMD trip" });
});

test("×N counts every activation, including those past the listed times", () => {
  const [group] = groupFaults([fault("Cell undervoltage", "warning", ["10:00", "10:01"], 2, 140)]);
  assert.deepEqual(faultLineText(group), { at: "10:00", label: "Cell undervoltage ×140" });
  assert.equal(faultListText([group]), "10:00, 10:01 and 138 more  Cell undervoltage (full)");
});

test("faults in an undated run show their offset from the run start", () => {
  const undated = {
    ...fault("AMS trip", "shutdown", []),
    times: [],
    at_s: [75, 3725] as ArchiveFault["at_s"],
    count: 2
  };
  const [group] = groupFaults([undated]);
  assert.deepEqual(group.times, ["+1:15", "+1:02:05"]);
  assert.deepEqual(faultLineText(group), { at: "+1:15", label: "AMS trip ×2" });
});

test("entries for the same fault are merged, keeping the worst severity", () => {
  const groups = groupFaults([
    fault("Brake pressure sensor", "warning", ["10:24"], 5),
    fault("Inverter overtemp", "warning", ["10:22"], 3),
    fault("Brake pressure sensor", "warning", ["10:19"], 5)
  ]);
  assert.deepEqual(
    groups.map((group) => [group.name, group.times]),
    [
      ["Brake pressure sensor", ["10:19", "10:24"]],
      ["Inverter overtemp", ["10:22"]]
    ]
  );
});

test("the fault column shows two groups and counts the rest; the list has every time", () => {
  const groups = groupFaults([
    fault("A", "warning", ["10:00"], 1),
    fault("B", "warning", ["10:01"], 2),
    fault("C", "shutdown", ["10:02", "10:05"], 3)
  ]);
  const column = faultColumn(groups);
  assert.deepEqual(
    column.lines.map((group) => group.name),
    ["C", "A"]
  );
  assert.equal(column.more, 1);
  assert.equal(faultListText(groups), "10:02, 10:05  C (full)\n10:00  A (full)\n10:01  B (full)");
  assert.deepEqual(faultColumn([]), { lines: [], more: 0 });
});

// Rows

test("line one says what the run was and its upload status", () => {
  assert.equal(runActivityText(run()), "Driving at Test track");
  const parked = run({ summary: { ...run().summary!, activity: "parked", place: "Test track pits" } });
  assert.equal(runActivityText(parked), "Parked at Test track pits");
  assert.equal(runActivityText(run({ summary: { ...run().summary!, place: null } })), "Driving");
  assert.equal(runActivityText(run({ summary: null })), null);

  assert.equal(runStatus(run()), null);
  assert.deepEqual(runStatus(run({ state: "recording", end: null })), { kind: "live", text: "Live now" });
  assert.deepEqual(runStatus(run({ state: "uploading", duration_s: 1080, on_car_s: 420 })), {
    kind: "uploading",
    text: "Uploading, 11 of 18 min in"
  });
  assert.deepEqual(runStatus(run({ state: "uploading", end: "power_off", on_car_s: 300 })), {
    kind: "on-car",
    text: "Last 5 min still on the car"
  });
  assert.deepEqual(runStatus(run({ state: "uploading", on_car_s: null })), { kind: "uploading", text: "Uploading" });
});

test("line two gives distance, top speed and SoC; parked runs give SoC and tractive system time", () => {
  assert.equal(runNumbersText(run()), "23.6 km · 97 km/h top · SoC 97→55%");
  const parked = { ...run().summary!, activity: "parked" as const, distance_m: null, top_speed_kmh: null };
  assert.equal(
    runNumbersText(run({ summary: { ...parked, soc_end_pct: 97, ts_on_s: 130 } })),
    "SoC 97→97% · tractive system on 2 min"
  );
  assert.equal(runNumbersText(run({ summary: { ...parked, ts_on_s: 0 } })), "SoC 97→55% · tractive system off");
  assert.equal(
    runNumbersText(run({ summary: { ...run().summary!, distance_m: null, soc_end_pct: null } })),
    "97 km/h top · SoC 97%"
  );
  assert.equal(runNumbersText(run({ summary: null })), "");
});

test("length, size, labels and day headings", () => {
  assert.equal(runLengthText(run()), "31 min");
  assert.equal(runLengthText(run({ state: "recording", duration_s: 545 })), "9 min+");
  assert.equal(runLengthText(run({ duration_s: 40 })), "40 s");
  assert.equal(sizeText(74_000_000), "74 MB");
  assert.equal(sizeText(3_800_000), "3.8 MB");
  assert.equal(sizeText(2608), "<0.1 MB");
  assert.equal(runLabel(run(), DAY), "Today 13:20");
  assert.equal(runLabel(run(), "2026-11-20"), "Tue 17 Nov 13:20");
  assert.equal(runLabel(run({ name: "pending_3", start: null }), DAY), "pending_3");
  assert.equal(dayHeading(DAY, DAY), "Today, Tue 17 Nov");
  assert.equal(dayHeading("2026-11-14", DAY), "Sat 14 Nov");
  assert.equal(dayHeading("2025-10-31", DAY), "Fri 31 Oct 2025");
  assert.equal(dayHeading(null, DAY), "Not dated");
});

test("runs group by the car's local day, undated last, and filters by activity", () => {
  const runs = [
    run({ name: "a", start: "2026-11-17T15:40:12+11:00" }),
    run({ name: "b", start: "2026-11-17T09:12:02+11:00", summary: { ...run().summary!, activity: "parked" } }),
    run({ name: "c", start: null, summary: null }),
    run({ name: "d", start: "2026-11-14T14:02:11+11:00" })
  ];
  assert.deepEqual(
    groupByDay(runs).map((group) => [group.day, group.runs.map((run) => run.name)]),
    [
      ["2026-11-17", ["a", "b"]],
      ["2026-11-14", ["d"]],
      [null, ["c"]]
    ]
  );
  assert.deepEqual(
    runs.filter((run) => matchesFilter(run, "parked")).map((run) => run.name),
    ["b"]
  );
  assert.equal(runs.filter((run) => matchesFilter(run, "driving")).length, 2, "Runs without a summary are only in All");
  assert.equal(runs.filter((run) => matchesFilter(run, "all")).length, 4);
});

test("a refresh updates listed runs, adds new ones and keeps older pages", () => {
  const merged = mergeRuns(
    [run({ name: "b", duration_s: 60 }), run({ name: "c" })],
    [run({ name: "a" }), run({ name: "b", duration_s: 120 })]
  );
  assert.deepEqual(
    merged.map((run) => [run.name, run.duration_s]),
    [
      ["a", 1860],
      ["b", 120],
      ["c", 1860]
    ]
  );
});

// Selection

test("any number of runs can be ticked to download; Open takes the most recent; Copy link needs exactly one", () => {
  const none = selectionActions({ selected: [], busy: false, openRun: null });
  assert.deepEqual(none, { download: false, open: false, showing: false, copyLink: false, single: null, target: null });
  const one = selectionActions({ selected: ["a"], busy: false, openRun: null });
  assert.deepEqual(one, { download: true, open: true, showing: false, copyLink: true, single: "a", target: "a" });
  // Ticked oldest first; the list is newest first, so Open picks c.
  const order = ["d", "c", "b", "a"];
  const many = selectionActions({ selected: ["a", "b", "c"], busy: false, openRun: null, order });
  assert.deepEqual(many, { download: true, open: true, showing: false, copyLink: false, single: null, target: "c" });
  const manyShowing = selectionActions({ selected: ["a", "c"], busy: false, openRun: "c", order });
  assert.equal(manyShowing.open, false, "The most recent ticked run is already open");
  assert.equal(manyShowing.showing, true);
  assert.equal(openTarget(["b", "a"], order), "b");
  assert.equal(openTarget([], order), null);
  const showing = selectionActions({ selected: ["a"], busy: false, openRun: "a" });
  assert.equal(showing.open, false, "The open run reads Showing");
  assert.equal(showing.showing, true);
  assert.equal(showing.copyLink, true);
  const busy = selectionActions({ selected: ["a"], busy: true, openRun: null });
  assert.equal(busy.download, false);
  assert.equal(busy.open, false);
});

test("after a failure, the button resumes only while the same runs are ticked", () => {
  const failed = { kind: "download" as const, phase: "failed" as const, names: ["a", "b"] };
  assert.equal(resumesJob(failed, "download", ["b", "a"]), true, "Same runs, ticked in another order");
  assert.equal(resumesJob(failed, "download", ["a"]), false, "A run unticked: start a new download");
  assert.equal(resumesJob(failed, "download", ["a", "b", "c"]), false, "A run added: start a new download");
  assert.equal(resumesJob(failed, "download", ["a", "c"]), false);
  assert.equal(resumesJob(failed, "open", ["a"]), false, "Open never resumes a download");
  assert.equal(
    resumesJob({ ...failed, phase: "fetching" }, "download", ["a", "b"]),
    false,
    "Only a stopped job resumes"
  );
  assert.equal(resumesJob(null, "download", ["a"]), false);
  const open = { kind: "open" as const, phase: "failed" as const, names: ["c"] };
  assert.equal(resumesJob(open, "open", ["c"]), true);
  assert.equal(resumesJob(open, "open", ["d"]), false, "Another run: open it from the start");
});

test("ticks toggle, lock while a transfer runs and drop runs no longer listed", () => {
  const state = { selected: ["a"], busy: false, openRun: null };
  assert.deepEqual(toggleRun(state, "b"), ["a", "b"]);
  assert.deepEqual(toggleRun(state, "a"), []);
  assert.deepEqual(toggleRun({ ...state, busy: true }, "b"), ["a"]);
  assert.deepEqual(toggleRuns(state, ["a", "b"]), ["a", "b"]);
  assert.deepEqual(toggleRuns({ ...state, selected: ["a", "b"] }, ["a", "b"]), []);
  assert.deepEqual(pruneSelection(["a", "gone"], [run({ name: "a" })]), ["a"]);
});

test("opening over live telemetry asks first; only Lite offers a new tab", () => {
  assert.equal(openChoices(false, true), null);
  assert.deepEqual(openChoices(true, true), ["cancel", "replace", "newTab"]);
  assert.deepEqual(openChoices(true, false), ["cancel", "replace"]);
});

// ?run= links

test("run links point at hosted Lite, carry the vehicle and round-trip through ?vehicle=&run=", () => {
  const run = { vehicle: "mur27", name: "2026-11-17_tue_13-20-41" };
  const link = runLink(run);
  assert.equal(link, "https://voir.melbourneuniracing.com/?vehicle=mur27&run=2026-11-17_tue_13-20-41");
  assert.deepEqual(readRunParam(link), run);
  assert.equal(
    runLink({ vehicle: "mur26", name: "pending_3" }, "http://127.0.0.1:5808/?layout=default#x"),
    "http://127.0.0.1:5808/?vehicle=mur26&run=pending_3"
  );
});

test("links from before the vehicle was added mean the default vehicle", () => {
  assert.deepEqual(readRunParam("https://voir.melbourneuniracing.com/?run=pending_3"), {
    vehicle: "mur27",
    name: "pending_3"
  });
  assert.equal(readRunParam("https://voir.melbourneuniracing.com/?vehicle=MUR%2027&run=pending_3"), null);
});

test("?run= ignores names that aren't run names", () => {
  assert.equal(readRunParam("https://voir.melbourneuniracing.com/"), null);
  assert.equal(readRunParam("https://voir.melbourneuniracing.com/?run=../../etc"), null);
  assert.equal(readRunParam("https://voir.melbourneuniracing.com/?run=a%2Fb"), null);
  assert.deepEqual(readRunParam("https://voir.melbourneuniracing.com/?run=run_1761900000000000_9f3a"), {
    vehicle: "mur27",
    name: "run_1761900000000000_9f3a"
  });
});

test("the address bar keeps other parameters, such as ?layout=, when ?run= changes", () => {
  const opened = withRunParam("https://voir.melbourneuniracing.com/?layout=default", {
    vehicle: "mur27",
    name: "pending_3"
  });
  assert.equal(opened, "https://voir.melbourneuniracing.com/?layout=default&vehicle=mur27&run=pending_3");
  assert.equal(withRunParam(opened, null), "https://voir.melbourneuniracing.com/?layout=default");
  assert.equal(withRunParam("https://voir.melbourneuniracing.com/", null), "https://voir.melbourneuniracing.com/");
});
