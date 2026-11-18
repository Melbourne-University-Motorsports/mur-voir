// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// Client for the read-only run archive API v1 (GET /api/v1/archive/...). It has no dependencies, so the
// Lite page, the Electron main process and the mock backend can all import it.

import type { Fault, Run, Severity, Summary } from "./archive-types.ts";

export const ARCHIVE_API_VERSION = 1;
export const DEFAULT_VEHICLE = "mur27";
/** Hosted Lite. Run links always point here, so a link copied in the desktop app opens for anyone. */
export const HOSTED_LITE_ORIGIN = "https://voir.melbourneuniracing.com";

// Wire types are generated from the pinned mur-msgs schema (archive-api/, npm run archive-api:generate).
export type ArchiveFault = Fault;
export type ArchiveSummary = Summary;
export type ArchiveRun = Run;
export type FaultSeverity = Severity;
export type RunState = Run["state"];

export interface ArchiveRunsPage {
  version: number;
  runs: ArchiveRun[];
  next: string | null;
}

export type ArchiveErrorKind = "network" | "http" | "not_found" | "no_data" | "bad_response" | "aborted";

export class ArchiveError extends Error {
  readonly kind: ArchiveErrorKind;
  readonly status: number | null;

  constructor(kind: ArchiveErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "ArchiveError";
    this.kind = kind;
    this.status = status;
  }
}

/** The subset of `fetch` the client uses, so tests and Node can pass their own. */
export type ArchiveFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<Response>;

/** A run is identified by its vehicle and name together; names are only unique per vehicle. */
export interface RunRef {
  vehicle: string;
  name: string;
}

/** Vehicle ids, as the archive API's `vehicle` parameter accepts them. */
export function isVehicleId(vehicle: unknown): vehicle is string {
  return typeof vehicle === "string" && /^[a-z0-9_-]{1,64}$/.test(vehicle);
}

/** Run names use only A-Z a-z 0-9 _ -, so they are safe in a URL path and a file name. */
export function isRunName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(name);
}

/** Normalises a server address ("host:port", "http://host:port/", origin) to a base URL without a slash. */
export function archiveBase(address: string): string {
  const withScheme = /^[a-z]+:\/\//i.test(address) ? address : "http://" + address;
  const url = new URL(withScheme);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const isNumberOrNull = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value));
const isStringOrNull = (value: unknown) => value === null || typeof value === "string";

function validFault(value: unknown): value is ArchiveFault {
  return (
    isObject(value) &&
    typeof value.signal === "string" &&
    (value.code === null || Number.isInteger(value.code)) &&
    typeof value.name === "string" &&
    typeof value.full_name === "string" &&
    (value.severity === "shutdown" || value.severity === "warning") &&
    Array.isArray(value.times) &&
    value.times.every((time) => typeof time === "string")
  );
}

/** Fills `at_s` and `count` for a server older than the schema, so one missing field doesn't hide a run. */
function normaliseFault(fault: ArchiveFault): ArchiveFault {
  const atS = Array.isArray(fault.at_s) && fault.at_s.every((s) => typeof s === "number") ? fault.at_s : [];
  const count = Number.isInteger(fault.count) && fault.count > 0 ? fault.count : Math.max(1, fault.times.length);
  return { ...fault, at_s: atS as ArchiveFault["at_s"], count };
}

function validSummary(value: unknown): value is ArchiveSummary {
  return (
    isObject(value) &&
    typeof value.covers_s === "number" &&
    (value.activity === "driving" || value.activity === "parked") &&
    isStringOrNull(value.place) &&
    ["distance_m", "top_speed_kmh", "soc_start_pct", "soc_end_pct", "ts_on_s"].every((key) =>
      isNumberOrNull(value[key])
    ) &&
    Array.isArray(value.faults) &&
    value.faults.every(validFault)
  );
}

export function validRun(value: unknown): value is ArchiveRun {
  return (
    isObject(value) &&
    isRunName(value.name) &&
    isStringOrNull(value.start) &&
    typeof value.dated === "boolean" &&
    typeof value.duration_s === "number" &&
    (value.state === "recording" || value.state === "uploading" || value.state === "complete") &&
    (value.end === null || value.end === "power_off" || value.end === "clean_stop") &&
    isNumberOrNull(value.on_car_s) &&
    typeof value.size_bytes === "number" &&
    (value.summary === null || validSummary(value.summary))
  );
}

/** Checks a runs response. Runs that fail validation are dropped rather than failing the whole list. */
export function parseRunsPage(body: unknown): ArchiveRunsPage {
  if (!isObject(body) || !Array.isArray(body.runs)) {
    throw new ArchiveError("bad_response", "The archive answered with an unexpected format.");
  }
  if (body.version !== ARCHIVE_API_VERSION) {
    throw new ArchiveError("bad_response", `The archive speaks API version ${String(body.version)}, not 1.`);
  }
  const next = isRunName(body.next) ? body.next : null;
  const runs = body.runs
    .filter(validRun)
    .map((run) =>
      run.summary === null
        ? run
        : { ...run, summary: { ...run.summary, faults: run.summary.faults.map(normaliseFault) } }
    );
  return { version: ARCHIVE_API_VERSION, runs, next };
}

