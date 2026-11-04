# Point cloud measurements

Prerequisites: Node with TypeScript stripping support (tested Node 26), `npm install`, `npm run compile`. Electron comes from the installed `electron` package on each platform. Lite also needs `npm run lite-build` and `npx playwright install chromium`. Run from the repository root. Keep unrelated machine load constant and record it with results.

```
mkdir -p /tmp/mur-point-clouds/r2
node tools/mcap/generate-cloud.mjs 300000 30 /tmp/mur-point-clouds/r2/reference.mcap
node tools/perf/cloud-electron.mjs file 10 10 --input /tmp/mur-point-clouds/r2/reference.mcap --output /tmp/mur-point-clouds/r2/shots
node tools/perf/cloud-electron.mjs live 180 1 --port 18093 --output /tmp/mur-point-clouds/r2/shots
node tools/perf/cloud-electron.mjs live 180 10 --port 18093 --output /tmp/mur-point-clouds/r2/shots
node tools/perf/cloud-lite.mjs --port 18095 --lite-port 15809 --output /tmp/mur-point-clouds/r2/shots
```

`--prefix` defaults to `r2`. Electron `ros` mode uses `--port` plus one. Backend ports are checked before spawning; child exit and readiness are checked before connecting. Child stderr is preserved. Screenshots require an explicit output path to retain outside temporary storage. Remove generated MCAPs and profiles after use. All children started by the harness are closed in `finally`.

`readiness.ready / readiness.frames` counts animation frames containing a nonempty cloud manager after warmup, including disclosed held scans. `frameMedianMs` and `frameP95Ms` are rAF intervals, not GPU render timings. Decode times come from the worker. Upload counters measure CPU buffer preparation/submission, not GPU execution. Attribute bytes and renderer.info are mirrored buffer/resource counts, not total VRAM. Heap is Chromium's reported JS heap. Samples are cumulative readiness and interval frame statistics. The removed ambiguous skipped-window counter is no longer a drop metric; these tools do not measure transport loss. A successful run alone does not establish every acceptance check.

The Electron harness closes development DevTools before streaming. Both harnesses disable Playwright's Network domain on its own CDP session so 4.8 MB scan payloads are not mirrored through the measurement driver. This needs a guarded internal Playwright session hook; use `npm ci` with the repository lockfile. An incompatible Playwright version fails explicitly rather than silently measuring payload mirroring overhead. Source sockets and worker transfers remain active. Readiness is capped to the requested renderer-side duration even if CDP sampling is delayed.
