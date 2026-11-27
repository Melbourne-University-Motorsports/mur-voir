// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.
import { SelectionMode } from "../shared/Selection";
import { clientSize, prepareCanvas } from "../shared/domWrite";
import { calcAxisStepSize, clampValue, cleanFloat, scaleValue } from "../shared/util";
import { wakeFrames } from "./FrameScheduler";
import { isMobileLayout } from "./MobileLayout";
import ScrollSensor from "./ScrollSensor";

/** A colored range drawn behind the timeline (e.g. a lap). Times are in log seconds. */
export type TimelineBand = {
  label?: string;
  highlighted?: boolean;
  start: number;
  end?: number; // Undefined extends to the end of the visible range
  color: string;
  darkColor: string;
};

export default class Timeline {
  private STEP_TARGET_PX = 125;

  private CONTAINER: HTMLElement;
  private CANVAS: HTMLCanvasElement;
  private SCROLL_OVERLAY: HTMLElement;

  private scrollSensor: ScrollSensor;
  private mouseDownX = 0;
  private grabZoomActive = false;
  private grabZoomStartTime = 0;
  private lastCursorX: number | null = null;
  private lastCursorInRect = false;
  private scrollTime: number | null = null;
  private zoomInAccumulator = 0;
  private bandSupplier: () => TimelineBand[] = () => [];
  private touchMode: "none" | "scrub" | "pinch" = "none";
  private lastPinchMidX = 0;
  private lastPinchDist = 0;

  constructor(container: HTMLElement) {
    this.CONTAINER = container;
    this.CANVAS = container.getElementsByClassName("timeline-canvas")[0] as HTMLCanvasElement;
    this.SCROLL_OVERLAY = container.getElementsByClassName("timeline-scroll")[0] as HTMLCanvasElement;

    // Hover handling
    window.addEventListener("mousemove", (event) => {
      if (this.CONTAINER.hidden || !this.grabZoomActive) return;
      this.lastCursorX = event.clientX - this.SCROLL_OVERLAY.getBoundingClientRect().x;
    });
    this.SCROLL_OVERLAY.addEventListener("mousemove", (event) => {
      this.lastCursorX = event.clientX - this.SCROLL_OVERLAY.getBoundingClientRect().x;
      this.lastCursorInRect = true;
    });
    this.SCROLL_OVERLAY.addEventListener("mouseleave", () => {
      this.lastCursorX = null;
      this.lastCursorInRect = false;
      window.selection.setHoveredTime(null);
    });

    // Selection handling
    this.SCROLL_OVERLAY.addEventListener("mousedown", (event) => {
      this.mouseDownX = event.clientX - this.SCROLL_OVERLAY.getBoundingClientRect().x;
      let hoveredTime = window.selection.getHoveredTime();
      if (event.shiftKey && hoveredTime !== null) {
        this.grabZoomActive = true;
        this.grabZoomStartTime = hoveredTime;
      }
    });
    window.addEventListener("mousemove", () => {
      if (this.CONTAINER.hidden) return;
      let hoveredTime = window.selection.getHoveredTime();
      if (this.grabZoomActive && hoveredTime !== null) {
        window.selection.setGrabZoomRange([this.grabZoomStartTime, hoveredTime]);
      }
    });
    window.addEventListener("mouseup", () => {
      if (this.CONTAINER.hidden) return;
      if (this.grabZoomActive) {
        window.selection.finishGrabZoom();
        this.grabZoomActive = false;
        if (!this.lastCursorInRect) {
          this.lastCursorX = null;
          window.selection.setHoveredTime(null);
        }
      }
    });
    this.SCROLL_OVERLAY.addEventListener("click", (event) => {
      if (Math.abs(event.clientX - this.SCROLL_OVERLAY.getBoundingClientRect().x - this.mouseDownX) <= 5) {
        let hoveredTime = window.selection.getHoveredTime();
        if (hoveredTime) {
          window.selection.setSelectedTime(hoveredTime);
        }
      }
    });
    this.SCROLL_OVERLAY.addEventListener("contextmenu", () => {
      window.selection.goIdle();
    });

    // Touch scrub (1 finger) and pan/pinch-zoom (2 fingers)
    const scrubToClientX = (clientX: number) => {
      const rect = this.SCROLL_OVERLAY.getBoundingClientRect();
      if (rect.width <= 0) return;
      const x = clampValue(clientX - rect.x, 0, rect.width);
      const timeRange = window.selection.getTimelineRange();
      const time = scaleValue(x, [0, rect.width], timeRange);
      if (window.selection.getMode() === SelectionMode.Locked) {
        window.selection.unlock();
      }
      window.selection.setSelectedTime(time);
    };
    this.SCROLL_OVERLAY.addEventListener(
      "touchstart",
      (event) => {
        if (this.isHidden()) return;
        event.preventDefault();
        wakeFrames();
        if (event.touches.length === 1) {
          this.touchMode = "scrub";
          scrubToClientX(event.touches[0].clientX);
        } else if (event.touches.length >= 2) {
          this.touchMode = "pinch";
          const x0 = event.touches[0].clientX;
          const x1 = event.touches[1].clientX;
          this.lastPinchMidX = (x0 + x1) / 2;
          this.lastPinchDist = Math.abs(x1 - x0);
        }
      },
      { passive: false }
    );
    this.SCROLL_OVERLAY.addEventListener(
      "touchmove",
      (event) => {
        if (this.isHidden()) return;
        event.preventDefault();
        wakeFrames();
        if (event.touches.length === 1 && this.touchMode === "scrub") {
          scrubToClientX(event.touches[0].clientX);
        } else if (event.touches.length >= 2) {
          const x0 = event.touches[0].clientX;
          const x1 = event.touches[1].clientX;
          const midX = (x0 + x1) / 2;
          const dist = Math.abs(x1 - x0);
          if (this.touchMode !== "pinch") {
            this.touchMode = "pinch";
            this.lastPinchMidX = midX;
            this.lastPinchDist = dist;
            return;
          }
          const width = Math.max(1, this.SCROLL_OVERLAY.clientWidth);
          const dx = -(midX - this.lastPinchMidX);
          const dy = -(dist - this.lastPinchDist) * 4;
          window.selection.applyTimelineScroll(dx, dy, width);
          this.lastPinchMidX = midX;
          this.lastPinchDist = dist;
        }
      },
      { passive: false }
    );
    const endTouch = (event: TouchEvent) => {
      if (event.touches.length <= 1) this.touchMode = "none";
    };
    this.SCROLL_OVERLAY.addEventListener("touchend", endTouch);
    this.SCROLL_OVERLAY.addEventListener("touchcancel", endTouch);

    // Scroll handling
    this.scrollSensor = new ScrollSensor(this.SCROLL_OVERLAY, (dx: number, dy: number) => {
      if (this.isHidden()) return;
      window.selection.applyTimelineScroll(dx, dy, this.SCROLL_OVERLAY.clientWidth);

      // Handle help overlay scrolling
      if (window.preferences && !window.preferences.hasScrolledTimeline && this.scrollTime === null) {
        if (dy < 0) {
          this.zoomInAccumulator += dy;
          if (this.zoomInAccumulator <= -200) {
            this.scrollTime = Date.now();
            setTimeout(() => {
              window.sendMainMessage("update-preferences", { hasScrolledTimeline: true });
            }, 1000);
          }
        }
      }
    });
  }

