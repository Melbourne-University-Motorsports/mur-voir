// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import TabRenderer from "./TabRenderer";

export default class DocumentationRenderer implements TabRenderer {
  private CONTAINER: HTMLElement;
  private IFRAME: HTMLIFrameElement;

  private stateQueue: string | null = null;
  private loaded = false;
  private scrollPosition = 0;
  private shouldResetScroll = false;
  private firstRender = true;

  private observer: IntersectionObserver | null = null;
  dispose() {
    this.observer?.disconnect();
  }

  constructor(content: HTMLElement) {
    this.CONTAINER = content.getElementsByClassName("documentation-container")[0] as HTMLElement;
    this.IFRAME = this.CONTAINER.firstElementChild as HTMLIFrameElement;

    // Record when the tab is hidden. An observer instead of a per-frame size check, which forced a layout.
    if (typeof IntersectionObserver !== "undefined") {
      this.observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => !entry.isIntersecting)) this.shouldResetScroll = true;
      });
      this.observer.observe(this.CONTAINER);
    }
  }

  saveState(): unknown {
    return this.IFRAME.contentWindow?.location.hash;
  }

  restoreState(state: unknown): void {
    if (typeof state === "string") {
      if (this.loaded) {
        this.IFRAME.contentWindow!.location.hash = state;
      } else {
        this.stateQueue = state;
      }
    }
  }

  getAspectRatio(): number | null {
    return null;
  }

  render(_: unknown): void {
    // Load welcome page once visible
    if (this.firstRender) {
      this.firstRender = false;
      this.IFRAME.src = "welcome.html";
      this.IFRAME.addEventListener("load", () => {
        this.loaded = true;
      });
    }

    // Navigate to initial page when loaded
    if (this.stateQueue !== null && this.loaded) {
      this.IFRAME.contentWindow!.location.hash = this.stateQueue;
      this.stateQueue = null;
    }

    // Update scroll location
    if (this.loaded && this.IFRAME.contentWindow !== null) {
      if (this.shouldResetScroll) {
        this.IFRAME.contentWindow.scrollTo(0, this.scrollPosition);
        this.shouldResetScroll = false;
      } else {
        this.scrollPosition = this.IFRAME.contentWindow.scrollY;
      }
    }
  }
}
