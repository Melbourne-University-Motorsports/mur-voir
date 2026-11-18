// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// Desktop Download runs files: the .part sink, free names for several runs, and the open-run cache.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { availableRunPath, clearRunCache, fileSink, isInRunCache, runCacheFolder } from "../src/main/electron/runFiles";
import { ArchiveClient } from "../src/shared/mur/archive";
import { ArchiveJob, JobState } from "../src/shared/mur/archiveJob";
import { runFile } from "../tools/mock-backend/src/archive";
import { startServer } from "../tools/mock-backend/src/server";

function tempFolder(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mur-voir-run-files-"));
}

async function withArchive(action: (client: ArchiveClient, requests: string[]) => Promise<void>) {
  const h = await startServer({ port: 0, host: "127.0.0.1", archive: { today: "2026-11-17", prepare: false } });
  const requests: string[] = [];
  const client = new ArchiveClient(`http://127.0.0.1:${h.port}`, (url, init) => {
    requests.push(init?.headers?.Range ?? "whole file");
    return fetch(url, init);
  });
  try {
    await action(client, requests);
  } finally {
    await h.close();
  }
}

test("Try again after a failed save finishes the file instead of saving an empty one", async () => {
  const folder = tempFolder();
  const target = path.join(folder, "pending_3.mf4");
  // A non-empty folder where the file should go makes the rename in finish() fail.
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "blocker"), "");
  await withArchive(async (client, requests) => {
    const states: JobState[] = [];
    let finished = 0;
    const job = new ArchiveJob(
      client,
      "download",
      ["pending_3"],
      () => fileSink(target, () => void finished++),
      (state) => states.push(state)
    );
    assert.equal(await job.run(), false);
    assert.equal(states[states.length - 1].phase, "failed");
    assert.equal(fs.statSync(target + ".part").size, runFile().length, "The download itself completed");

    fs.rmSync(target, { recursive: true });
    assert.equal(await job.run(), true);
    // The resume asks for the bytes past the end, gets 416, and checks the .part file before trusting it.
    assert.deepEqual(requests, ["whole file", `bytes=${runFile().length}-`]);
    assert.deepEqual(fs.readFileSync(target), runFile(), "The saved file is the whole run, not 0 bytes");
    assert.equal(fs.existsSync(target + ".part"), false);
    assert.equal(finished, 1);
  });
});

test("Try again over a .part file that lost its bytes downloads the run again", async () => {
  const folder = tempFolder();
  const target = path.join(folder, "pending_3.mf4");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "blocker"), "");
  await withArchive(async (client, requests) => {
    const job = new ArchiveJob(
      client,
      "download",
      ["pending_3"],
      () => fileSink(target),
      () => {}
    );
    assert.equal(await job.run(), false);
    fs.rmSync(target, { recursive: true });
    fs.truncateSync(target + ".part", 10);
    assert.equal(await job.run(), true);
    assert.deepEqual(requests, ["whole file", `bytes=${runFile().length}-`, "whole file"]);
    assert.deepEqual(fs.readFileSync(target), runFile());
  });
});

test("finish refuses a file that doesn't hold the expected bytes", async () => {
  const target = path.join(tempFolder(), "run.mf4");
  const sink = fileSink(target);
  await sink.write(new Uint8Array([1, 2, 3]));
  await assert.rejects(sink.finish(4), /3 of 4 bytes/);
  assert.equal(fs.existsSync(target), false, "Nothing is saved");
  await sink.finish(3);
  assert.deepEqual(fs.readFileSync(target), Buffer.from([1, 2, 3]));
});

test("a new sink empties a stale .part file; reopening after a close keeps its bytes", async () => {
  const target = path.join(tempFolder(), "run.mf4");
  fs.writeFileSync(target + ".part", "stale bytes from an earlier session");
  const sink = fileSink(target);
  await sink.write(new Uint8Array([1, 2]));
  assert.equal(await sink.size(), 2);
  await assert.rejects(sink.finish(3));
  await sink.write(new Uint8Array([3]));
  assert.equal(await sink.size(), 3);
  await sink.finish(3);
  assert.deepEqual(fs.readFileSync(target), Buffer.from([1, 2, 3]));
});

test("saving several runs never replaces a file: it picks name (1).mf4, name (2).mf4", async () => {
  const folder = tempFolder();
  assert.equal(await availableRunPath(folder, "pending_3"), path.join(folder, "pending_3.mf4"));
  fs.writeFileSync(path.join(folder, "pending_3.mf4"), "");
  assert.equal(await availableRunPath(folder, "pending_3"), path.join(folder, "pending_3 (1).mf4"));
  fs.writeFileSync(path.join(folder, "pending_3 (1).mf4.part"), "");
  assert.equal(await availableRunPath(folder, "pending_3"), path.join(folder, "pending_3 (2).mf4"));
});

test("the open-run cache is per process, and startup clears this and dead processes' folders", async () => {
  const temp = tempFolder();
  const mine = runCacheFolder(temp, 100);
  const alive = runCacheFolder(temp, 200);
  const dead = runCacheFolder(temp, 300);
  for (const folder of [mine, alive, dead]) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "run.mf4"), "");
  }
  fs.writeFileSync(path.join(path.dirname(mine), "old-layout.mf4"), "");
  assert.ok(isInRunCache(mine, path.join(mine, "run.mf4")));
  assert.ok(!isInRunCache(mine, path.join(alive, "run.mf4")));
  assert.ok(!isInRunCache(mine, path.join(temp, "elsewhere.mf4")));

  await clearRunCache(mine, (pid) => pid === 200);
  assert.deepEqual(fs.readdirSync(path.dirname(mine)), ["200"]);
  await clearRunCache(runCacheFolder(path.join(temp, "missing"), 1));
});
