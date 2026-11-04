# Point cloud measurements

Prerequisites: Node with TypeScript stripping support (tested Node 26), `npm install`, `npm run compile`. Electron comes from the installed `electron` package on each platform. Lite also needs `npm run lite-build` and `npx playwright install chromium`. Run from the repository root. Keep unrelated machine load constant and record it with results.

```
mkdir -p /tmp/mur-point-clouds/reference
node tools/mcap/generate-cloud.mjs 300000 30 /tmp/mur-point-clouds/reference/reference.mcap
node tools/perf/cloud-electron.mjs file 10 10 --input /tmp/mur-point-clouds/reference/reference.mcap --output /tmp/mur-point-clouds/reference/shots
node tools/perf/cloud-electron.mjs live 180 1 --port 18093 --output /tmp/mur-point-clouds/reference/shots
node tools/perf/cloud-electron.mjs live 180 10 --port 18093 --output /tmp/mur-point-clouds/reference/shots
node tools/perf/cloud-lite.mjs --port 18095 --lite-port 15809 --output /tmp/mur-point-clouds/reference/shots
```

`--prefix` defaults to `cloud`. Electron `ros` mode uses `--port` plus one. Backend ports are checked before spawning; child exit and readiness are checked before connecting. Child stderr is preserved. Screenshots require an explicit output path to retain outside temporary storage. Remove generated MCAPs and profiles after use. All children started by the harness are closed in `finally`.

`presentationAge` counts current, held and empty animation frames and maximum age relative to the newest eligible raw scan. `frameMedianMs` and `frameP95Ms` are rAF intervals, not GPU render timings. Decode times include worker parsing and decoding, excluding message copy, queue and transit. Upload counters measure CPU buffer preparation/submission, not GPU execution. Attribute bytes and renderer.info are mirrored buffer/resource counts, not total VRAM. Heap is Chromium's reported JS heap. Samples are cumulative readiness and interval frame statistics. The removed ambiguous skipped-window counter is no longer a drop metric; these tools do not measure transport loss. A successful run alone does not establish every acceptance check.

The Electron harness closes development DevTools before streaming. Both harnesses disable Playwright's Network domain on its own CDP session so 4.8 MB scan payloads are not mirrored through the measurement driver. This needs a guarded internal Playwright session hook; use `npm ci` with the repository lockfile. An incompatible Playwright version warns and continues; results then include payload mirroring overhead. Source sockets and worker transfers remain active. Readiness is capped to the requested renderer-side duration even if CDP sampling is delayed.

Use `node tools/perf/cloud-electron.mjs ros 180 10 --dynamic-tf` for uninterrupted dynamic TF at 300000 points and 10 Hz. Samples report receipt/acquisition tree sample counts and host load averages. File fixtures support `node tools/mcap/generate-cloud.mjs 300000 1800 /tmp/mur-point-clouds/reference.mcap --dynamic-tf`. Check disk first: long files are large.
