// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import net from "node:net";
import { parseArgs } from "node:util";
export function options() {
  return parseArgs({
    allowPositionals: true,
    options: {
      input: { type: "string" },
      output: { type: "string", default: "/tmp/mur-point-clouds/screenshots" },
      port: { type: "string", default: "18093" },
      "lite-port": { type: "string", default: "15809" },
      prefix: { type: "string", default: "cloud" }
    }
  });
}
export async function freePort(port) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw Error("Invalid port: " + port);
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(Number(port), resolve));
  await new Promise((r) => server.close(r));
}
export async function ready(child, port) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null || child.signalCode)
      throw Error("Child exited before readiness: " + child.spawnargs.join(" "));
    const connected = await new Promise((resolve) => {
      const s = net.connect(Number(port), "127.0.0.1");
      s.on("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (connected) {
      await new Promise((r) => setTimeout(r, 100));
      if (child.exitCode !== null) throw Error("Child exited during readiness");
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Child readiness timed out on port " + port);
}

// Test instrumentation only: avoid copying every lidar payload through CDP.
// Playwright exposes no public option for disabling Network on its own session.
export async function disablePayloadMirroring(page) {
  try {
    const session = page._connection.toImpl?.(page)?.delegate?._mainFrameSession?._client;
    if (!session) throw Error("Playwright CDP session unavailable");
    await session.send("Network.disable");
  } catch (error) {
    console.warn("WARNING payload mirroring remains enabled:", String(error));
  }
}
