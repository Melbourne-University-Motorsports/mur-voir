// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { setHidden, setText } from "../shared/domWrite";
import { invalidateFrames } from "./FrameScheduler";

export const MOBILE_BREAKPOINT_PX = 767;

let mediaQuery: MediaQueryList | null = null;
const listeners = new Set<(mobile: boolean) => void>();
let initialized = false;
let activePicker: {
  targetTitle: string;
  onPick: (logKey: string) => boolean;
  addedCount: number;
} | null = null;

function query(): MediaQueryList | null {
  if (mediaQuery === null && typeof window !== "undefined" && typeof window.matchMedia === "function") {
    mediaQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`);
  }
  return mediaQuery;
}

function backdrop(): HTMLElement | null {
  return typeof document !== "undefined" ? document.querySelector<HTMLElement>(".mobile-drawer-backdrop") : null;
}

function syncBackdrop() {
  const el = backdrop();
  if (!el) return;
  const open =
    document.body.classList.contains("mobile-sidebar-open") || document.body.classList.contains("mobile-controls-open");
  setHidden(el, !open);
}

function syncPickerBanner(statusOverride?: string) {
  if (typeof document === "undefined") return;
  const banner = document.querySelector<HTMLElement>(".mobile-picker-banner");
  const active = activePicker !== null;
  document.body.classList.toggle("mobile-picker-active", active);
  if (!banner) return;
  setHidden(banner, !active);
  if (!active || !activePicker) return;
  const targetEl = banner.querySelector<HTMLElement>(".mobile-picker-target");
  const statusEl = banner.querySelector<HTMLElement>(".mobile-picker-status");
  if (targetEl) setText(targetEl, `Add to ${activePicker.targetTitle}`);
  if (statusEl) {
    const status =
      statusOverride ?? (activePicker.addedCount > 0 ? `Added ${activePicker.addedCount}` : "Tap a field to add");
    setText(statusEl, status);
  }
}

/** Whether the mobile sidebar is currently in tap-to-add field picker mode. */
export function isMobileFieldPickerActive(): boolean {
  return activePicker !== null && isMobileLayout();
}

/** Opens the mobile sidebar in tap-to-add picker mode for a target SourceList. */
export function startMobileFieldPicker(targetTitle: string, onPick: (logKey: string) => boolean) {
  if (typeof document === "undefined" || !isMobileLayout()) return;
  activePicker = { targetTitle, onPick, addedCount: 0 };
  syncPickerBanner();
  setMobileSidebarOpen(true);
  const search = document.querySelector<HTMLInputElement>(".side-bar-search");
  search?.focus();
}

/** Handles a tapped field in mobile picker mode. Returns true if the target accepted it. */
export function pickMobileField(logKey: string): boolean {
  if (!activePicker) return false;
  const added = activePicker.onPick(logKey);
  if (added) {
    activePicker.addedCount++;
    syncPickerBanner();
    invalidateFrames();
  } else {
    syncPickerBanner("Incompatible field type");
  }
  return added;
}

/** Exits mobile field picker mode, optionally returning to the tab controls sheet. */
export function finishMobileFieldPicker(reopenControls = true) {
  if (!activePicker) return;
  activePicker = null;
  syncPickerBanner();
  if (reopenControls && isMobileLayout()) {
    setMobileControlsOpen(true);
  }
}

/** Whether the narrow mobile stacked layout is currently active. */
export function isMobileLayout(): boolean {
  return typeof document !== "undefined" && (document.body?.classList?.contains?.("mobile-layout") ?? false);
}

/** Subscribes to mobile breakpoint transitions; returns an unsubscribe callback. */
export function onMobileLayoutChange(listener: (mobile: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the mobile tab-controls bottom sheet is open. */
export function isMobileControlsOpen(): boolean {
  return typeof document !== "undefined" && (document.body?.classList?.contains?.("mobile-controls-open") ?? false);
}

/** Opens or closes the mobile slide-over sidebar drawer. */
export function setMobileSidebarOpen(open: boolean) {
  if (typeof document === "undefined") return;
  if (open) document.body.classList.remove("mobile-controls-open");
  else if (activePicker) {
    activePicker = null;
    syncPickerBanner();
  }
  document.body.classList.toggle("mobile-sidebar-open", open);
  syncBackdrop();
  invalidateFrames();
}

/** Toggles the mobile slide-over sidebar drawer. */
export function toggleMobileSidebar() {
  setMobileSidebarOpen(!document.body.classList.contains("mobile-sidebar-open"));
}

/** Opens or closes the mobile tab-controls bottom sheet. */
export function setMobileControlsOpen(open: boolean, title?: string) {
  if (typeof document === "undefined") return;
  if (open) {
    if (activePicker) {
      activePicker = null;
      syncPickerBanner();
    }
    document.body.classList.remove("mobile-sidebar-open");
    if (title !== undefined) {
      const titleEl = document.querySelector<HTMLElement>(".mobile-controls-title");
      if (titleEl) setText(titleEl, title);
    }
  }
  document.body.classList.toggle("mobile-controls-open", open);
  syncBackdrop();
  invalidateFrames();
}

/** Closes both mobile drawers (sidebar and tab controls sheet). */
export function closeMobileDrawers() {
  if (typeof document === "undefined") return;
  const wasOpen =
    document.body.classList.contains("mobile-sidebar-open") || document.body.classList.contains("mobile-controls-open");
  if (activePicker) {
    activePicker = null;
    syncPickerBanner();
  }
  document.body.classList.remove("mobile-sidebar-open", "mobile-controls-open");
  syncBackdrop();
  if (wasOpen) invalidateFrames();
}

/** Initializes the mobile media-query listener and drawer button handlers. */
export function initMobileLayout() {
  if (initialized || typeof document === "undefined") return;
  initialized = true;

  const q = query();
  const apply = (mobile: boolean) => {
    const changed = document.body.classList.contains("mobile-layout") !== mobile;
    document.body.classList.toggle("mobile-layout", mobile);
    if (!mobile) closeMobileDrawers();
    if (changed) {
      listeners.forEach((listener) => listener(mobile));
      invalidateFrames();
    }
  };
  apply(q?.matches ?? false);
  q?.addEventListener("change", (event) => apply(event.matches));

  document.querySelector(".mobile-menu-toggle")?.addEventListener("click", () => toggleMobileSidebar());
  document.querySelector(".mobile-controls-close")?.addEventListener("click", () => setMobileControlsOpen(false));
  document.querySelector(".mobile-picker-done")?.addEventListener("click", () => finishMobileFieldPicker(true));
  backdrop()?.addEventListener("click", () => closeMobileDrawers());
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isMobileLayout()) {
      if (activePicker) finishMobileFieldPicker(true);
      else closeMobileDrawers();
    }
  });
}
