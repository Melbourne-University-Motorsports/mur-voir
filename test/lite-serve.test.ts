// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import test from "node:test";

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unexpected server address"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function startLiteServe(backendUrl: string): Promise<{ child: ChildProcess; port: number }> {
  const port = await getFreePort();
  const args = ["tools/lite-serve/main.mjs", "--port", String(port), "--backend", backendUrl];
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    const onData = (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("mur-voir Lite:")) {
        cleanup();
        resolve();
      }
    };
    const onErr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`lite-serve exited early (${code}): ${stderr}`));
    };
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onErr);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onErr);
    child.once("exit", onExit);
  });
  return { child, port };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

test("lite-serve destroys upstream sockets when WebSocket upgrades abort before 101", async () => {
  let openBackendSockets = 0;
  const backend = net.createServer((socket) => {
    openBackendSockets += 1;
    socket.resume();
    socket.on("close", () => {
      openBackendSockets -= 1;
    });
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", () => resolve()));
  const backendAddr = backend.address() as net.AddressInfo;
  const { child, port } = await startLiteServe(`http://127.0.0.1:${backendAddr.port}`);

  try {
    const baselineFds =
      process.platform === "linux" && child.pid ? fs.readdirSync(`/proc/${child.pid}/fd`).length : null;

    for (let i = 0; i < 10; i += 1) {
      await new Promise<void>((resolve, reject) => {
        const client = net.connect(port, "127.0.0.1", () => {
          client.write(
            "GET /api/socket HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
          );
          setTimeout(() => {
            client.destroy();
          }, 30);
        });
        client.once("error", reject);
        client.once("close", () => resolve());
      });
    }

    await waitFor(() => openBackendSockets === 0);
    assert.equal(openBackendSockets, 0);

    if (baselineFds !== null && child.pid) {
      const currentFds = fs.readdirSync(`/proc/${child.pid}/fd`).length;
      assert.ok(currentFds <= baselineFds + 1, `expected fds (${currentFds}) near baseline (${baselineFds})`);
    }
  } finally {
    await stopChild(child);
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});

test("lite-serve proxies WebSocket upgrade and closes peer when client disconnects", async () => {
  let peerClosed = false;
  const backend = http.createServer();
  backend.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("end", () => socket.end());
    socket.on("close", () => {
      peerClosed = true;
    });
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", () => resolve()));
  const backendAddr = backend.address() as net.AddressInfo;
  const { child, port } = await startLiteServe(`http://127.0.0.1:${backendAddr.port}`);

  try {
    await new Promise<void>((resolve, reject) => {
      const client = net.connect(port, "127.0.0.1", () => {
        client.write(
          "GET /api/socket HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
      });
      let buffer = "";
      let echoed = false;
      client.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (!echoed && buffer.includes("\r\n\r\n")) {
          echoed = true;
          client.write("ping");
        } else if (buffer.endsWith("ping")) {
          client.destroy();
          resolve();
        }
      });
      client.once("error", reject);
    });

    await waitFor(() => peerClosed);
    assert.equal(peerClosed, true);
  } finally {
    await stopChild(child);
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});

test("lite-serve aborts upstream HTTP proxy requests and handles mid-stream backend errors", async () => {
  let activeUpstreamRequests = 0;
  let mode: "hang" | "drop-midstream" = "hang";
  const backend = http.createServer((req, res) => {
    activeUpstreamRequests += 1;
    req.on("close", () => {
      activeUpstreamRequests -= 1;
    });
    if (mode === "drop-midstream") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("partial");
      setTimeout(() => req.socket.destroy(), 20);
    }
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", () => resolve()));
  const backendAddr = backend.address() as net.AddressInfo;
  const { child, port } = await startLiteServe(`http://127.0.0.1:${backendAddr.port}`);

  try {
    await new Promise<void>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/api/poll`);
      req.on("error", () => resolve());
      setTimeout(() => req.destroy(), 40);
    });
    await waitFor(() => activeUpstreamRequests === 0);
    assert.equal(activeUpstreamRequests, 0);

    mode = "drop-midstream";
    await new Promise<void>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/api/stream`, (res) => {
        res.on("data", () => {});
        res.on("close", () => resolve());
        res.on("error", () => resolve());
      });
      req.on("error", () => resolve());
    });

    const status = await new Promise<number>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/logs`, { agent: false }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on("error", reject);
    });
    assert.equal(status, 200);
  } finally {
    await stopChild(child);
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});
