// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// File > Download Runs… in the desktop app. The popup page (www/download.html) is shared with Lite; this
// side talks to the archive at the MUR connection address, saves files and opens runs in the hub.

import { app, BrowserWindow, clipboard, dialog, MessageChannelMain, MessagePortMain } from "electron";
import fs from "fs";
import path from "path";
import NamedMessage from "../../shared/NamedMessage";
import { archiveBase, ArchiveClient, runLink } from "../../shared/mur/archive";
import { ArchiveJob, JobKind, JobSink } from "../../shared/mur/archiveJob";
import { WINDOW_ICON } from "./ElectronConstants";

/** What a hub window shows, reported by the hub every time it changes ("set-view-source"). */
export interface ViewSource {
  live: boolean;
  run: string | null;
  archiveAddress: string;
}

const FALLBACK_ADDRESS = "http://localhost:8090";

/** Writes a run to `<final>.part` and renames it when complete. */
function fileSink(finalPath: string, onFinished: () => void | Promise<void>): JobSink {
  const partPath = finalPath + ".part";
  let handle: fs.promises.FileHandle | null = null;
  let offset = 0;
  const open = async () => (handle ??= await fs.promises.open(partPath, "w"));
  return {
    async write(chunk) {
      await (await open()).write(chunk, 0, chunk.byteLength, offset);
      offset += chunk.byteLength;
    },
    async reset() {
      await (await open()).truncate(0);
      offset = 0;
    },
    async finish() {
      await (await open()).close();
      handle = null;
      await fs.promises.rename(partPath, finalPath);
      await onFinished();
    },
    async discard() {
      await handle?.close().catch(() => {});
      handle = null;
      await fs.promises.rm(partPath, { force: true });
    }
  };
}

export class DownloadRuns {
  private readonly sendToHub: (window: BrowserWindow, name: string, data?: unknown) => void;
  private readonly viewSources = new Map<number, ViewSource>();
  private popup: BrowserWindow | null = null;
  private port: MessagePortMain | null = null;
  private parent: BrowserWindow | null = null;
  private job: ArchiveJob | null = null;

  constructor(sendToHub: (window: BrowserWindow, name: string, data?: unknown) => void) {
    this.sendToHub = sendToHub;
  }

  setViewSource(hub: BrowserWindow, source: ViewSource) {
    this.viewSources.set(hub.id, source);
    if (hub === this.parent) this.send("set-context", { live: source.live, run: source.run });
  }

  forgetWindow(hub: BrowserWindow) {
    this.viewSources.delete(hub.id);
  }

  /** The same hosted Lite link Lite copies, so anyone can open it. */
  copyLink(hub: BrowserWindow, name: string) {
    const link = runLink(name);
    clipboard.writeText(link);
    this.sendToHub(hub, "run-link-copied", { ok: true, link });
  }

  open(parent: BrowserWindow) {
    if (this.popup !== null && !this.popup.isDestroyed()) {
      this.popup.focus();
      return;
    }
    const width = 720;
    const height = 500;
    const bounds = parent.getBounds();
    const popup = new BrowserWindow({
      width,
      height,
      minWidth: 560,
      minHeight: 340,
      x: Math.floor(bounds.x + bounds.width / 2 - width / 2),
      y: Math.floor(bounds.y + bounds.height / 2 - height / 2),
      useContentSize: true,
      title: "Download Runs",
      icon: WINDOW_ICON,
      show: false,
      fullscreenable: false,
      webPreferences: { preload: path.join(__dirname, "preload.js") }
    });
    this.popup = popup;
    this.parent = parent;

    popup.setMenu(null);
    popup.setMenuBarVisibility(false);
    popup.once("ready-to-show", () => popup.show());
    popup.on("closed", () => {
      this.job?.cancel();
      this.job = null;
      this.port = null;
      if (this.popup === popup) this.popup = null;
    });
    popup.on("blur", () => this.send("set-focused", false));
    popup.on("focus", () => this.send("set-focused", true));
    popup.webContents.on("dom-ready", () => {
      const { port1, port2 } = new MessageChannelMain();
      popup.webContents.postMessage("port", null, [port1]);
      this.port = port2;
      port2.on("message", (event) => void this.handle(event.data as NamedMessage));
      port2.start();
      const source = this.viewSources.get(parent.id);
      this.send("set-context", { live: source?.live ?? false, run: source?.run ?? null });
      this.send("set-platform", process.platform);
    });
    popup.loadFile(path.join(__dirname, "../www/download.html"));
  }

