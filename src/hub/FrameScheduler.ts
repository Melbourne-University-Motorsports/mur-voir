// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Paces the hub's per-frame work. The hub's loops (tabs, sidebar, source lists) call `requestFrame`
 * instead of `window.requestAnimationFrame`, and all of them run together in one frame whose timing
 * depends on what the window is doing:
 *
 * - display rate for a second after any input (pointer, wheel, key, resize) or message from main,
 *   and during historical playback, so dragging, hovering and scrubbing stay smooth;
 * - LIVE_FPS while live data streams, enough for scrolling graphs and readable values;
 * - IDLE_FPS otherwise, so state the loops poll still shows up without drawing at display rate.
 *
 * Between frames nothing asks for an animation frame, so an idle window lets Chromium skip
 * style, layout, paint and compositing entirely.
 */

export type FramePace = "display" | "live" | "idle";

const INTERACTIVE_MS = 1000;
const LIVE_FPS = 30;
const IDLE_FPS = 4;

let queue: FrameRequestCallback[] = [];
let animationFrame: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastFrame = -Infinity;
let interactiveUntil = -Infinity;
let paceSupplier: () => FramePace = () => "idle";
let listening = false;

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

/**
 * Runs the next frame now and keeps display rate for `durationMs` (pass 0 for one prompt frame,
 * e.g. after new log data arrives).
 */
export function wakeFrames(durationMs = INTERACTIVE_MS) {
  interactiveUntil = Math.max(interactiveUntil, performance.now() + durationMs);
  lastFrame = -Infinity;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  arm();
}

function frameInterval(now: number): number {
  if (now < interactiveUntil) return 0;
  switch (paceSupplier()) {
    case "display":
      return 0;
    case "live":
      return 1000 / LIVE_FPS;
    case "idle":
      return 1000 / IDLE_FPS;
  }
}

function arm() {
  if (queue.length === 0 || animationFrame !== null || timer !== null) return;
  const now = performance.now();
  // A few ms of slack so a 30 Hz pace lands on every second 60 Hz frame instead of every third
  const wait = lastFrame + frameInterval(now) - now - 4;
  if (wait <= 0) {
    animationFrame = window.requestAnimationFrame(run);
  } else {
    timer = setTimeout(() => {
      timer = null;
      animationFrame = window.requestAnimationFrame(run);
    }, wait);
  }
}

function run(time: number) {
  animationFrame = null;
  lastFrame = performance.now();
  const callbacks = queue;
  queue = [];
  callbacks.forEach((callback) => callback(time));
  arm();
}

function listen() {
  if (listening || typeof window.addEventListener !== "function") return;
  listening = true;
  const wake = () => wakeFrames();
  for (const type of ["pointermove", "pointerdown", "pointerup", "wheel", "keydown", "keyup", "resize", "focus"]) {
    window.addEventListener(type, wake, { capture: true, passive: true });
  }
  // Drags of fields between lists only send mouse and drag events
  for (const type of ["mousemove", "dragover", "drop"]) {
    window.addEventListener(type, wake, { capture: true, passive: true });
  }
}
