// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

// Generates the MF4 file icons for the Download runs list, matching the other icons in icons/download:
//   mf4-icon-linuxwin.png  the logo alone (also Lite's icons/mf4-icon.png)
//   mf4-icon-mac.png       the logo and "MF4" on the macOS document page, which is taken from
//                          wpilog-icon-mac.png with its logo and label painted out
// Usage (from the repository root): node icons/generateMF4Icons.mjs
// Renders in headless Chromium (Playwright), so no window opens.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOWNLOAD = path.join(ROOT, "icons", "download");
const pageTemplate = fs.readFileSync(path.join(DOWNLOAD, "wpilog-icon-mac.png")).toString("base64");

async function render(page) {
  return page.evaluate(async (pageTemplate) => {
    const SIZE = 256;
    const NAVY = "#0e2a47";
    const GOLD = "#f2b31c";

    /** The logo: a navy tile with a gold signal trace, in the app icon's colours. */
    const drawLogo = (ctx, x, y, size) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(size / 100, size / 100);
      ctx.beginPath();
      ctx.roundRect(4, 4, 92, 92, 20);
      ctx.fillStyle = NAVY;
      ctx.fill();
      ctx.strokeStyle = "#ffffff33";
      ctx.lineWidth = 1.5;
      for (const gridY of [30, 50, 70]) {
        ctx.beginPath();
        ctx.moveTo(14, gridY);
        ctx.lineTo(86, gridY);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(14, 62);
      ctx.lineTo(26, 62);
      ctx.lineTo(34, 34);
      ctx.lineTo(44, 70);
      ctx.lineTo(54, 26);
      ctx.lineTo(64, 58);
      ctx.lineTo(72, 46);
      ctx.lineTo(86, 46);
      ctx.strokeStyle = GOLD;
      ctx.lineWidth = 7;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.restore();
    };

    // Linux and Windows: the logo alone
    const linuxwin = document.createElement("canvas");
    linuxwin.width = linuxwin.height = SIZE;
    drawLogo(linuxwin.getContext("2d"), 8, 8, SIZE - 16);

    // macOS: the document page with the logo and label
    const image = new Image();
    image.src = "data:image/png;base64," + pageTemplate;
    await image.decode();
    const mac = document.createElement("canvas");
    mac.width = mac.height = SIZE;
    const ctx = mac.getContext("2d");
    ctx.drawImage(image, 0, 0);

    // Paint out the template's logo and label below the folded corner, carrying the page's
    // gradient across each row from the clean columns either side.
    const pixels = ctx.getImageData(0, 0, SIZE, SIZE);
    const LEFT = 40;
    const RIGHT = 218;
    for (let y = 64; y < 244; y++) {
      for (let x = LEFT + 1; x < RIGHT; x++) {
        const t = (x - LEFT) / (RIGHT - LEFT);
        for (let channel = 0; channel < 4; channel++) {
          const left = pixels.data[(y * SIZE + LEFT) * 4 + channel];
          const right = pixels.data[(y * SIZE + RIGHT) * 4 + channel];
          pixels.data[(y * SIZE + x) * 4 + channel] = Math.round(left + (right - left) * t);
        }
      }
    }
    ctx.putImageData(pixels, 0, 0);
    drawLogo(ctx, 72, 72, 112);
    ctx.fillStyle = "#6b6b6b";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.font = "38px Helvetica, Arial, sans-serif";
    ctx.fillText("MF4", 128, 227);

    return [linuxwin, mac].map((canvas) => canvas.toDataURL("image/png").split(",")[1]);
  }, pageTemplate);
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const [linuxwin, mac] = await render(page);
  fs.writeFileSync(path.join(DOWNLOAD, "mf4-icon-linuxwin.png"), Buffer.from(linuxwin, "base64"));
  fs.writeFileSync(path.join(DOWNLOAD, "mf4-icon-mac.png"), Buffer.from(mac, "base64"));
  fs.writeFileSync(path.join(ROOT, "lite", "static", "icons", "mf4-icon.png"), Buffer.from(linuxwin, "base64"));
  console.log("Generated MF4 icons.");
} finally {
  await browser.close();
}
