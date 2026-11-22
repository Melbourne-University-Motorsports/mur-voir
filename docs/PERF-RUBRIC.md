<!--
Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
https://github.com/Melbourne-University-Motorsports/mur-voir

Use of this source code is governed by a BSD
license that can be found in the LICENSE file
at the root directory of this project.
-->

# Runtime efficiency rubric

Run the standard suite on the bundled Track Day layout. Use the scenario medians and report the ranges. Run before and after on the same machine with the same Electron version, settings, and power mode where possible. The initial reference machine is a 10-core Apple M4. Record the machine and app revision with the score. Use comparisons on other hardware to measure changes against that machine's own baseline.

```sh
npm run perf -- --out .screenshots/perf-before.json
npm run perf -- --out .screenshots/perf-after.json
npm run perf -- --compare .screenshots/perf-before.json .screenshots/perf-after.json
```

The suite uses a temporary Electron profile, fixed window sizes, and a seeded loopback MUR backend. It starts a new app and mock for each group on each repeat. The single-hub live Documentation and per-tab runs share one connection and visit the tabs in saved order. The log grows across those runs. The satellite and two-hub workloads select the first Trackside tab in each hub. A custom `--state` uses the first hub's tabs and sidebar. The benchmark sets the window bounds and controls which windows open. If the layout has no Trackside tab, the benchmark appends the bundled Trackside tab for the satellite and two-hub runs. Use a custom layout for diagnosis and the bundled layout for the score.

## Units and scoring

- **CPU** is `coreCPUPercent`. A process that consumes one CPU-second per wall-second uses 100 percent. Sums can exceed 100 percent. The JSON also preserves Electron's reported `percentCPUUsage` and per-process-type statistics.
- **Task** is CDP `TaskDuration` in milliseconds per wall-second on the renderer main thread. Use it alongside process CPU, which also includes work outside the main thread. The report includes script, style and layout deltas, plus end-of-window heap and node counts.
- **Wakeups** are the sum of Electron's process idle wakeups per second. Electron reports zero on Windows, so treat the Windows value as missing.
- **Callbacks and commits** count Chromium trace events on `CrRendererMain`. Callbacks per frame use the trace's renderer frame count. Use zero for a renderer with zero callbacks and no frames. If callbacks exist and the frame denominator is missing, the callbacks-per-frame criterion is unverified.
- **IPC** counts successful hub-to-main app `MessagePort` sends. Use the `update-satellite` row for satellite commands. Use the hub's total for idle IPC. Changes are differences of medians unless specified otherwise. Clamp negative increases to zero.

For each of the five items, take the highest band whose limits and code criteria all pass. If none pass, give 0.0 for that item. Missing measurements or unverified code criteria fail any band that needs them. Add the five item scores and round to one decimal. Cap the result at 8.9 if any item scores below 1.8. Thus 9.0 requires meeting every 1.8 band.

### 1. Disconnected idle

Measure the full layout with Documentation selected and no connection or interaction. Use total app CPU and wakeups and the hub's task time, callbacks, commits and IPC.

| Points | Max CPU | Max wakeups/s | Max task ms/s | Max callbacks/s | Max commits/s | Max IPC/s |
| -----: | ------: | ------------: | ------------: | --------------: | ------------: | --------: |
|    2.0 |    0.5% |            12 |             2 |             0.5 |           0.5 |       0.5 |
|    1.8 |    1.5% |            30 |             8 |               2 |             1 |         2 |
|    1.2 |      5% |            75 |            35 |              30 |            10 |        10 |
|    0.6 |     30% |           250 |           250 |           2,000 |            70 |        80 |

For 1.8 or higher, verify that a stable tab schedules no recurring render, layout read, or canvas draw. UI state changes and resize events may request a frame. Background processes may still wake for bounded maintenance.

### 2. Single live hub

Use the worst median of each metric across all active Track Day tabs. Apply the same callbacks-per-frame limit to live Documentation with the full layout. Use the hub renderer's CPU for both CPU columns.