  /**
   * Sets the source of bands drawn behind the timeline. Lap bands will be
   * supplied here by the lap engine; no bands are drawn by default. (The
   * FRC auto/teleop coloring was removed.)
   */
  setBandSupplier(supplier: () => TimelineBand[]) {
    this.bandSupplier = supplier;
  }

  private static darkQuery: MediaQueryList | null = null;
  private tickWidths = new Map<string, number>();
  private helpTextWidth?: number;
  private lastDraw: { key: string; range: [number, number] } | null = null;

  /** Opacity of the "Scroll timeline to zoom" hint, which fades out after the first zoom. */
  private getHelpTextOpacity(): number {
    // Reset scrollTime once preference is set
    let hasScrolledTimeline = (window.preferences?.hasScrolledTimeline ?? false) || this.scrollSensor.shouldHideHint();
    if (hasScrolledTimeline) {
      this.scrollTime = null;
      this.zoomInAccumulator = 0;
      return 0;
    }
    if (this.scrollTime === null) return 0.5;
    let elapsed = Date.now() - this.scrollTime;
    if (elapsed < 600) return 0.5;
    if (elapsed < 1000) return 0.5 * (1 - (elapsed - 600) / 400);
    return 0;
  }

  private isHidden() {
    return this.CONTAINER.hidden || clientSize(this.CONTAINER)[1] === 0;
  }

