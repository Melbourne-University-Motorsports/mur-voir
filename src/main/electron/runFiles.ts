// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// Files for Download runs in the desktop app: the .part file a run downloads into, free file names
// when saving several runs to a folder, and the cache folder runs are opened from. No Electron imports,
// so tests can run it in Node.

import fs from "fs";
import path from "path";
import type { JobSink } from "../../shared/mur/archiveJob";

const exists = (file: string) =>
  fs.promises.access(file).then(
    () => true,
    () => false
  );

/**
 * Writes a run to `<final>.part` and renames it when complete. A resumed transfer keeps what the .part
 * file already holds: only a new transfer (or the server sending the whole file again) empties it.
 */
export function fileSink(finalPath: string, onFinished: () => void | Promise<void> = () => {}): JobSink {
  const partPath = finalPath + ".part";
  let handle: fs.promises.FileHandle | null = null;
  let started = false;
  let offset = 0;
  const open = async () => {
    if (handle === null) {
      // "w" empties a stale .part from an earlier session; after that, "r+" never truncates.
      handle = await fs.promises.open(partPath, started ? "r+" : "w");
      started = true;
    }
    return handle;
  };
  const close = async () => {
    const open = handle;
    handle = null;
    await open?.close();
  };
  const sizeOf = (file: string) =>
    fs.promises.stat(file).then(
      (stat) => stat.size,
      () => 0
    );
  return {
    async write(chunk) {
      await (await open()).write(chunk, 0, chunk.byteLength, offset);
      offset += chunk.byteLength;
    },
    async reset() {
      await (await open()).truncate(0);
      offset = 0;
    },
    async size() {
      if (handle !== null) return (await handle.stat()).size;
      return sizeOf(partPath);
    },
    async finish(size) {
      await close();
      const held = await sizeOf(partPath);
      if (held !== size) throw new Error(`The downloaded file has ${held} of ${size} bytes`);
      await fs.promises.rename(partPath, finalPath);
      const saved = await sizeOf(finalPath);
      if (saved !== size) throw new Error(`The saved file has ${saved} of ${size} bytes`);
      await onFinished();
    },
    async discard() {
      await close().catch(() => {});
      await fs.promises.rm(partPath, { force: true });
    }
  };
}

/**
 * `<folder>/<name>.mf4`, or the first free `<name> (1).mf4`, `<name> (2).mf4`… when that exists, the way
 * browsers and Finder name a second copy. A name whose .part file exists counts as taken.
 */
export async function availableRunPath(folder: string, name: string): Promise<string> {
  for (let copy = 0; ; copy++) {
    const candidate = path.join(folder, copy === 0 ? `${name}.mf4` : `${name} (${copy}).mf4`);
    if (!(await exists(candidate)) && !(await exists(candidate + ".part"))) return candidate;
  }
}

/**
 * Runs opened from the archive are fetched here, read once by the hub, then deleted. Each app process
 * has its own folder, so a second instance starting up never clears a run the first is opening.
 */
export function runCacheFolder(tempFolder: string, pid = process.pid): string {
  return path.join(tempFolder, "mur-voir-runs", String(pid));
}

export function isInRunCache(cacheFolder: string, file: string): boolean {
  const relative = path.relative(cacheFolder, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes runs left by earlier sessions (opened but never read, or the app quit mid-download): this
 * process's folder and those of processes no longer running.
 */
export async function clearRunCache(cacheFolder: string, alive = processAlive): Promise<void> {
  const root = path.dirname(cacheFolder);
  const entries = await fs.promises.readdir(root).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((entry) => {
        const full = path.join(root, entry);
        return full === cacheFolder || !/^\d+$/.test(entry) || !alive(Number(entry));
      })
      .map((entry) => fs.promises.rm(path.join(root, entry), { recursive: true, force: true }))
  );
}
