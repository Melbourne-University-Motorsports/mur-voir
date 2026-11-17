// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// The mock archive's answers conform to the pinned mur-msgs archive schema (src/shared/mur/archive-api/).
import Ajv from "ajv";
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { parseRunsPage } from "../../src/shared/mur/archive";
import { fixtureRuns } from "../../tools/mock-backend/src/archive";
import { startServer } from "../../tools/mock-backend/src/server";

const schema = JSON.parse(fs.readFileSync("src/shared/mur/archive-api/schema/archive.schema.json", "utf8"));
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(schema);
function conforms(definition: string, value: unknown) {
  const validate = ajv.getSchema(`${schema.$id}#/definitions/${definition}`)!;
  assert.ok(validate(value), `${definition}: ${JSON.stringify(validate.errors)} in ${JSON.stringify(value)}`);
}

test("every fixture run conforms to the archive schema", () => {
  for (const run of fixtureRuns("2026-11-17")) conforms("Run", run);
  // Melbourne is on +10:00 in winter; the fixtures use +11:00 either way, which the schema allows.
  for (const run of fixtureRuns("2026-06-17")) conforms("Run", run);
});

test("mock archive responses conform to the archive schema and the client reads them unchanged", async () => {
  const h = await startServer({ port: 0, host: "127.0.0.1", archive: { today: "2026-11-17" } });
  try {
    const base = `http://127.0.0.1:${h.port}/api/v1/archive`;
    let before: string | null = null;
    let total = 0;
    do {
      const response: Response = await fetch(`${base}/runs?vehicle=mur27&limit=4${before ? "&before=" + before : ""}`);
      const body = await response.json();
      conforms("RunList", body);
      assert.deepEqual(parseRunsPage(body), body, "The client keeps every conforming run as sent");
      total += body.runs.length;
      before = body.next;
    } while (before !== null);
    assert.equal(total, h.archive.runs.length);

    const uploading = h.archive.runs.find((run) => run.state === "uploading")!;
    const preparing = await fetch(`${base}/runs/${uploading.name}/file`);
    assert.equal(preparing.status, 202);
    conforms("Preparing", await preparing.json());

    for (const url of [`${base}/runs/nope/file`, `${base}/runs?vehicle=mur26`, `${base}/runs?vehicle=mur27&limit=0`]) {
      const response = await fetch(url);
      assert.ok(response.status >= 400);
      conforms("Error", await response.json());
    }
  } finally {
    await h.close();
  }
});
