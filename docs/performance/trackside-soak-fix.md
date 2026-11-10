# Trackside soak fix

Base PR commit: `8e8b974344b5254ffa5d1ea2f637aa3e9ee8f719`.
Baseline: `9a6bce4f0623c0acfe945a05880fa863e8adc748`.

The initial headless probe found three global DBC fault subscriptions with a plain empty graph and an empty Trackside tab. The eight-tile layout added exactly its eight tile fields. Trackside does not count as a lap view in the subscription check.

An empty Trackside tab still displays the timeline. Its unconditional lap-band supplier starts lap analysis even without a lap view. The six extra fields are `Laps/SlipRatio`, `Laps/Number`, `Laps/Time`, `Laps/Distance`, `Laps/Sector`, and `Laps/DeltaToReference`. The mock backend has no diff against the baseline. The fault-demo flag was not enabled.

The final fix changes only Trackside's `showTimeline()` result to `false`, matching its embedded Line Graph. The embedded graph retains its own time axis and selection controls. Trackside no longer displays the outer timeline that started lap analysis. `Tabs`, the band supplier, and all lap code are unchanged from PR #5.

The regression test checks that Trackside requests only its tile and DBC fault fields and does not display the outer timeline. It fails before the controller change and passes after it. An earlier supplier guard was committed, then reverted in response to the coordinator's scope update. It is absent from the final diff.

The two new 15-minute soaks completed sequentially. Their complete results and probe outputs are in `trackside-soak-measurements.json`.

## Band probe

| Build and probe              | Input samples | Maximum supplier ms | Fields after probe |
| ---------------------------- | ------------: | ------------------: | -----------------: |
| Unmodified PR #5             |        360000 |               105.6 |                 68 |
| Main, timeline exposed       |        360000 |               146.1 |                 68 |
| Main, normal hidden timeline |        360000 |             0 calls |                 62 |

The original PR probe reported zero long tasks and 60.1 fps after replacing its supplier with an empty function. That was diagnostic instrumentation only. The final fix does not change the supplier.

The final controller band probe made zero supplier calls throughout, kept 62 fields, and created no lap-derived channels. With 360,000 preloaded inputs, its final graph-off interval recorded zero long tasks, and its final FPS sample was 60.1. The graph-on interval recorded five long tasks with a 68 ms maximum and a roughly 5.15 MB graph command. The initial history-insertion task measured 436 ms. The earlier supplier-guard probe is retained in the raw measurements as a superseded experiment.

## Why the sample counts differ

Both versions request the mock's `vsm_state`, `imd_state`, and `car_state` DBC signals without a Trackside tab. PR #5 changes where that subscription is computed, but does not broaden this mock's fault subscription set. The code that classifies DBC faults differs only in its severity type import.

The four common plotted inputs are motor speed, vehicle speed, and the two front wheel speeds. Trackside also requests yaw rate, latitude, longitude, and GPS ground speed for its remaining four tiles. Its visible timeline then invokes lap analysis. The ordinary Line Graph hides that timeline. Trackside's empty layout already creates the six `Laps/*` channels, despite requesting no lap fields through `getActiveFields()`.

In the short PR probe, the empty plain graph had 322 stored samples and no derived channels. The empty Trackside tab had 1,163 samples, including six derived channels. Adding the eight tiles raised the total to 9,298 samples. This sequence retains history between phases, so these totals establish what gets created, not comparable growth rates. The baseline's empty plain graph had 324 samples and the same three active DBC signals. Trackside is unsupported on the baseline, so its later attempted Trackside phases were filtered out and are not comparison data.

The synthetic probe makes the extra work explicit. Eight channels with 45,000 samples each contain 360,000 input samples. The unmodified PR reaches about 541,000 samples after derived outputs. The fixed Trackside probe stays near 360,000 plus subsequent live arrivals. The original soak's roughly threefold difference combines extra raw tile history with these derived outputs. It is not three copies of the graph data.

## Outcome and remaining limits