/** Seconds from a Retry-After header (delta seconds or an HTTP date), clamped to 1..30. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number {
  let seconds = 2;
  if (header !== null) {
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) seconds = Number(trimmed);
    else if (!Number.isNaN(Date.parse(trimmed))) seconds = (Date.parse(trimmed) - now) / 1000;
  }
  return Math.min(30, Math.max(1, Math.round(seconds)));
}

function abortError(): ArchiveError {
  return new ArchiveError("aborted", "Cancelled");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class ArchiveClient {
  readonly base: string;
  readonly vehicle: string;
  /** Waits between 202 retries; tests pass one that returns at once. */
  readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly fetchImpl: ArchiveFetch;

  constructor(
    base: string,
    fetchImpl: ArchiveFetch = (url, init) => fetch(url, init),
    vehicle = DEFAULT_VEHICLE,
    wait: (ms: number, signal?: AbortSignal) => Promise<void> = sleep
  ) {
    this.base = base;
    this.fetchImpl = fetchImpl;
    this.vehicle = vehicle;
    this.wait = wait;
  }

  runsUrl(options: { limit?: number; before?: string | null } = {}): string {
    const params = new URLSearchParams({ vehicle: this.vehicle, limit: String(options.limit ?? 100) });
    if (options.before) params.set("before", options.before);
    return `${this.base}/api/v1/archive/runs?${params}`;
  }

  fileUrl(name: string): string {
    const params = new URLSearchParams({ vehicle: this.vehicle });
    return `${this.base}/api/v1/archive/runs/${encodeURIComponent(name)}/file?${params}`;
  }

  async listRuns(options: { limit?: number; before?: string | null; signal?: AbortSignal } = {}) {
    const response = await this.request(this.runsUrl(options), {}, options.signal);
    if (!response.ok) throw await httpError(response);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ArchiveError("bad_response", "The archive answered with something that isn't JSON.");
    }
    return parseRunsPage(body);
  }

  /** One request with network failures and aborts mapped to ArchiveError. */
  async request(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) throw abortError();
    try {
      return await this.fetchImpl(url, { headers, signal });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw new ArchiveError("network", `No answer from ${this.base} (${describe(error)})`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function httpError(response: Response): Promise<ArchiveError> {
  let message = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (isObject(body) && typeof body.message === "string") message += `: ${body.message}`;
  } catch {}
  if (response.status === 409) {
    return new ArchiveError("no_data", "None of this run has reached the server yet", 409);
  }
  return new ArchiveError(response.status === 404 ? "not_found" : "http", message, response.status);
}

/** Where a transfer writes. Lite keeps chunks in memory; Electron writes a file. */
export interface TransferSink {
  write(chunk: Uint8Array): void | Promise<void>;
  /** Drops everything written so far (the server sent the whole file again). */
  reset(): void | Promise<void>;
  /** Bytes actually held (on disk for a file), checked before a 416 counts as complete. */
  size(): number | Promise<number>;
}

export type TransferProgress =
  | { phase: "preparing"; retryInS: number }
  | { phase: "fetching"; received: number; total: number | null };

/**
 * Fetches one run's merged MF4. Call `run()` to start; after a network failure call it again to
 * resume with a Range request from the bytes already received. If the file changed in between (new
 * parts arrived, so a new ETag) the server answers 200 and the transfer starts over.
 */
export class RunTransfer {
  received = 0;
  total: number | null = null;
  etag: string | null = null;

  readonly name: string;
  private readonly client: ArchiveClient;
  private readonly sink: TransferSink;
  private readonly onProgress: (progress: TransferProgress) => void;

  constructor(
    client: ArchiveClient,
    name: string,
    sink: TransferSink,
    onProgress: (progress: TransferProgress) => void = () => {}
  ) {
    this.client = client;
    this.name = name;
    this.sink = sink;
    this.onProgress = onProgress;
  }

  async run(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const headers: Record<string, string> = {};
      if (this.received > 0) {
        headers.Range = `bytes=${this.received}-`;
        if (this.etag) headers["If-Range"] = this.etag;
      }
      const response = await this.client.request(this.client.fileUrl(this.name), headers, signal);

      if (response.status === 202) {
        await response.body?.cancel().catch(() => {});
        const retryInS = retryAfterSeconds(response.headers.get("Retry-After"));
        this.onProgress({ phase: "preparing", retryInS });
        await this.client.wait(retryInS * 1000, signal);
        continue;
      }
      if (response.status === 416 && this.received > 0) {
        // Nothing past what we have. That's complete only if the bytes held are the whole file;
        // otherwise (a short or missing partial file, or the file shrank) start over.
        await response.body?.cancel().catch(() => {});
        if (this.total !== null && this.received === this.total && (await this.sink.size()) === this.total) return;
        await this.sink.reset();
        this.received = 0;
        this.etag = null;
        continue;
      }
      if (response.status !== 200 && response.status !== 206) throw await httpError(response);

      if (response.status === 200 && this.received > 0) {
        // Whole file again: the range was ignored or the file changed.
        await this.sink.reset();
        this.received = 0;
      }
      if (response.status === 206) {
        const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(response.headers.get("Content-Range") ?? "");
        if (range === null || Number(range[1]) !== this.received) {
          throw new ArchiveError("bad_response", "The archive resumed the download from the wrong place.");
        }
        if (range[2] !== "*") this.total = Number(range[2]);
      } else {
        const length = response.headers.get("Content-Length");
        this.total = length !== null && /^\d+$/.test(length) ? Number(length) : null;
      }
      this.etag = response.headers.get("ETag") ?? this.etag;
      this.onProgress({ phase: "fetching", received: this.received, total: this.total });

      if (response.body === null) {
        await this.write(new Uint8Array(await response.arrayBuffer()));
      } else {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await this.write(value);
          }
        } catch (error) {
          if (signal?.aborted) throw abortError();
          throw new ArchiveError("network", "The connection dropped: " + describe(error));
        }
      }
      if (this.total !== null && this.received < this.total) {
        throw new ArchiveError("network", "The connection dropped before the run finished downloading.");
      }
      return;
    }
  }

  private async write(chunk: Uint8Array) {
    await this.sink.write(chunk);
    this.received += chunk.byteLength;
    this.onProgress({ phase: "fetching", received: this.received, total: this.total });
  }
}

