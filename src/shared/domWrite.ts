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