  private send(name: string, data?: unknown) {
    try {
      this.port?.postMessage({ name, data });
    } catch {}
  }

  /** The archive lives on the server the hub's MUR source connects to (or would connect to). */
  private client(): ArchiveClient {
    const address = (this.parent && this.viewSources.get(this.parent.id)?.archiveAddress) || FALLBACK_ADDRESS;
    return new ArchiveClient(archiveBase(address));
  }

  private async handle(message: NamedMessage) {
    const client = this.client();
    switch (message.name) {
      case "load":
        try {
          const page = await client.listRuns({ before: message.data.before });
          this.send("set-runs", { ...page, append: message.data.before !== null });
        } catch (error) {
          this.send("list-error", error instanceof Error ? error.message : String(error));
        }
        break;

      case "download":
        await this.download(client, message.data);
        break;

      case "open":
        await this.openRun(client, message.data.name);
        break;

      case "retry":
        if (this.job !== null && !this.job.running) void this.runJob(this.job);
        break;

      case "cancel-job":
        this.job?.cancel();
        this.job = null;
        this.send("set-job", null);
        break;

      case "copy-link": {
        const link = runLink(message.data);
        clipboard.writeText(link);
        this.send("link-copied", { ok: true, link });
        break;
      }

      case "close":
        this.popup?.close();
        break;
    }
  }

  /** Asks where to save, like the old download window: a file for one run, a folder for several. */
  private async download(client: ArchiveClient, names: string[]) {
    if (this.popup === null || this.job?.running || names.length === 0) return;
    let target: (name: string) => string;
    let destination: string;
    if (names.length === 1) {
      const result = await dialog.showSaveDialog(this.popup, {
        title: "Save run",
        defaultPath: path.join(app.getPath("downloads"), names[0] + ".mf4"),
        properties: ["createDirectory", "showOverwriteConfirmation", "dontAddToRecent"],
        filters: [{ name: "MF4 log", extensions: ["mf4"] }]
      });
      if (result.canceled || !result.filePath) return;
      const filePath = result.filePath;
      target = () => filePath;
      destination = path.basename(path.dirname(filePath));
    } else {
      const result = await dialog.showOpenDialog(this.popup, {
        title: "Select save location for runs",
        buttonLabel: "Save",
        properties: ["openDirectory", "createDirectory", "dontAddToRecent"]
      });
      if (result.canceled || result.filePaths.length === 0) return;
      const folder = result.filePaths[0];
      target = (name) => path.join(folder, name + ".mf4");
      destination = path.basename(folder);
    }
    this.startJob(client, "download", names, (name) => fileSink(target(name), () => {}), destination);
  }

  /** Fetches the run to a cache file and opens it in the parent hub, replacing what it shows. */
  private async openRun(client: ArchiveClient, name: string) {
    if (this.job?.running) return;
    const folder = path.join(app.getPath("temp"), "mur-voir-runs");
    await fs.promises.mkdir(folder, { recursive: true });
    const parent = this.parent;
    this.startJob(client, "open", [name], () =>
      fileSink(path.join(folder, name + ".mf4"), () => {
        if (parent === null || parent.isDestroyed()) return;
        this.sendToHub(parent, "open-files", { files: [path.join(folder, name + ".mf4")], merge: false, run: name });
      })
    );
  }

  private startJob(
    client: ArchiveClient,
    kind: JobKind,
    names: string[],
    makeSink: (name: string) => JobSink,
    destination: string | null = null
  ) {
    this.job?.cancel();
    const job = new ArchiveJob(
      client,
      kind,
      names,
      makeSink,
      (state) => {
        if (this.job === job) this.send("set-job", state);
      },
      destination
    );
    this.job = job;
    void this.runJob(job);
  }

  private async runJob(job: ArchiveJob) {
    const done = await job.run();
    if (!done || this.job !== job || job.state.kind !== "open") return;
    this.job = null;
    this.popup?.close();
    if (this.parent !== null && !this.parent.isDestroyed()) this.parent.focus();
  }
}