The final 15-minute Trackside run has 62 fields and 260,488 samples, compared with the supplied before-run's 68 fields and 513,374 samples. Its minute-15 result is 36.6 fps, 128 cumulative long tasks, and a 127 ms longest task. The new baseline has 51.3 fps, 38 long tasks, and a 150 ms longest task. The fixed run stayed near 60 fps through minute eight and degraded late. These results do not establish performance parity or a fully resolved long-session slowdown.

The identified Trackside activation of lap analysis is removed, and the final band probe confirms zero supplier calls. Residual graph-on long tasks and late-soak frame loss remain. The shared-host runs do not isolate their cause. A controlled follow-up is needed before claiming the original responsiveness target is met. No broader lap or timeline changes were made.

Both soak screenshots were opened and inspected. They show the intended four-field Line Graph and eight-tile Trackside layout with four plotted fields. The fixed layout has no outer timeline and no Laps field tree. The DBC subscription test still requires the IMD fault channel.

## Soak tables

The before tables come from the supplied review. Those two runs were concurrent. The new baseline and fixed Trackside runs ran sequentially at speed 1 with seed 1. Other headless work was present on the shared host during parts of these runs. These two soaks did not overlap; the machine was not otherwise idle. Long tasks and longest task are cumulative. DOM counts are elements, not detached nodes. Chromium reported a constant heap value during each evaluation, so these heap readings do not prove stable memory use.

### Before, PR #5 Trackside

| Minute | Heap MB | DOM elements | Long tasks | Longest ms |  FPS | Samples | Fields |
| -----: | ------: | -----------: | ---------: | ---------: | ---: | ------: | -----: |
|      0 |    26.3 |          578 |          0 |          0 |   60 |    4524 |     68 |
|      1 |    26.3 |          578 |          0 |          0 |   60 |   35624 |     68 |
|      2 |    26.3 |          578 |          0 |          0 |   60 |   69064 |     68 |
|      3 |    26.3 |          578 |          0 |          0 |   60 |  102807 |     68 |
|      4 |    26.3 |          578 |          0 |          0 |   60 |  137003 |     68 |
|      5 |    26.3 |          578 |          1 |         52 | 59.9 |  171129 |     68 |
|      6 |    26.3 |          578 |          1 |         52 | 59.7 |  205702 |     68 |
|      7 |    26.3 |          578 |         11 |         55 | 57.3 |  240116 |     68 |
|      8 |    26.3 |          578 |         44 |         64 | 57.3 |  274340 |     68 |
|      9 |    26.3 |          578 |        157 |        108 | 54.1 |  308775 |     68 |
|     10 |    26.3 |          578 |        275 |        147 | 52.5 |  343189 |     68 |
|     11 |    26.3 |          578 |        394 |        200 |   51 |  377080 |     68 |
|     12 |    26.3 |          578 |        512 |        200 | 49.8 |  411115 |     68 |
|     13 |    26.3 |          578 |        631 |        203 | 44.8 |  445059 |     68 |
|     14 |    26.3 |          578 |        755 |        251 | 30.7 |  479188 |     68 |
|     15 |    26.3 |          578 |        880 |        251 | 34.1 |  513374 |     68 |

### Before, main baseline

