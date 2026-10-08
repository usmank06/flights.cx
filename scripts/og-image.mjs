/**
 * Screenshots the home page, with a sample trip typed in, as the link preview image. Header controls are hidden and the logo
 * and heading are centred, so square crops still show them. Run against a running server when the home page changes, and
 * commit the output.
 *   node scripts/og-image.mjs [baseUrl]      # default http://localhost:3000 → app/opengraph-image.png, app/twitter-image.png
 */
import { copyFile } from "node:fs/promises";
import { chromium } from "playwright";

const BASE = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const OUT = "app/opengraph-image.png";
const TRIP = "Somewhere warm in March, two of us";

// CHROMIUM_PATH overrides the Chromium that Playwright downloads.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
// Reduced motion keeps the aircraft still, so they aren't blurred mid-animation.
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, locale: "en-US", colorScheme: "light", reducedMotion: "reduce" });
await page.goto(BASE, { waitUntil: "networkidle" });
// The map, aircraft and clouds render after first paint, and the clouds fade in.
await page.waitForTimeout(2500);
await page.addStyleTag({
  content: `
    header * { visibility: hidden; }
    header a[aria-label="flights.cx, home"], header a[aria-label="flights.cx, home"] * { visibility: visible; }
    header a[aria-label="flights.cx, home"] { position: fixed; left: 50%; top: 20px; transform: translateX(-50%) scale(1.18); transform-origin: top center; }
    a[aria-label="The source, on GitHub"] { visibility: hidden; }
    main { zoom: 1.16; }
    main h1 { text-align: center; }
  `,
});
await page.evaluate(() => {
  for (const b of document.querySelectorAll("button")) if (b.textContent?.trim() === "How it works") b.style.visibility = "hidden";
});
const box = page.locator("textarea").first();
await box.click();
await box.fill(TRIP);
await page.waitForTimeout(500);
await page.screenshot({ path: OUT });
await copyFile(OUT, "app/twitter-image.png");
await browser.close();
console.log(`wrote ${OUT} and app/twitter-image.png`);