/** Chunks are folded into a Blob once this many bytes are waiting. */
const MEMORY_SINK_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * Collects a transfer in memory (Lite) as Blob parts. Each batch of chunks is copied into the browser's
 * blob store once and the chunks are dropped, so a run is held once, not as chunks plus a joined copy,
 * and the browser can page large blobs to disk. `blob()` and `file()` reference the parts without copying.
 */
export class MemorySink implements TransferSink {
  private parts: Blob[] = [];
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private bytes = 0;

  write(chunk: Uint8Array) {
    this.pending.push(chunk);
    this.pendingBytes += chunk.byteLength;
    this.bytes += chunk.byteLength;
    if (this.pendingBytes >= MEMORY_SINK_BATCH_BYTES) this.flush();
  }

  reset() {
    this.parts = [];
    this.pending = [];
    this.pendingBytes = 0;
    this.bytes = 0;
  }

  size() {
    return this.bytes;
  }

  /** Bytes still held as chunks, not yet in a Blob (at most one batch). */
  get unflushedBytes(): number {
    return this.pendingBytes;
  }

  blob(type = "application/octet-stream"): Blob {
    this.flush();
    return new Blob(this.parts, { type });
  }

  file(name: string): File {
    this.flush();
    return new File(this.parts, name, { type: "application/octet-stream" });
  }

  private flush() {
    if (this.pending.length === 0) return;
    this.parts.push(new Blob(this.pending as BlobPart[]));
    this.pending = [];
    this.pendingBytes = 0;
  }
}

/** The shareable link for a run: `?vehicle=<id>&run=<name>`, as the archive contract specifies. */
export function runLink(run: RunRef, origin = HOSTED_LITE_ORIGIN): string {
  const url = new URL(origin);
  url.search = "";
  url.hash = "";
  url.searchParams.set("vehicle", run.vehicle);
  url.searchParams.set("run", run.name);
  return url.toString();
}

/**
 * The run named by `?run=` (and `?vehicle=`) in a page URL, or null when missing or not valid. Links made
 * before the vehicle was added carry only `run`; those mean the default vehicle.
 */
export function readRunParam(href: string): RunRef | null {
  const params = new URL(href).searchParams;
  const name = params.get("run");
  const vehicle = params.get("vehicle") ?? DEFAULT_VEHICLE;
  return isRunName(name) && isVehicleId(vehicle) ? { vehicle, name } : null;
}

/** `href` with `?vehicle=` and `?run=` set to `run`, or both removed when `run` is null. Other parameters are kept. */
export function withRunParam(href: string, run: RunRef | null): string {
  const url = new URL(href);
  if (run === null) {
    url.searchParams.delete("vehicle");
    url.searchParams.delete("run");
  } else {
    url.searchParams.set("vehicle", run.vehicle);
    url.searchParams.set("run", run.name);
  }
  return url.toString();
}

export function sameRun(a: RunRef | null, b: RunRef | null): boolean {
  return a === b || (a !== null && b !== null && a.vehicle === b.vehicle && a.name === b.name);
}
