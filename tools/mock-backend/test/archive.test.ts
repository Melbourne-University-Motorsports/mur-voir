// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// The mock archive routes, exercised with the app's own archive client.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ArchiveClient, MemorySink, RunTransfer, validRun } from "../../../src/shared/mur/archive.ts";
import { runFile } from "../src/archive.ts";
import { startServer } from "../src/server.ts";

const TODAY = "2026-11-17";

test("fixture runs cover every state the Download runs popup shows", async () => {
  const h = await startServer({ port: 0, host: "127.0.0.1", archive: { today: TODAY } });
  try {
    const client = new ArchiveClient(`http://127.0.0.1:${h.port}`);
    const { runs, next } = await client.listRuns();
    assert.equal(next, null);
    assert.equal(runs.length, h.archive.runs.length, "Every fixture passes the client's validation");
    assert.ok(h.archive.runs.every(validRun));
    assert.equal(runs[0].name, "2026-11-17_tue_15-40-12");

    const states = new Set(runs.map((run) => run.state));
    assert.deepEqual([...states].sort(), ["complete", "recording", "uploading"]);
    assert.ok(runs.some((run) => run.end === "power_off"));
    assert.ok(runs.some((run) => run.end === "clean_stop"));
    assert.ok(runs.some((run) => run.state === "uploading" && run.end === "power_off" && run.on_car_s! > 0));
    assert.ok(runs.some((run) => run.state === "uploading" && run.end === "clean_stop" && run.on_car_s! > 0));
    assert.ok(runs.some((run) => run.summary === null));
    assert.ok(runs.some((run) => run.start === null && !run.dated));
    assert.ok(
      runs.some((run) => run.name.startsWith("run_")),
      "A legacy run name"
    );
    assert.ok(runs.some((run) => run.summary?.activity === "parked"));
    assert.ok(runs.some((run) => run.summary !== null && run.summary.place === null));
    const faults = runs.flatMap((run) => run.summary?.faults ?? []);
    assert.ok(faults.some((fault) => fault.severity === "shutdown"));
    assert.ok(faults.some((fault) => fault.severity === "warning"));
    assert.ok(
      faults.some((fault) => fault.times.length > 1),
      "A repeated fault"
    );
    assert.ok(
      runs.some((run) => (run.summary?.faults.length ?? 0) > 2),
      "A run with more than two fault groups"
    );
  } finally {
    await h.close();
  }
});

test("runs page with limit and before", async () => {
  const h = await startServer({ port: 0, host: "127.0.0.1", archive: { today: TODAY } });
  try {
    const client = new ArchiveClient(`http://127.0.0.1:${h.port}`);
    const first = await client.listRuns({ limit: 5 });
    assert.equal(first.runs.length, 5);
    assert.equal(first.next, first.runs[4].name);
    const second = await client.listRuns({ limit: 5, before: first.next });
    assert.equal(second.runs[0].name, h.archive.runs[5].name);
    const base = `http://127.0.0.1:${h.port}/api/v1/archive/runs`;
    const other = await fetch(`${base}?vehicle=mur26`);
    assert.equal(other.status, 404);
    assert.equal((await other.json()).error, "unknown_vehicle");
    const bad = await fetch(`${base}?vehicle=mur27&limit=501`);
    assert.equal(bad.status, 400);
    const cursor = await fetch(`${base}?vehicle=mur27&before=nope`);
    assert.equal((await cursor.json()).error, "unknown_cursor");
  } finally {
    await h.close();
  }
});

test("the file route prepares unfinished runs with 202, then serves the MF4", async () => {
  const h = await startServer({ port: 0, host: "127.0.0.1", archive: { today: TODAY } });
  try {
    const base = `http://127.0.0.1:${h.port}`;
    const uploading = h.archive.runs.find((run) => run.state === "uploading")!;
    const first = await fetch(`${base}/api/v1/archive/runs/${uploading.name}/file`);
    assert.equal(first.status, 202);
    assert.equal(first.headers.get("retry-after"), "1");
    assert.deepEqual(await first.json(), { state: "preparing" });

    const waits: number[] = [];
    const client = new ArchiveClient(base, undefined, "mur27", async (ms) => void waits.push(ms));
    const sink = new MemorySink();
    await new RunTransfer(client, uploading.name, sink).run();
    assert.deepEqual(waits, [], "Prepared once, served after");
    assert.deepEqual(Buffer.from(sink.bytes()), runFile());

    const complete = await fetch(`${base}/api/v1/archive/runs/${h.archive.runs[2].name}/file`);
    assert.equal(complete.status, 200);
    assert.equal(complete.headers.get("content-disposition"), `attachment; filename="${h.archive.runs[2].name}.mf4"`);
    assert.equal(complete.headers.get("accept-ranges"), "bytes");
    assert.ok(complete.headers.get("etag"));
    assert.equal((await complete.arrayBuffer()).byteLength, runFile().length);

    const missing = await fetch(`${base}/api/v1/archive/runs/nope/file`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "unknown_run");
  } finally {
    await h.close();
  }
});

test("Range requests answer 206, and a mismatched If-Range sends the whole file", async () => {
  const h = await startServer({ port: 0, host: "127.0.0.1", archive: { today: TODAY } });
  try {
    const url = `http://127.0.0.1:${h.port}/api/v1/archive/runs/pending_3/file`;
    const etag = (await fetch(url)).headers.get("etag")!;
    const partial = await fetch(url, { headers: { Range: "bytes=100-", "If-Range": etag } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), `bytes 100-${runFile().length - 1}/${runFile().length}`);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), runFile().subarray(100));
    const stale = await fetch(url, { headers: { Range: "bytes=100-", "If-Range": '"old"' } });
    assert.equal(stale.status, 200);
    await stale.arrayBuffer();
    const past = await fetch(url, { headers: { Range: `bytes=${runFile().length}-` } });
    assert.equal(past.status, 416);
    assert.equal(past.headers.get("content-range"), `bytes */${runFile().length}`);
    await past.arrayBuffer();
    const suffix = await fetch(url, { headers: { Range: "bytes=-8" } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), runFile().subarray(-8));
    const several = await fetch(url, { headers: { Range: "bytes=0-1,4-5" } });
    assert.equal(several.status, 200);
    await several.arrayBuffer();
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.headers.get("content-length"), String(runFile().length));
  } finally {
    await h.close();
  }
});

test("--archive-drop cuts the first download, and the client resumes it with Range", async () => {
  const h = await startServer({
    port: 0,
    host: "127.0.0.1",
    archive: { today: TODAY, prepare: false, dropOnce: true }
  });
  try {
    const client = new ArchiveClient(`http://127.0.0.1:${h.port}`);
    const sink = new MemorySink();
    const transfer = new RunTransfer(client, "pending_3", sink);
    await assert.rejects(transfer.run(), /dropped/);
    assert.ok(transfer.received > 0 && transfer.received < runFile().length);
    await transfer.run();
    assert.deepEqual(Buffer.from(sink.bytes()), runFile());
  } finally {
    await h.close();
  }
});