| Minute | Heap MB | DOM elements | Long tasks | Longest ms |  FPS | Samples | Fields |
| -----: | ------: | -----------: | ---------: | ---------: | ---: | ------: | -----: |
|      0 |    18.4 |          474 |          0 |          0 | 60.1 |    1093 |     62 |
|      1 |    18.4 |          474 |          0 |          0 | 60.1 |   11859 |     62 |
|      2 |    18.4 |          474 |          0 |          0 | 60.1 |   22674 |     62 |
|      3 |    18.4 |          474 |          0 |          0 | 60.1 |   33626 |     62 |
|      4 |    18.4 |          474 |          0 |          0 | 60.1 |   44567 |     62 |
|      5 |    18.4 |          474 |          0 |          0 | 60.1 |   55510 |     62 |
|      6 |    18.4 |          474 |          0 |          0 | 60.1 |   66448 |     62 |
|      7 |    18.4 |          474 |          0 |          0 | 60.1 |   77394 |     62 |
|      8 |    18.4 |          474 |          0 |          0 | 60.1 |   88383 |     62 |
|      9 |    18.4 |          474 |          0 |          0 | 60.1 |   99320 |     62 |
|     10 |    18.4 |          474 |          1 |         58 | 60.2 |  110141 |     62 |
|     11 |    18.4 |          474 |          1 |         58 | 59.6 |  120947 |     62 |
|     12 |    18.4 |          474 |          1 |         58 | 59.4 |  131794 |     62 |
|     13 |    18.4 |          474 |          2 |         65 | 51.8 |  142564 |     62 |
|     14 |    18.4 |          474 |          2 |         65 | 52.7 |  153321 |     62 |
|     15 |    18.4 |          474 |          2 |         65 | 59.8 |  164294 |     62 |

### After, main baseline

| Minute | Heap MB | DOM elements | Long tasks | Longest ms |  FPS | Samples | Fields |
| -----: | ------: | -----------: | ---------: | ---------: | ---: | ------: | -----: |
|      0 |    19.6 |          474 |          0 |          0 |   60 |    1169 |     62 |
|      1 |    19.6 |          474 |          0 |          0 |   60 |   12141 |     62 |
|      2 |    19.6 |          474 |          0 |          0 |   60 |   23216 |     62 |
|      3 |    19.6 |          474 |          0 |          0 |   60 |   34262 |     62 |
|      4 |    19.6 |          474 |          0 |          0 | 60.1 |   45385 |     62 |
|      5 |    19.6 |          474 |          0 |          0 | 60.1 |   56550 |     62 |
|      6 |    19.6 |          474 |          0 |          0 | 60.1 |   67718 |     62 |
|      7 |    19.6 |          474 |          0 |          0 | 60.1 |   78908 |     62 |
|      8 |    19.6 |          474 |          0 |          0 | 60.1 |   90070 |     62 |
|      9 |    19.6 |          474 |          0 |          0 | 60.1 |  101232 |     62 |
|     10 |    19.6 |          474 |          0 |          0 | 60.1 |  112279 |     62 |
|     11 |    19.6 |          474 |          1 |         69 | 50.7 |  123209 |     62 |
|     12 |    19.6 |          474 |         14 |        150 | 47.1 |  133970 |     62 |
|     13 |    19.6 |          474 |         25 |        150 | 40.8 |  144769 |     62 |
|     14 |    19.6 |          474 |         34 |        150 | 47.7 |  155742 |     62 |
|     15 |    19.6 |          474 |         38 |        150 | 51.3 |  166820 |     62 |

### After, fixed Trackside

| Minute | Heap MB | DOM elements | Long tasks | Longest ms |  FPS | Samples | Fields |
| -----: | ------: | -----------: | ---------: | ---------: | ---: | ------: | -----: |
|      0 |      22 |          566 |          0 |          0 |   60 |    1921 |     62 |
|      1 |      22 |          566 |          0 |          0 |   60 |   19363 |     62 |
|      2 |      22 |          566 |          0 |          0 | 60.1 |   36728 |     62 |
|      3 |      22 |          566 |          0 |          0 | 60.1 |   54267 |     62 |
|      4 |      22 |          566 |          0 |          0 | 59.9 |   71602 |     62 |
|      5 |      22 |          566 |          0 |          0 | 59.5 |   88953 |     62 |
|      6 |      22 |          566 |          0 |          0 | 60.1 |  106236 |     62 |
|      7 |      22 |          566 |          0 |          0 | 60.1 |  123628 |     62 |
|      8 |      22 |          566 |          1 |         54 | 59.9 |  140913 |     62 |
|      9 |      22 |          566 |          1 |         54 | 57.6 |  158386 |     62 |
|     10 |      22 |          566 |          4 |         62 | 50.2 |  175556 |     62 |
|     11 |      22 |          566 |          8 |         62 | 59.4 |  192802 |     62 |
|     12 |      22 |          566 |         12 |         68 | 44.8 |  209861 |     62 |
|     13 |      22 |          566 |         18 |         68 | 52.1 |  227209 |     62 |
|     14 |      22 |          566 |         40 |         92 | 26.7 |  244121 |     62 |
|     15 |      22 |          566 |        128 |        127 | 36.6 |  260488 |     62 |