| Points | Max active CPU | Max active task ms/s | Max Documentation CPU | Max callbacks/frame |
| -----: | -------------: | -------------------: | --------------------: | ------------------: |
|    2.0 |             7% |                   50 |                    2% |                1.25 |
|    1.8 |            12% |                   90 |                    4% |                   2 |
|    1.2 |            28% |                  220 |                   12% |                   5 |
|    0.6 |            65% |                  600 |                   38% |                  40 |

For 1.8 or higher, verify that ingest batches trigger work for changed fields, time-dependent displays update at their needed cadence, and the app coalesces visible updates. Check for recalculation and redraw on display ticks when telemetry and visible time have stayed the same.

Also run `--scenario tab-1` at both standard speed and `--mock-speed 0.25`, with all other settings identical. Check that the log advances more slowly in the latter run. Subtract the disconnected hub's median CPU from each Track day hub median, with a floor of zero. The slower run must reduce that excess by at least 30% for 1.8 and at least 50% for 2.0. If both live medians are at most 3% of one core, waive the percentage reduction. The speed setting changes simulated ticks per wall-second. Rates for individual signals can differ due to batching and subscriptions.

### 3. Hidden tabs

Subtract the live Documentation-only control from live Documentation with the full layout. Both hubs show the same Documentation and sidebar. Use the hub renderer metrics.

| Points | Max extra CPU points | Max extra task ms/s | Max extra callbacks/frame |
| -----: | -------------------: | ------------------: | ------------------------: |
|    2.0 |                  0.5 |                   3 |                       0.1 |
|    1.8 |                  1.5 |                   8 |                      0.25 |
|    1.2 |                    5 |                  40 |                         3 |
|    0.6 |                   22 |                 200 |                        30 |

For 1.8 or higher, verify that hidden tabs stop their layout reads, per-frame loops, and rendering. They may retain their models. Shared alerts and other explicit background features may process data. Their recurring cost must follow the subscribed data or the background feature's cadence. Adding a hidden tab may do one-time setup and subscription work. It must add no recurring scan of that tab at every display tick or every live batch.

### 4. Trackside satellite

Subtract the single-hub Track day scenario from Track day plus the satellite. Use total app CPU for the increase, the satellite renderer's main-thread task time, and the hub's `update-satellite` rate.

| Points | Max extra CPU points | Max satellite task ms/s | Max satellite updates/s |
| -----: | -------------------: | ----------------------: | ----------------------: |
|    2.0 |                    3 |                      20 |                      12 |
|    1.8 |                    6 |                      45 |                      20 |
|    1.2 |                   18 |                     120 |                      35 |
|    0.6 |                   50 |                     300 |                      65 |

For 1.8 or higher, verify that unchanged commands produce no sends, received duplicates produce no DOM writes, and the hub shares a command between its local view and its satellites. The app may send an initial snapshot. After that, use small updates or bounded, coalesced snapshots, with a rate tied to visible changes.

### 5. Second hub and main-process work

Subtract single-hub Track day total CPU from the two-hub Track day total. Compare the extra CPU to the single-hub total and measure Browser CPU in the two-hub scenario.

| Points | Max extra CPU points | Max extra as share of single-hub CPU | Max two-hub Browser CPU |
| -----: | -------------------: | -----------------------------------: | ----------------------: |
|    2.0 |                    8 |                                 100% |                    1.5% |
|    1.8 |                   14 |                                 110% |                      3% |
|    1.2 |                   32 |                                 125% |                      6% |
|    0.6 |                   75 |                                 150% |                     12% |

For 1.8 or higher, verify that each added hub pays for its own visible work once. Shared asset and other app-wide work must have one owner. Unchanged window state must produce no recurring serialization or writes. Check that asset change detection keeps synchronous traversal off the main process's steady-state path.

## What the benchmark covers

The benchmark records CPU time and idle wakeups as indicators of energy use. It does not measure watts. The windows stay hidden, so the workload omits real screen presentation and GPU raster. A compositor commit is evidence that the renderer submitted work. It does not count a displayed frame. The CPU and CDP sampling window precedes the trace window. Inspect both when trace overhead changes the frame rate.

Loopback telemetry omits the radio transport. A run does not cover long-session history growth, battery drain, or user input. A setup finding, renderer error, dropped trace, or missing process can invalidate a measurement. Review findings and ranges before publishing a score.
