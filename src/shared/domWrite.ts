// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// DOM writes that skip unchanged values. Chromium invalidates style (and often layout and paint)
// on every attribute, text or custom property write, even when the value is the same, so code that
// runs every frame uses these instead of plain assignments.

/** Sets `hidden` only when it changes. */
export function setHidden(element: HTMLElement, hidden: boolean) {
  if (element.hidden !== hidden) element.hidden = hidden;
}

/** Sets `textContent` only when it changes. */
export function setText(element: Element, text: string) {
  if (element.textContent !== text) element.textContent = text;
}

/** Sets `innerText` only when it changes, without reading `innerText` back (which forces layout). */
const innerTexts = new WeakMap<HTMLElement, string>();
export function setInnerText(element: HTMLElement, text: string) {
  if (innerTexts.get(element) === text) return;
  innerTexts.set(element, text);
  element.innerText = text;
}

/** Sets a CSS custom property on the root element only when it changes. */
const rootProperties = new Map<string, string>();
export function setRootProperty(name: string, value: string) {
  if (rootProperties.get(name) === value) return;
  rootProperties.set(name, value);
  document.documentElement.style.setProperty(name, value);
}

/** Sets an inline style property only when it changes. */
export function setStyle(element: HTMLElement, property: "width" | "height" | "display", value: string) {
  if (element.style[property] !== value) element.style[property] = value;
}

/**
 * Readies a canvas for a full redraw at `cssWidth` x `cssHeight` CSS pixels: cleared, with default
 * context state and scaled for the device pixel ratio. Assigning `canvas.width` reallocates the
 * backing store even when the size is unchanged, so it only happens when the size changes;
 * otherwise `context.reset()` clears the bitmap and state in place.
 */
export function prepareCanvas(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number
) {
  const width = Math.floor(cssWidth * devicePixelRatio);
  const height = Math.floor(cssHeight * devicePixelRatio);
  if (canvas.width !== width || canvas.height !== height || typeof context.reset !== "function") {
    canvas.width = width;
    canvas.height = height;
  } else {
    context.reset();
  }
  context.scale(devicePixelRatio, devicePixelRatio);
}

// Layout reads for per-frame drawing. Reading clientWidth after any DOM write in the same frame forces
// a synchronous layout, so sizes come from a ResizeObserver, which reports right after layout.

/** Fired on window when an observed element's size changes, so the hub can draw a frame. */
export const LAYOUT_SIZE_EVENT = "layout-size-change";

const clientSizes = new WeakMap<Element, [number, number]>();
let sizeObserver: ResizeObserver | null | undefined;

/**
 * Returns `[clientWidth, clientHeight]`, kept up to date by a ResizeObserver. An element that was
 * hidden (0 × 0) is measured directly, so a tab that has just been shown draws at its real size.
 */
export function clientSize(element: HTMLElement): [number, number] {
  const known = clientSizes.get(element);
  if (known !== undefined && (known[0] > 0 || known[1] > 0)) return known;
  const size: [number, number] = [element.clientWidth, element.clientHeight];
  if (sizeObserver === undefined) {
    sizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver((entries) => {
            let changed = false;
            for (const entry of entries) {
              const target = entry.target as HTMLElement;
              const old = clientSizes.get(target);
              const width = target.clientWidth;
              const height = target.clientHeight;
              if (old === undefined || old[0] !== width || old[1] !== height) {
                clientSizes.set(target, [width, height]);
                changed = true;
              }
            }
            if (changed) window.dispatchEvent(new Event(LAYOUT_SIZE_EVENT));
          })
        : null;
  }
  if (sizeObserver !== null) {
    if (known === undefined) sizeObserver.observe(element);
    clientSizes.set(element, size);
  }
  return size;
}

let darkQuery: MediaQueryList | undefined;

/** Whether the dark theme is active, without creating a media query on every call. */
export function isDarkMode(): boolean {
  darkQuery ??= window.matchMedia("(prefers-color-scheme: dark)");
  return darkQuery.matches;
}
