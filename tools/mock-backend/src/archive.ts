// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// Run archive API v1 (GET /api/v1/archive/...) with fixture runs covering every state the Download
// runs popup shows. Every run's file is the same small real MF4 (test/fixtures/mf4/archive-run.mf4),
// carrying bus 0's DBC snapshots as attachments the way the archive's merged files do.

import { readFileSync } from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { ArchiveFault, ArchiveRun, ArchiveSummary } from "../../../src/shared/mur/archive.ts";

export interface ArchiveOptions {
  /** "YYYY-MM-DD" for the newest runs; defaults to today in Melbourne. */
  today?: string;
  /** Answer the first file request for each unfinished run with 202 preparing. */
  prepare: boolean;
  /** Cut the first full download of each run halfway, so the client must resume with Range. */
  dropOnce: boolean;
}

let runFileBytes: Buffer | null = null;

/** The MF4 served for every run, read on first use. Bundled tests run from a temp folder, so fall back to the cwd. */
export function runFile(): Buffer {
  if (runFileBytes === null) {
    try {
      runFileBytes = readFileSync(new URL("../../../test/fixtures/mf4/archive-run.mf4", import.meta.url));
    } catch {
      runFileBytes = readFileSync(path.resolve("test/fixtures/mf4/archive-run.mf4"));
    }
  }
  return runFileBytes;
}
const OFFSET = "+11:00";

function melbourneToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function shiftDay(day: string, days: number): string {
  const date = new Date(day + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function fault(
  signal: string,
  code: number | null,
  name: string,
  fullName: string,
  severity: ArchiveFault["severity"],
  day: string,
  times: string[]
): ArchiveFault {
  // at_s is filled from the run's start in fixtureRuns.
  return {
    signal,
    code,
    name,
    full_name: fullName,
    severity,
    times: times.map((t) => `${day}T${t}:00${OFFSET}`),
    at_s: [0],
    count: times.length
  };
}

const FAULTS = {
  inverterOvertemp: ["Inverter_Status", 3, "Inverter overtemp", "Inverter over-temperature warning", "warning"],
  amsTrip: ["HB_TTCS_FaultBits", 0, "AMS trip", "AMS fault, shutdown circuit opened", "shutdown"],
  imdTrip: ["TTCS_IMDState", 1, "IMD trip", "IMD fault, shutdown circuit opened", "shutdown"],
  brakeSensor: ["HB_TTCS_FaultBits", 5, "Brake pressure sensor", "Brake pressure sensor out of range", "warning"],
  motorDerate: ["Inverter_Status", 7, "Motor derate", "Motor over-temperature derate", "warning"],
  cellUndervoltage: ["ENNOID_Faults", 2, "Cell undervoltage", "BMS cell under-voltage warning", "warning"]
} as const;

function faultOf(kind: keyof typeof FAULTS, day: string, times: string[]): ArchiveFault {
  const [signal, code, name, fullName, severity] = FAULTS[kind];
  return fault(signal, code, name, fullName, severity, day, times);
}

function summary(fields: Partial<ArchiveSummary> & Pick<ArchiveSummary, "activity" | "covers_s">): ArchiveSummary {
  return {
    place: null,
    distance_m: null,
    top_speed_kmh: null,
    soc_start_pct: null,
    soc_end_pct: null,
    ts_on_s: null,
    faults: [],
    ...fields
  };
}

/** Fixture runs, newest first. */
export function fixtureRuns(today = melbourneToday()): ArchiveRun[] {
  const saturday = shiftDay(today, -3);
  const older = shiftDay(today, -16);
  const run = (day: string, time: string, fields: Partial<ArchiveRun> & Pick<ArchiveRun, "duration_s">) => {
    const weekday = WEEKDAYS[new Date(day + "T00:00:00Z").getUTCDay()];
    const name = `${day}_${weekday}_${time.replaceAll(":", "-")}`;
    const run: ArchiveRun = {
      name,
      start: `${day}T${time}${OFFSET}`,
      dated: true,
      state: "complete",
      end: "clean_stop",
      on_car_s: 0,
      size_bytes: Math.round(fields.duration_s * 40_000),
      summary: null,
      ...fields
    };
    const start = Date.parse(run.start!);
    run.summary?.faults.forEach((fault) => {
      fault.at_s = fault.times.map((time) => (Date.parse(time) - start) / 1000) as ArchiveFault["at_s"];
    });
    return run;
  };
  return [
    run(today, "15:40:12", {
      duration_s: 545,
      state: "recording",
      end: null,
      on_car_s: 125,
      summary: summary({
        activity: "driving",
        covers_s: 420,
        place: "Test track",
        distance_m: 7100,
        top_speed_kmh: 94,
        soc_start_pct: 62,
        soc_end_pct: 49
      })
    }),
    run(today, "14:55:03", {
      duration_s: 1080,
      state: "uploading",
      on_car_s: 420,
      summary: summary({
        activity: "driving",
        covers_s: 660,
        place: "Test track",
        distance_m: 13400,
        top_speed_kmh: 92,
        soc_start_pct: 90,
        soc_end_pct: 62,
        faults: [faultOf("cellUndervoltage", today, ["15:06"])]
      })
    }),
    run(today, "13:20:41", {
      duration_s: 1860,
      summary: summary({
        activity: "driving",
        covers_s: 1860,
        place: "Test track",
        distance_m: 23600,
        top_speed_kmh: 97,
        soc_start_pct: 97,
        soc_end_pct: 55,
        faults: [faultOf("inverterOvertemp", today, ["13:37"])]
      })
    }),
    run(today, "12:41:09", {
      duration_s: 362,
      end: "power_off",
      summary: summary({
        activity: "parked",
        covers_s: 362,
        place: "Test track pits",
        soc_start_pct: 97,
        soc_end_pct: 97,
        ts_on_s: 130
      })
    }),
    run(today, "11:40:17", {
      duration_s: 190,
      end: "power_off",
      summary: summary({
        activity: "driving",
        covers_s: 190,
        place: "Test track",
        distance_m: 1900,
        top_speed_kmh: 71,
        soc_start_pct: 72,
        soc_end_pct: 70,
        faults: [faultOf("amsTrip", today, ["11:42"])]
      })
    }),
    run(today, "10:05:55", {
      duration_s: 1320,
      summary: summary({
        activity: "driving",
        covers_s: 1320,
        place: "Test track",
        distance_m: 16900,
        top_speed_kmh: 88,
        soc_start_pct: 93,
        soc_end_pct: 72,
        faults: [faultOf("brakeSensor", today, ["10:19", "10:24"]), faultOf("inverterOvertemp", today, ["10:22"])]
      })
    }),
    run(today, "09:31:20", { duration_s: 840 }),
    run(today, "09:12:02", {
      duration_s: 240,
      end: "power_off",
      summary: summary({
        activity: "parked",
        covers_s: 240,
        place: "Test track pits",
        soc_start_pct: 100,
        soc_end_pct: 100,
        ts_on_s: 0
      })
    }),
    run(saturday, "14:02:11", {
      duration_s: 1560,
      state: "uploading",
      end: "power_off",
      on_car_s: 300,
      summary: summary({
        activity: "driving",
        covers_s: 1260,
        place: "Carpark",
        distance_m: 7800,
        top_speed_kmh: 54,
        soc_start_pct: 95,
        soc_end_pct: 74,
        faults: [faultOf("cellUndervoltage", saturday, ["14:11"])]
      })
    }),
    run(saturday, "11:31:48", {
      duration_s: 720,
      end: "power_off",
      summary: summary({ activity: "parked", covers_s: 720, soc_start_pct: 95, soc_end_pct: 95, ts_on_s: 0 })
    }),
    run(older, "15:44:09", {
      duration_s: 2220,
      summary: summary({
        activity: "driving",
        covers_s: 2220,
        place: "Test track",
        distance_m: 27000,
        top_speed_kmh: 89,
        soc_start_pct: 98,
        soc_end_pct: 41,
        faults: [
          faultOf("imdTrip", older, ["16:19"]),
          faultOf("motorDerate", older, ["16:02"]),
          faultOf("inverterOvertemp", older, ["16:05", "16:09"])
        ]
      })
    }),
    // A legacy name, its start derived from the microsecond timestamp.
    {
      name: "run_1761900000000000_9f3a",
      start: "2025-10-31T19:40:00+11:00",
      dated: true,
      duration_s: 300,
      state: "complete",
      end: "power_off",
      on_car_s: 0,
      size_bytes: 12_000_000,
      summary: null
    },
    // Never dated: the car's clock never synced.
    {
      name: "pending_3",
      start: null,
      dated: false,
      duration_s: 95,
      state: "complete",
      end: "power_off",
      on_car_s: 0,
      size_bytes: 3_800_000,
      summary: null
    }
  ];
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers":
    "content-range, content-length, content-disposition, etag, retry-after, accept-ranges"
};

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...CORS,
    ...headers
  });
  res.end(JSON.stringify(body));
}

/** When the server first saw each run without a start. Older than every fixture, so it lists last. */
const FIRST_SEEN: Record<string, string> = { pending_3: "2025-10-01T09:00:00+10:00" };

