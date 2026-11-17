// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// One Download or Open in the Download runs popup: fetches each run's file in turn and reports progress.
// Lite and the Electron main process both run it; only the sinks differ.

import { ArchiveClient, ArchiveError, RunTransfer, TransferSink } from "./archive";

export type JobKind = "download" | "open";
export type JobPhase = "preparing" | "fetching" | "failed" | "finishing" | "done";

/** Sent to the popup on every change. */
export interface JobState {
  kind: JobKind;
  names: string[];
  /** Index into `names` of the run being fetched. */
  index: number;
  phase: JobPhase;
  /** Bytes of the current run. */
  received: number;
  total: number | null;
  /** Bytes of the runs already finished. */
  finishedBytes: number;
  retryInS: number | null;
  error: string | null;
  /** After a download: where the files went, e.g. "Downloads". */
  destination: string | null;
}

export interface JobSink extends TransferSink {
  /** The run is complete: save or open it. */
  finish(): Promise<void>;
  /** Cancelled: drop any partial output. */
  discard(): Promise<void>;
}

export class ArchiveJob {
  readonly state: JobState;
  private readonly client: ArchiveClient;
  private readonly makeSink: (name: string) => JobSink | Promise<JobSink>;
  private readonly onUpdate: (state: JobState) => void;
  private controller: AbortController | null = null;
  private transfer: RunTransfer | null = null;
  private sink: JobSink | null = null;
  private cancelled = false;

  constructor(
    client: ArchiveClient,
    kind: JobKind,
    names: string[],
    makeSink: (name: string) => JobSink | Promise<JobSink>,
    onUpdate: (state: JobState) => void,
    destination: string | null = null
  ) {
    this.client = client;
    this.makeSink = makeSink;
    this.onUpdate = onUpdate;
    this.state = {
      kind,
      names,
      index: 0,
      phase: "preparing",
      received: 0,
      total: null,
      finishedBytes: 0,
      retryInS: null,
      error: null,
      destination
    };
  }

  get running(): boolean {
    return !this.cancelled && this.state.phase !== "done" && this.state.phase !== "failed";
  }

  /** Starts, or after a failure resumes from where the current run stopped. Resolves true when done. */
  async run(): Promise<boolean> {
    if (this.cancelled || this.controller !== null) return false;
    const controller = new AbortController();
    this.controller = controller;
    this.update({ phase: this.transfer?.received ? "fetching" : "preparing", error: null, retryInS: null });
    try {
      while (this.state.index < this.state.names.length) {
        const name = this.state.names[this.state.index];
        if (this.transfer === null) {
          this.sink = await this.makeSink(name);
          this.transfer = new RunTransfer(this.client, name, this.sink, (progress) => {
            if (progress.phase === "preparing") this.update({ phase: "preparing", retryInS: progress.retryInS });
            else this.update({ phase: "fetching", received: progress.received, total: progress.total, retryInS: null });
          });
        }
        await this.transfer.run(controller.signal);
        if (this.cancelled) return false;
        this.update({ phase: "finishing" });
        await this.sink!.finish();
        this.state.finishedBytes += this.transfer.received;
        this.transfer = null;
        this.sink = null;
        this.update({ index: this.state.index + 1, received: 0, total: null });
      }
      this.update({ phase: "done", index: this.state.names.length - 1 });
      return true;
    } catch (error) {
      if (this.cancelled || (error instanceof ArchiveError && error.kind === "aborted")) return false;
      if (error instanceof ArchiveError && error.kind !== "network") {
        // Not resumable: the next try starts this run again.
        await this.sink?.discard().catch(() => {});
        this.transfer = null;
        this.sink = null;
      }
      this.update({ phase: "failed", error: describeJobError(error) });
      return false;
    } finally {
      this.controller = null;
    }
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.controller?.abort();
    const sink = this.sink;
    this.sink = null;
    this.transfer = null;
    if (this.state.phase !== "done") void sink?.discard().catch(() => {});
  }

  private update(changes: Partial<JobState>) {
    Object.assign(this.state, changes);
    if (!this.cancelled) this.onUpdate({ ...this.state });
  }
}

export function describeJobError(error: unknown): string {
  if (error instanceof ArchiveError) {
    if (error.kind === "not_found") return "This run isn't on the server";
    if (error.kind === "no_data") return error.message + "; try again once it uploads";
    if (error.kind === "network") return "Connection lost";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
