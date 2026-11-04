// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { rolldown } from "rolldown";
const path = "/tmp/mur-point-clouds/decode.mjs";
fs.mkdirSync("/tmp/mur-point-clouds", { recursive: true });
const bundle = await rolldown({ input: "tools/perf/cloud-decode.ts", platform: "node" });
await bundle.write({ file: path, format: "esm" });
await bundle.close();
const result = spawnSync(process.execPath, [path, ...process.argv.slice(2)], { stdio: "inherit" });
process.exitCode = result.status;