/** The contract's order: newest first by `start` when not null, else first-seen time; ties by name, descending. */
export function sortRuns(runs: ArchiveRun[]): ArchiveRun[] {
  const key = (run: ArchiveRun) => Date.parse(run.start ?? FIRST_SEEN[run.name] ?? "1970-01-01T00:00:00Z");
  return [...runs].sort((a, b) => key(b) - key(a) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

export class MockArchive {
  readonly opts: ArchiveOptions;
  readonly runs: ArchiveRun[];
  private prepared = new Set<string>();
  private dropped = new Set<string>();

  constructor(opts: ArchiveOptions) {
    this.opts = opts;
    this.runs = sortRuns(fixtureRuns(opts.today));
  }

  /** Handles /api/v1/archive/...; returns false for other paths. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
    const path = url.pathname.replace(/\/+$/, "");
    if (!path.startsWith("/api/v1/archive")) return false;
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "method_not_allowed", message: "Use GET" });
      return true;
    }
    if (path === "/api/v1/archive/runs") {
      this.list(res, url);
      return true;
    }
    const file = /^\/api\/v1\/archive\/runs\/([^/]+)\/file$/.exec(path);
    if (file) {
      if (this.checkVehicle(res, url)) this.file(req, res, decodeURIComponent(file[1]));
      return true;
    }
    json(res, 404, { error: "not_found", message: `No route for ${req.method} ${url.pathname}` });
    return true;
  }

  /** Both routes take `?vehicle=`: 400 when missing or malformed, 404 for another vehicle. */
  private checkVehicle(res: http.ServerResponse, url: URL): boolean {
    const vehicle = url.searchParams.get("vehicle");
    if (vehicle === null || !/^[a-z0-9_-]+$/.test(vehicle)) {
      json(res, 400, { error: "bad_request", message: "vehicle is missing or malformed" });
      return false;
    }
    if (vehicle !== "mur27") {
      json(res, 404, { error: "unknown_vehicle", message: `No vehicle ${vehicle}` });
      return false;
    }
    return true;
  }

  private list(res: http.ServerResponse, url: URL) {
    if (!this.checkVehicle(res, url)) return;
    const limitText = url.searchParams.get("limit") ?? "100";
    const limit = Number(limitText);
    if (!/^\d+$/.test(limitText) || limit < 1 || limit > 500) {
      return json(res, 400, { error: "bad_request", message: "limit must be an integer from 1 to 500" });
    }
    const runs = this.runs;
    const before = url.searchParams.get("before");
    let start = 0;
    if (before !== null) {
      const index = runs.findIndex((run) => run.name === before);
      if (index < 0) return json(res, 400, { error: "unknown_cursor", message: `No run ${before}` });
      start = index + 1;
    }
    const page = runs.slice(start, start + limit);
    const next = start + limit < runs.length ? page[page.length - 1].name : null;
    json(res, 200, { version: 1, runs: page, next }, { "cache-control": "no-cache" });
  }

  private file(req: http.IncomingMessage, res: http.ServerResponse, name: string) {
    const run = this.runs.find((run) => run.name === name);
    if (run === undefined) return json(res, 404, { error: "unknown_run", message: `No run ${name}` });
    if (run.on_car_s !== null && run.on_car_s >= run.duration_s) {
      return json(res, 409, { error: "no_data", message: "No part of this run has reached the server yet" });
    }
    if (this.opts.prepare && run.state !== "complete" && !this.prepared.has(name)) {
      this.prepared.add(name);
      return json(res, 202, { state: "preparing" }, { "retry-after": "1" });
    }

    const body = runFile();
    const etag = `"${name}-${body.length}"`;
    const headers: Record<string, string> = {
      ...CORS,
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${name}.mf4"`,
      "accept-ranges": "bytes",
      "cache-control": "no-cache",
      etag
    };
    const range = req.headers.range;
    const ifRange = req.headers["if-range"];
    // One range (bytes=a-b, a- or -n) answers 206; several ranges or a stale If-Range get the whole file.
    const match = range === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] !== "" || match[2] !== "") && (ifRange === undefined || ifRange === etag)) {
      let first: number;
      let last: number;
      if (match[1] === "") {
        first = Math.max(0, body.length - Number(match[2]));
        last = body.length - 1;
      } else {
        first = Number(match[1]);
        last = match[2] !== "" ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
      }
      if (first >= body.length || first > last) {
        res.writeHead(416, {
          ...headers,
          "content-type": "application/json",
          "content-range": `bytes */${body.length}`
        });
        return void res.end(
          JSON.stringify({ error: "range_not_satisfiable", message: "The range starts past the end of the file" })
        );
      }
      const slice = body.subarray(first, last + 1);
      res.writeHead(206, {
        ...headers,
        "content-range": `bytes ${first}-${last}/${body.length}`,
        "content-length": String(slice.length)
      });
      return void res.end(req.method === "HEAD" ? undefined : slice);
    }

    res.writeHead(200, { ...headers, "content-length": String(body.length) });
    if (req.method === "HEAD") return void res.end();
    if (this.opts.dropOnce && !this.dropped.has(name)) {
      this.dropped.add(name);
      res.write(body.subarray(0, Math.floor(body.length / 2)), () => {
        setTimeout(() => res.destroy(), 20);
      });
      return;
    }
    res.end(body);
  }
}
