// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Paces the hub's per-frame work. The hub's loops (tabs, sidebar, source lists) call `requestFrame`
 * instead of `window.requestAnimationFrame`, and all of them run together in one frame. Frames run
 * only when something can have changed on screen:
 *
 * - at display rate for a second after input (pointer, wheel, key, resize, theme) or a message from
 *   main, and during historical playback, so dragging, hovering and scrubbing stay smooth;
 * - after `invalidateFrames()`, which data sources and other non-input changes call. While live,
 *   these frames are capped at LIVE_FPS, so frames follow the data rate up to that cap;
 * - while live, also at LIVE_CLOCK_FPS, so the live edge keeps moving when no data arrives. A shown
 *   view whose time axis scrolls with the live edge (pace "scroll") draws at LIVE_FPS instead, so a
 *   stall in the incoming data does not make the axis step;
 * - otherwise never. A stable, disconnected window schedules no frames at all.
 *
 * Between frames nothing asks for an animation frame, so Chromium skips style, layout, paint and
 * compositing entirely.
 */

import { LAYOUT_SIZE_EVENT } from "../shared/domWrite";

export type FramePace = "display" | "scroll" | "live" | "idle";

const INTERACTIVE_MS = 1000;
const LIVE_FPS = 20;
const LIVE_CLOCK_FPS = 4;
const TEXT_PERIOD_MS = 100;

let queue: FrameRequestCallback[] = [];
let animationFrame: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let timerDue = Infinity;
let lastFrame = -Infinity;
let interactiveUntil = -Infinity;
let invalidated = true; // The first frame always runs
let paceSupplier: () => FramePace = () => "idle";
let listening = false;
let textTimer: ReturnType<typeof setTimeout> | null = null;
let textFrame = true;
let lastTextFrame = -Infinity;
const afterFrameCallbacks: (() => void)[] = [];

/** Sets how the window paces frames when nobody is interacting with it. */
export function setFramePaceSupplier(supplier: () => FramePace) {
  paceSupplier = supplier;
  arm();
}

/** Runs `callback` in the next paced frame. Like requestAnimationFrame, each call runs once. */
export function requestFrame(callback: FrameRequestCallback) {
  listen();
  queue.push(callback);
  arm();
}

/** Runs `callback` after every paced frame, e.g. to notice state that frames can change. */
export function onAfterFrame(callback: () => void) {
  afterFrameCallbacks.push(callback);
}

/** Asks for a frame because something on screen may have changed (new data, a loaded log). */
export function invalidateFrames() {
  if (invalidated) return;
  invalidated = true;
  arm();
}

/** Runs the next frame now and keeps display rate for `durationMs`, e.g. after input. */
export function wakeFrames(durationMs = INTERACTIVE_MS) {
  interactiveUntil = Math.max(interactiveUntil, performance.now() + durationMs);
  invalidated = true;
  arm();
}

/**
 * Whether live text (values next to fields, previews) should update in this frame. Numbers that change
 * 30 times a second cannot be read, and each text change costs a layout, so without recent input text
 * follows at most every TEXT_PERIOD_MS while graphs keep the full frame rate. Decided once per frame,
 * so every text consumer updates in the same frames.
 */
export function isTextFrame(): boolean {
  return textFrame;
}

/** Whether someone interacted with the window in the last second (or a message from main arrived). */
export function isInteractive(): boolean {
  return performance.now() < interactiveUntil;
}

/** Time until the next frame may run, or Infinity when nothing needs one. */
function frameDelay(now: number): number {
  const pace = paceSupplier();
  if (now < interactiveUntil || pace === "display") return 0;
  if (pace === "scroll") return lastFrame + 1000 / LIVE_FPS - now;
  if (invalidated) return pace === "live" ? lastFrame + 1000 / LIVE_FPS - now : 0;
  if (pace === "live") return lastFrame + 1000 / LIVE_CLOCK_FPS - now;
  return Infinity;
}

function arm() {
  if (queue.length === 0 || animationFrame !== null) return;
  const now = performance.now();
  // A few ms of slack so a 20 Hz pace lands on every third 60 Hz frame instead of every fourth
  const delay = frameDelay(now) - 4;
  if (delay === Infinity) return;
  if (delay <= 0) {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    timerDue = Infinity;
    animationFrame = window.requestAnimationFrame(run);
    return;
  }
  const due = now + delay;
  if (timer !== null && timerDue <= due) return;
  if (timer !== null) clearTimeout(timer);
  timerDue = due;
  timer = setTimeout(() => {
    timer = null;
    timerDue = Infinity;
    arm();
  }, delay);
}

function run(time: number) {
  animationFrame = null;
  lastFrame = performance.now();
  invalidated = false;
  const textWait = lastTextFrame + TEXT_PERIOD_MS - 4 - lastFrame;
  textFrame = textWait <= 0 || isInteractive();
  if (textFrame) {
    lastTextFrame = lastFrame;
  } else if (textTimer === null) {
    // A skipped text update still lands once the period passes, even if nothing else asks for a frame
    textTimer = setTimeout(() => {
      textTimer = null;
      invalidateFrames();
    }, textWait);
  }
  const callbacks = queue;
  queue = [];
  callbacks.forEach((callback) => callback(time));
  afterFrameCallbacks.forEach((callback) => callback());
  arm();
}

function listen() {
  if (listening || typeof window.addEventListener !== "function") return;
  listening = true;
  const wake = () => wakeFrames();
  for (const type of [
    "pointermove",
    "pointerdown",
    "pointerup",
    "wheel",
    "keydown",
    "keyup",
    "resize",
    "focus",
    // Drags of fields between lists only send mouse and drag events
    "mousemove",
    "dragover",
    "drop"
  ]) {
    window.addEventListener(type, wake, { capture: true, passive: true });
  }
  document.addEventListener?.("visibilitychange", wake);
  // A drawn element changed size without input (e.g. a layout change after new data)
  window.addEventListener(LAYOUT_SIZE_EVENT, () => invalidateFrames());
  // Icon and canvas colours follow the theme
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", wake);
}