  periodic() {
    if (this.isHidden()) return;
    this.scrollSensor.periodic();

    const devicePixelRatio = window.devicePixelRatio;
    let [width, height] = clientSize(this.CONTAINER);
    Timeline.darkQuery ??= window.matchMedia("(prefers-color-scheme: dark)");
    let light = !Timeline.darkQuery.matches;
    let timeRange = window.selection.getTimelineRange();
    const bands = this.bandSupplier();
    const mobile = isMobileLayout();
    const helpTextOpacity = mobile ? 0 : this.getHelpTextOpacity();

    const hoveredTime = window.selection.getHoveredTime();
    const selectedTime = window.selection.getSelectedTime();
    const marker = (time: number | null) => {
      if (time === null) return null;
      const x = scaleValue(time, timeRange, [0, width]);
      return x > 1 && x < width - 1 ? Math.round(x * devicePixelRatio) : null;
    };

    // A timeline only needs a new frame when a visible marker or range moves by a device pixel.
    const key = JSON.stringify([
      width,
      height,
      devicePixelRatio,
      light,
      mobile,
      window.log.getTimestampDisplayOffset(),
      bands,
      window.selection.getGrabZoomRange(),
      marker(hoveredTime),
      marker(selectedTime),
      this.lastCursorX,
      helpTextOpacity
    ]);
    const last = this.lastDraw;
    if (last !== null && last.key === key) {
      const pxPerSecond = (width * devicePixelRatio) / (last.range[1] - last.range[0]);
      if (
        Math.abs(timeRange[0] - last.range[0]) * pxPerSecond < 1 &&
        Math.abs(timeRange[1] - last.range[1]) * pxPerSecond < 1
      )
        return;
    }
    this.lastDraw = { key, range: [timeRange[0], timeRange[1]] };

    // Setup and scaling
    let context = this.CANVAS.getContext("2d") as CanvasRenderingContext2D;
    prepareCanvas(this.CANVAS, context, width, height, devicePixelRatio);
    let helpFont = "200 14px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont";
    let labelFont = "200 12px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont";

    // Calculate step size
    let displayOffset = window.log.getTimestampDisplayOffset();
    let displayTimeRange: [number, number] = [timeRange[0] + displayOffset, timeRange[1] + displayOffset];
    let maxTime = Math.max(Math.abs(displayTimeRange[0]), Math.abs(displayTimeRange[1]));
    let intDigits = maxTime > 0 ? Math.log10(maxTime) + 1 : 1;
    let timeSpan = displayTimeRange[1] - displayTimeRange[0];
    let decDigits = timeSpan < 1 && timeSpan > 0 ? -Math.log10(timeSpan) : 0;
    let extraDigits = Math.max(0, intDigits + decDigits - 3);
    const stepTarget = mobile && width < 500 ? 85 : this.STEP_TARGET_PX;
    let stepSize = calcAxisStepSize(displayTimeRange, width, stepTarget + extraDigits * 12);

    // Draw bands (e.g. laps)
    const bandsLabelled = bands.some((b) => b.label);
    const tickLabelY = bandsLabelled ? 9 : height / 2;
    context.lineWidth = 1;
    let rangeBorders: number[] = [];
    bands.forEach((range) => {
      let startTime = range.start;
      let endTime = range.end === undefined ? timeRange[1] : range.end;
      context.fillStyle = light ? range.color : range.darkColor;
      let startX = clampValue(scaleValue(startTime, timeRange, [0, width]), 0, width);
      let endX = clampValue(scaleValue(endTime, timeRange, [0, width]), 0, width);
      context.globalAlpha = range.highlighted ? 0.22 : 0.09;
      context.fillRect(startX, 0, endX - startX, height);
      context.globalAlpha = 1;
      if (range.label && endX - startX > 30) {
        // Second row of the band (tick labels move to the first row when labels exist), 11px
        context.font = "600 11px ui-sans-serif, system-ui";
        context.textAlign = "left";
        context.textBaseline = "middle";
        context.fillStyle = light ? "#333" : "#ddd";
        context.fillText(range.label, startX + 3, height - 9, endX - startX - 6);
        context.textBaseline = "alphabetic";
      }

      if (!rangeBorders.includes(range.start)) {
        rangeBorders.push(range.start);
      }
      if (range.end !== undefined && !rangeBorders.includes(range.end)) {
        rangeBorders.push(range.end);
      }
    });

    // Draw grab zoom range
    let grabZoomRange = window.selection.getGrabZoomRange();
    if (grabZoomRange !== null) {
      let startX = scaleValue(grabZoomRange[0], timeRange, [0, width]);
      let endX = scaleValue(grabZoomRange[1], timeRange, [0, width]);

      context.globalAlpha = 0.6;
      context.fillStyle = "yellow";
      context.fillRect(startX, 0, endX - startX, height);
      context.globalAlpha = 1;
    }

    // Update hovered time
    if (this.lastCursorX !== null && this.lastCursorX > 0 && this.lastCursorX < width) {
      let cursorTime = scaleValue(this.lastCursorX, [0, width], timeRange);
      let nearestRangeBorder = rangeBorders.reduce((prev, border) => {
        if (Math.abs(cursorTime - border) < Math.abs(cursorTime - prev)) {
          return border;
        } else {
          return prev;
        }
      }, Infinity);
      let nearestRangeBorderX = scaleValue(nearestRangeBorder, timeRange, [0, width]);
      window.selection.setHoveredTime(
        Math.abs(this.lastCursorX - nearestRangeBorderX) < 5 ? nearestRangeBorder : cursorTime
      );
    }

    // Draw a vertical marker line at the time
    let markedXs: number[] = [];
    let markTime = (time: number, alpha: number) => {
      if (time >= timeRange[0] && time <= timeRange[1]) {
        context.globalAlpha = alpha;
        context.lineWidth = 1;
        context.strokeStyle = light ? "#222" : "#eee";

        let x = scaleValue(time, timeRange, [0, width]);
        if (x > 1 && x < width - 1) {
          let triangleSideLength = 6;
          let triangleHeight = 0.5 * Math.sqrt(3) * triangleSideLength;

          markedXs.push(x);
          context.beginPath();
          context.moveTo(x, triangleHeight);
          for (let i = x - triangleSideLength / 2; i <= x + triangleSideLength / 2; i++) {
            context.lineTo(i, -1);
            context.moveTo(x, triangleHeight);
          }
          context.lineTo(x, height - triangleHeight);
          for (let i = x - triangleSideLength / 2; i <= x + triangleSideLength / 2; i++) {
            context.lineTo(i, height + 1);
            context.moveTo(x, height - triangleHeight);
          }
          context.stroke();
        }
        context.globalAlpha = 1;
      }
    };

    // Mark hovered and selected times
    const markerHover = window.selection.getHoveredTime();
    if (markerHover !== null) markTime(markerHover, 0.5);
    if (selectedTime !== null) markTime(selectedTime, 1);

    // Draw tick marks
    let helpText = "Scroll timeline to zoom";
    context.font = helpFont;
    const helpTextWidth = (this.helpTextWidth ??= context.measureText(helpText).width);

    context.lineWidth = 0.5;
    context.strokeStyle = light ? "#222" : "#eee";
    context.fillStyle = light ? "#222" : "#eee";
    context.textAlign = "center";
    context.textBaseline = "middle";
    let stepPos = Math.ceil(cleanFloat(displayTimeRange[0] / stepSize)) * stepSize;
    const ticksByAlpha = new Map<number, number[]>();
    let iterCount = 0;
    while (iterCount++ < 100) {
      let x = scaleValue(stepPos, displayTimeRange, [0, width]);
      if (x > width + 1) {
        break;
      }

      let text = cleanFloat(stepPos).toString() + "s";
      context.font = labelFont;
      let textWidth = this.tickWidths.get(text);
      if (textWidth === undefined) {
        if (this.tickWidths.size >= 256) this.tickWidths.clear();
        textWidth = context.measureText(text).width;
        this.tickWidths.set(text, textWidth);
      }
      let textX = clampValue(x, textWidth / 2 + 3, width - textWidth / 2 - 3);
      let textXRange = [textX - textWidth / 2, textX + textWidth / 2];

      let markDistance = markedXs.reduce((min, x) => {
        let dist = 0;
        if (x < textXRange[0]) dist = textXRange[0] - x;
        if (x > textXRange[1]) dist = x - textXRange[1];
        return dist < min ? dist : min;
      }, Infinity);

      let helpLeft = width / 2 - helpTextWidth / 2;
      let helpRight = width / 2 + helpTextWidth / 2;
      let helpDistance = Infinity;
      if (helpRight < textXRange[0]) helpDistance = textXRange[0] - helpRight;
      else if (helpLeft > textXRange[1]) helpDistance = helpLeft - textXRange[1];
      else helpDistance = 0;

      // Adjust min distance based on help text opacity.
      let adjustedHelpDistance = helpDistance;
      if (helpTextOpacity === 0) {
        adjustedHelpDistance = Infinity;
      } else {
        let opacityRatio = helpTextOpacity / 0.5;
        adjustedHelpDistance = helpDistance / opacityRatio;
      }

      let minDistance = Math.min(markDistance, adjustedHelpDistance);
      const alpha = clampValue(scaleValue(minDistance, [0, 20], [0.2, 0.5]), 0, 1);
      context.globalAlpha = alpha;
      context.fillText(text, textX, tickLabelY);
      const ticks = ticksByAlpha.get(alpha);
      if (ticks) ticks.push(x);
      else ticksByAlpha.set(alpha, [x]);

      stepPos += stepSize;
    }
    for (const [alpha, ticks] of ticksByAlpha) {
      context.globalAlpha = alpha;
      context.beginPath();
      for (const x of ticks) {
        context.moveTo(x, 0);
        context.lineTo(x, 8);
        if (!bandsLabelled) {
          context.moveTo(x, height - 8);
          context.lineTo(x, height);
        }
      }
      context.stroke();
    }

    // Draw help text in center
    if (helpTextOpacity > 0) {
      context.font = helpFont;
      context.fillStyle = light ? "#222" : "#eee";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.globalAlpha = helpTextOpacity;
      context.fillText(helpText, width / 2, height / 2);
    }
    context.globalAlpha = 1;
  }
}