## Commands and checks

All timed command argument arrays, working directories, and limits are recorded in `trackside-soak-commands.json`. The evaluation scripts and raw logs remain at `/tmp/mur-voir-soak-fix/`. The supplied original tools and report remain in the review worktree named in the task.

Setup:

```sh
git fetch https://github.com/Melbourne-University-Motorsports/mur-voir.git feat/trackside-tab && git switch -c feat/trackside-soak-fix FETCH_HEAD
ln -s /Users/jasper/.t3/worktrees/app/feat-core-rollback/node_modules node_modules
cp /Users/jasper/.t3/worktrees/app/feat-core-rollback/src/licenses.json src/licenses.json
```

Each check used `python3 /tmp/mur-voir-soak-fix/run.py <seconds> <command>`:

| Limit, seconds | Command                         | Result                                       |
| -------------: | ------------------------------- | -------------------------------------------- |
|            180 | `npm run compile`               | Pass                                         |
|            120 | `npm test -- lap-subscriptions` | Fail before controller change, pass after it |
|            120 | `npm test`                      | 259 pass, 0 fail                             |
|            120 | `npm run typecheck`             | Pass                                         |
|            120 | `npm run check-format`          | Pass after formatting the test and report    |
|            180 | `npm run lite-smoke`            | Pass                                         |

The probes ran with `python3 /tmp/mur-voir-soak-fix/eval.py <name> <script> <limit>`. This invokes `npm run screenshot -- --no-build --mock --name <name> --eval <script contents>` with `ELECTRON_RUN_AS_NODE` unset. Probe commands and limits are in the argument record. The first main band probe failed on `JSON.stringify(cmd.graph).length`, because a plain graph command has no nested `graph`. The corrected probe serializes `cmd`. The original main band probe kept the timeline hidden, so a second version exposed it to measure the callback.

The full soaks ran with:

```sh
python3 /tmp/mur-voir-soak-fix/sequential.py
```

This runs `python3 /tmp/mur-voir-soak-fix/launch.py baseline` from the existing baseline checkout, waits for exit, then runs `python3 /tmp/mur-voir-soak-fix/launch.py trackside` from this checkout. Each launch has a 1,200-second process-group limit and invokes `npm run screenshot -- --no-build --mock --mock-args=--speed=1 --name <mode>-15min --eval <soak script>`. Each completed evaluation covers minute 0 through minute 15, with a five-second FPS sample at each point.

Every completed step was committed and pushed with:

```sh
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push https://github.com/Melbourne-University-Motorsports/mur-voir.git feat/trackside-soak-fix
```

No dependency install, visible app launch, or `LapService` rewrite ran. No `[headless] suppressed` line appeared in these runs.

## Status

The Trackside lap-activation fix, regression test, checks, sequential soaks, and band probes are complete. Full responsiveness remains unverified as described above. No PR was created or merged. The branch is `feat/trackside-soak-fix`. Commit identifiers are in the handoff and `git log 8e8b9743..HEAD`.

Completed steps before the final report commit:

- `65b70e5e` Record Trackside subscription reproduction
- `7f2363f3` Avoid starting lap analysis for Trackside time graphs. Superseded supplier guard.
- `2ee09f8f` Keep Trackside from starting timeline lap analysis. Reverts the supplier guard and applies the final controller fix.

The final band probe and checks were run through `python3 /tmp/mur-voir-soak-fix/final-checks.py`. That wrapper stopped at the report's format failure. After writing and formatting the report and JSON files, the format check and Lite smoke were rerun with their limits above and passed.
