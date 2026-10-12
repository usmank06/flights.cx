"use client";

import { useEffect, useRef } from "react";
import { BAND_TOP, BANKS, bakeBank, bakeDeck, createStir, createWake, DECKS, gust, MAX_SPLATS, type BakedBank } from "./clouds";
import { bearing, decodeLand, step, type Topology } from "./geo";
import { SKY } from "./sky";
import { createSkyGL, type BankState } from "./sky-gl";
import { altitude, createTraffic, FADE, lengthPx, loadPorts, loadSprites, type Flight, type Port, type Sprite } from "./traffic";

/**
 * The home page backdrop: the world map, a few aircraft with their airports lit, and pointer-stirred clouds at the top and bottom.
 * Land is a 2D canvas drawn once per layout; airport lights are another, redrawn only while one changes. Clouds (WebGL) and
 * traffic (2D) draw every frame. Decorative: aria-hidden, no pointer events, paused in hidden tabs. Device pixel ratio capped at 2.
 */

// Accent blues as RGB channels, since canvas can't read CSS variables. Keep in sync with globals.css.
const ACCENT = "26, 90, 224";
const ACCENT_BRIGHT = "61, 123, 255";

const LAND_URL = "/land-110m.json";
const PORTS_URL = "/airports-map.json";
const LON_MIN = -170;
const LON_MAX = 190;
const LAT_MAX = 76;
const LAT_MIN = -56;

/** Aircraft per square px of map, clamped to MIN_CRAFT..MAX_CRAFT. */
const DENSITY = 1 / 62000;
const MIN_CRAFT = 8;
const MAX_CRAFT = 10;
/** Seconds for an airport light to come on (with a bloom); going out takes twice as long. */
const LIGHT = 0.55;
/** Pointer smoothing time constant, s: the stir follows a point that lags the pointer by about this much. */
const FOLLOW = 0.075;
/** Distance from the question's box, px, at which aircraft are back to full opacity. */
const CLEAR = 160;
/**
 * Frame-rate probe: after a short settle, the first second is timed. Below STILL_FPS the scene freezes; below SOFT_FPS
 * the sky renders at lower resolution.
 */
const PROBE_SETTLE_S = 0.3;
const PROBE_S = 1;
const STILL_FPS = 24;
const SOFT_FPS = 45;
/** The top clouds' foot position, and the height of the deck band below it, as shares of the scene height. */
const TOP_FOOT = 0.01;
const TOP_BAND = 0.36;

function wrapLon(lon: number): number {
  let v = lon;
  while (v < LON_MIN) v += 360;
  while (v > LON_MAX) v -= 360;
  return v;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeOut = (t: number) => 1 - (1 - t) ** 3;

export function Scene() {
  const wrap = useRef<HTMLDivElement>(null);
  const landRef = useRef<HTMLCanvasElement>(null);
  const portRef = useRef<HTMLCanvasElement>(null);
  const skyRef = useRef<HTMLCanvasElement>(null);
  const stillRef = useRef<HTMLCanvasElement>(null);
  const airRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const landCanvas = landRef.current;
    const portCanvas = portRef.current;
    const skyCanvas = skyRef.current;
    const stillCanvas = stillRef.current;
    const canvas = airRef.current;
    const box = wrap.current;
    if (!landCanvas || !portCanvas || !skyCanvas || !stillCanvas || !canvas || !box) return;
    const lc = landCanvas.getContext("2d");
    const pc = portCanvas.getContext("2d");
    const ctx = canvas.getContext("2d");
    if (!lc || !pc || !ctx) return;
    // Three sets of cloud: the banks over the top edge, the deck hanging under them, the banks along the foot.
    const sky = createSkyGL(skyCanvas, [BANKS, DECKS, BANKS]);
    // Without WebGL, the clouds are drawn once on a 2D context. That needs its own canvas, because a canvas that already
    // returned a WebGL context can't return a 2D one.
    const still = sky ? null : stillCanvas.getContext("2d");
    const stir = createStir(sky?.splats ?? 0);
    const wake = createWake(stir);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    /** Static mode: reduced motion, or the device failed the frame-rate probe. */
    let stillness = reduced;
    let disposed = false;
    let w = 0;
    let h = 0;
    let dpr = 1;
    /** Sky resolution scale; lowered once if the probe finds slow frames. */
    let quality = 1;
    let mapX = 0;
    let mapY = 0;
    let mapW = 0;
    let mapH = 0;
    let planeScale = 1;
    /** The question's box (the element marked `data-quiet`), in scene px. */
    let quiet = { l: 0, r: 0, t: 0, b: 0 };

    let rings: [number, number][][] = [];

    /** Lit airports: light level 0..1, and whether a flight still uses the airport. */
    const lit = new Map<Port, { k: number; on: boolean }>();

    let clock = 0;
    let sprites = new Map<string, Sprite>();
    /** Clock time when the sprites loaded, or -1. Aircraft are hidden until then so they fade in as silhouettes. */
    let spritesAt = -1;
    const traffic = createTraffic();
    let cx = new Float32Array(0);
    let cy = new Float32Array(0);

    // ── The clouds ────────────────────────────────────────────────────────

    const sets: BakedBank[][] = [[], [], []];
    const shifts = [BANKS.map(() => 0), DECKS.map(() => 0), BANKS.map(() => 0)];
    const states: BankState[][] = [BANKS.map(() => ({ shift: 0, y: 0 })), DECKS.map(() => ({ shift: 0, y: 0 })), BANKS.map(() => ({ shift: 0, y: 0 }))];
    const splatA = new Float32Array(MAX_SPLATS * 4);
    const splatB = new Float32Array(MAX_SPLATS * 4);
    let bakedFor = { w: 0, h: 0 };
    /** How far the foot's banks sit below their band, so they peek up from the bottom edge. */
    const sink = () => Math.min(110, h * 0.12);
    const scale = () => Math.max(0.6, Math.min(1, w / 1300));
    /** Puff scale for short screens (landscape phones), keeping the bands shallow and the middle open. */
    const shrink = () => Math.max(0.6, Math.min(1, h / 720));
    /** Bottom of the top deck and top of the foot clouds; the pointer stirs only above the first or below the second. */
    const deckReach = () => h * TOP_FOOT + h * TOP_BAND * DECKS[DECKS.length - 1].reach;
    const footTop = () => h * BAND_TOP - 60 + sink();

    function bakeClouds() {
      if (w === bakedFor.w && Math.abs(h - bakedFor.h) <= 80) return;
      // Top banks end just past their foot with a fade, so the deck hangs from white instead of a hard edge.
      sets[0] = BANKS.map((b) => bakeBank(b, w, h, h - sink() + 24, shrink()));
      sets[1] = DECKS.map((d) => bakeDeck(d, w, h * TOP_BAND, shrink()));
      sets[2] = BANKS.map((b) => bakeBank(b, w, h, h + 40, shrink()));
      // Offset the top banks so they don't mirror the foot's. First bake only; re-bakes keep the wind's position.
      if (!bakedFor.w) sets[0].forEach((b, i) => (shifts[0][i] = (b.tileW * (0.31 + i * 0.23)) % b.tileW));
      sets.forEach((set, s) => set.forEach((b, i) => (shifts[s][i] %= b.tileW)));
      bakedFor = { w, h };
      sets.forEach((set, s) => sky?.setBanks(set, s));
      stir.clear();
    }

    /** Where each layer is this frame: carried by the wind, bobbing a little. */
    function placeClouds() {
      const bob = (i: number, k: number) => (reduced ? 0 : Math.sin(clock * (0.19 + i * 0.05) + i * 1.7 + k) * (2 + i));
      const foot = h * TOP_FOOT;
      BANKS.forEach((_, i) => {
        states[0][i].shift = shifts[0][i];
        states[0][i].y = foot - h + sink() + bob(i, 0);
        states[2][i].shift = shifts[2][i];
        states[2][i].y = sink() + bob(i, 1.1);
      });
      DECKS.forEach((_, i) => {
        states[1][i].shift = shifts[1][i];
        states[1][i].y = foot + bob(i, 2.4);
      });
    }

    function windClouds(dt: number) {
      const windScale = Math.max(0.6, Math.min(1.2, w / 1440));
      const gw = gust(clock);
      [BANKS, DECKS, BANKS].forEach((layers, s) =>
        layers.forEach((l, i) => {
          const tile = sets[s][i]?.tileW ?? 1;
          shifts[s][i] = (shifts[s][i] + l.wind * windScale * gw * dt) % tile;
        })
      );
      // The wake drifts with the nearest clouds while it heals.
      stir.step(dt, BANKS[BANKS.length - 1].wind * windScale * gw * 0.9);
    }

    /** Static 2D fallback when WebGL is unavailable. */
    function drawStill() {
      if (!still) return;
      stillCanvas!.width = Math.round(w * dpr);
      stillCanvas!.height = Math.round(h * dpr);
      still.setTransform(dpr, 0, 0, dpr, 0, 0);
      still.clearRect(0, 0, w, h);
      sets.forEach((set, s) =>
        set.forEach((b, i) => {
          for (let x = -((b.tileW * 0.37 + shifts[s][i]) % b.tileW); x < w; x += b.tileW) still.drawImage(b.canvas, x, b.top + states[s][i].y, b.tileW, b.height);
        })
      );
    }

    const at = (lon: number, lat: number): [number, number] => [mapX + ((wrapLon(lon) - LON_MIN) / (LON_MAX - LON_MIN)) * mapW, mapY + ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * mapH];
    /** How far a point is outside the question's box, px: 0 inside it. */
    const outside = (x: number, y: number) => Math.hypot(Math.max(quiet.l - x, 0, x - quiet.r), Math.max(quiet.t - y, 0, y - quiet.b));
    /** Aircraft opacity near the question: 0 behind it, smoothstep to 1 at CLEAR px away. */
    const behind = (x: number, y: number) => {
      const t = clamp01(outside(x, y) / CLEAR);
      return t * t * (3 - 2 * t);
    };
    /** Map visibility at a point after settle()'s edge fade and its `dip` under the question. */
    const seen = (x: number, y: number, dip: number) => {
      const edge = clamp01(Math.min(x, w - x) / (w * 0.1)) * clamp01(y / (h * 0.18));
      const d = Math.hypot((x - (quiet.l + quiet.r) / 2) / ((quiet.r - quiet.l) / 2 + 80), (y - (quiet.t + quiet.b) / 2) / ((quiet.b - quiet.t) / 2 + 60));
      const under = d >= 1 ? 0 : d <= 0.65 ? dip * (1 - (0.07 * d) / 0.65) : dip * 0.93 * ((1 - d) / 0.35);
      return edge * (1 - under);
    };

    // ── The world ─────────────────────────────────────────────────────────

    function traceLand(c: CanvasRenderingContext2D) {
      c.beginPath();
      for (const r of rings) {
        let mean = 0;
        let top = -90;
        for (const p of r) {
          mean += p[0];
          if (p[1] > top) top = p[1];
        }
        mean /= r.length;
        // Skip rings wholly below the crop (Antarctica), which would draw a band along the bottom.
        if (top < LAT_MIN) continue;
        const shift = mean < LON_MIN ? 360 : 0;
        for (let i = 0; i < r.length; i++) {
          const x = mapX + ((r[i][0] + shift - LON_MIN) / (LON_MAX - LON_MIN)) * mapW;
          const y = mapY + ((LAT_MAX - r[i][1]) / (LAT_MAX - LAT_MIN)) * mapH;
          if (i === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.closePath();
      }
    }

    /** Dissolve `c`'s edges into the page, and dip its middle under the question by `dip` (0..1). */
    function settle(c: CanvasRenderingContext2D, dip: number) {
      c.globalCompositeOperation = "destination-in";
      const gx = c.createLinearGradient(0, 0, w, 0);
      gx.addColorStop(0, "rgba(0,0,0,0)");
      gx.addColorStop(0.1, "rgba(0,0,0,1)");
      gx.addColorStop(0.9, "rgba(0,0,0,1)");
      gx.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = gx;
      c.fillRect(0, 0, w, h);
      const gy = c.createLinearGradient(0, 0, 0, h);
      gy.addColorStop(0, "rgba(0,0,0,0)");
      gy.addColorStop(0.18, "rgba(0,0,0,1)");
      gy.addColorStop(1, "rgba(0,0,0,1)");
      c.fillStyle = gy;
      c.fillRect(0, 0, w, h);
      // Partly erase under the question so it sits on clear sky while the map stays continuous.
      c.globalCompositeOperation = "destination-out";
      c.save();
      c.translate((quiet.l + quiet.r) / 2, (quiet.t + quiet.b) / 2);
      c.scale((quiet.r - quiet.l) / 2 + 80, (quiet.b - quiet.t) / 2 + 60);
      const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, `rgba(0,0,0,${dip})`);
      g.addColorStop(0.65, `rgba(0,0,0,${dip * 0.93})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = g;
      c.fillRect(-1, -1, 2, 2);
      c.restore();
      c.globalCompositeOperation = "source-over";
    }

    function renderLand() {
      landCanvas!.width = Math.round(w * dpr);
      landCanvas!.height = Math.round(h * dpr);
      lc!.setTransform(dpr, 0, 0, dpr, 0, 0);
      lc!.clearRect(0, 0, w, h);
      if (!rings.length) return;
      traceLand(lc!);
      lc!.fillStyle = `rgba(${ACCENT_BRIGHT}, 0.12)`;
      lc!.fill("evenodd");
      lc!.lineWidth = 0.75;
      lc!.lineJoin = "round";
      lc!.strokeStyle = `rgba(${ACCENT}, 0.2)`;
      lc!.stroke();
      landCanvas!.dataset.ready = "";
      settle(lc!, 0.75);
    }

    /** An airport's light: the busier the brighter. */
    const light = (p: Port) => (p.tier === 1 ? { r: 1.9, a: 0.6 } : p.tier === 2 ? { r: 1.6, a: 0.5 } : p.tier === 3 ? { r: 1.4, a: 0.42 } : { r: 1.2, a: 0.36 });

    /** Fades airport lights on or off by whether a flight uses them, over `dt` s (0 for instant). Returns whether any changed. */
    function lightPorts(dt: number): boolean {
      const active = new Set<Port>();
      for (const f of traffic.flights) {
        active.add(f.from);
        active.add(f.to);
      }
      for (const p of active) if (!lit.has(p)) lit.set(p, { k: 0, on: true });
      let changed = false;
      for (const [p, l] of lit) {
        l.on = active.has(p);
        const to = l.on ? 1 : 0;
        if (l.k === to) continue;
        changed = true;
        l.k = dt > 0 ? (l.on ? Math.min(1, l.k + dt / LIGHT) : Math.max(0, l.k - dt / (LIGHT * 2))) : to;
        if (!l.on && l.k === 0) lit.delete(p);
      }
      return changed;
    }

    /** Draws the airport lights; each blooms as it comes on and fades as it goes out. */
    function renderPorts() {
      pc!.setTransform(1, 0, 0, 1, 0, 0);
      pc!.clearRect(0, 0, portCanvas!.width, portCanvas!.height);
      pc!.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const [p, { k, on }] of lit) {
        const [x, y] = at(p.lon, p.lat);
        if (x < -6 || x > w + 6 || y < -6 || y > h + 6) continue;
        const l = light(p);
        const bloom = on ? Math.sin(Math.PI * k) : 0;
        const r = l.r * (1 + 0.8 * bloom);
        const a = l.a * seen(x, y, 0.75) * (easeOut(k) + 0.6 * bloom);
        if (a < 0.01) continue;
        pc!.fillStyle = `rgba(${ACCENT}, ${a})`;
        pc!.beginPath();
        pc!.arc(x, y, r, 0, Math.PI * 2);
        pc!.fill();
      }
    }

    /** Re-measures the question's box in scene px. Returns whether it moved by more than 1px. */
    function requote(): boolean {
      const rect = box!.getBoundingClientRect();
      const mark = document.querySelector("[data-quiet]");
      const q = mark?.getBoundingClientRect();
      const next = q ? { l: q.left - rect.left, r: q.right - rect.left, t: q.top - rect.top, b: q.bottom - rect.top } : { l: w * 0.25, r: w * 0.75, t: h * 0.35, b: h * 0.6 };
      const moved = Math.max(Math.abs(next.l - quiet.l), Math.abs(next.r - quiet.r), Math.abs(next.t - quiet.t), Math.abs(next.b - quiet.b)) > 1;
      quiet = next;
      return moved;
    }

    /** Resizes and redraws everything; re-bakes the clouds unless `bake` is false (mid-resize). */
    function layout(bake = true) {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = box!.getBoundingClientRect();
      w = Math.max(1, rect.width);
      h = Math.max(1, rect.height);
      canvas!.width = Math.round(w * dpr);
      canvas!.height = Math.round(h * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.imageSmoothingQuality = "high";
      portCanvas!.width = Math.round(w * dpr);
      portCanvas!.height = Math.round(h * dpr);
      sky?.resize(w, h, dpr * quality);
      planeScale = 0.9 * Math.max(0.8, Math.min(1.15, w / 1440));
      requote();

      const aspect = (LAT_MAX - LAT_MIN) / (LON_MAX - LON_MIN);
      // Slightly wider than the frame for the edge fade, and centred a little low so the busy north sits around the question.
      mapW = w * 1.04;
      mapH = mapW * aspect;
      mapY = h * 0.52 - mapH * 0.5;
      if (w < h * 0.9) {
        // A portrait screen fills by height, centred under the question, and crops the sides.
        mapH = Math.max(mapH, h * 0.72);
        mapW = mapH / aspect;
        mapY = h * 0.5 - mapH * 0.5;
      }
      mapX = (w - mapW) / 2;
      renderLand();
      renderPorts();
      if (bake) bakeClouds();
      placeClouds();
      if (!sky) drawStill();

      // Count scales with map area so phones look as busy as laptops. It only grows; shrinking would make aircraft vanish.
      traffic.seed(Math.max(MIN_CRAFT, Math.min(MAX_CRAFT, Math.round(mapW * h * DENSITY))));
    }

    function place() {
      const flights = traffic.flights;
      if (cx.length < flights.length) {
        cx = new Float32Array(flights.length);
        cy = new Float32Array(flights.length);
      }
      for (let i = 0; i < flights.length; i++) [cx[i], cy[i]] = at(flights[i].lon, flights[i].lat);
    }

    // ── The traffic, drawn ────────────────────────────────────────────────

    const fadeOf = (f: Flight) => (f.arrived >= 0 ? 1 - f.arrived / FADE : Math.min(1, f.age / FADE));
    const drawnLength = (f: Flight) => lengthPx(f.type) * planeScale * (0.62 + 0.38 * altitude(f));

    const trailX = new Float32Array(12);
    const trailY = new Float32Array(12);
    /** The contrail: a ribbon back along the great circle, tapering, longer at cruise. */
    function drawTrail(f: Flight, i: number, strength: number) {
      const alt = altitude(f);
      const back = Math.min(f.flown, (300 + 1400 * alt) * 1000);
      if (back < 30000 || strength < 0.02) return;
      const brg = bearing(f.lat, f.lon, f.from.lat, f.from.lon);
      trailX[0] = cx[i];
      trailY[0] = cy[i];
      let n = 1;
      for (let j = 1; j <= 10; j++) {
        const [la, lo] = step(f.lat, f.lon, brg, (back * j) / 10);
        const [x, y] = at(lo, la);
        // Stop at the map's wrap seam instead of streaking across.
        if (Math.abs(x - trailX[n - 1]) > mapW / 2) break;
        trailX[n] = x;
        trailY[n] = y;
        n++;
      }
      if (n < 2) return;
      const half = (0.7 + 0.9 * alt) * planeScale;
      const edge = (j: number, side: 1 | -1) => {
        const a = Math.max(0, j - 1);
        const b = Math.min(n - 1, j + 1);
        const dx = trailX[b] - trailX[a];
        const dy = trailY[b] - trailY[a];
        const len = Math.hypot(dx, dy) || 1;
        const hw = side * (half * (1 - j / (n - 1)) ** 0.8 + 0.1);
        ctx!.lineTo(trailX[j] - (dy / len) * hw, trailY[j] + (dx / len) * hw);
      };
      ctx!.beginPath();
      for (let j = 0; j < n; j++) edge(j, 1);
      for (let j = n - 1; j >= 0; j--) edge(j, -1);
      ctx!.closePath();
      const g = ctx!.createLinearGradient(trailX[0], trailY[0], trailX[n - 1], trailY[n - 1]);
      g.addColorStop(0, `rgba(${ACCENT}, ${0.3 * strength})`);
      g.addColorStop(1, `rgba(${ACCENT}, 0)`);
      ctx!.fillStyle = g;
      ctx!.fill();
    }

    /** Shadow from a light high to the upper left: offset further down-right and fainter with altitude. */
    function drawShadow(f: Flight, i: number, strength: number) {
      const sp = sprites.get(f.type.icon);
      if (!sp || strength < 0.01) return;
      const alt = altitude(f);
      const k = (drawnLength(f) * (1 + 0.05 * alt)) / sp.len;
      const off = 1.2 + 7.5 * alt;
      ctx!.save();
      ctx!.translate(cx[i] + off * 0.75, cy[i] + off * 1.25);
      ctx!.rotate((f.heading * Math.PI) / 180);
      ctx!.globalAlpha = (0.3 - 0.16 * alt) * strength;
      ctx!.drawImage(sp.shadow, -sp.cx * k, -sp.cy * k, sp.shadow.width * k, sp.shadow.height * k);
      ctx!.restore();
    }

    function drawPlane(f: Flight, i: number, strength: number) {
      const sp = sprites.get(f.type.icon);
      const x = cx[i];
      const y = cy[i];
      ctx!.globalAlpha = strength;
      if (sp) {
        const k = drawnLength(f) / sp.len;
        ctx!.save();
        ctx!.translate(x, y);
        // The silhouettes point north, and north is up.
        ctx!.rotate((f.heading * Math.PI) / 180);
        ctx!.drawImage(sp.plane, -sp.cx * k, -sp.cy * k, sp.plane.width * k, sp.plane.height * k);
        ctx!.restore();
      } else {
        ctx!.fillStyle = `rgb(${ACCENT})`;
        ctx!.beginPath();
        ctx!.arc(x, y, 2.4, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalAlpha = 1;
    }

    function paint() {
      ctx!.clearRect(0, 0, w, h);
      if (spritesAt < 0) return;
      const flights = traffic.flights;
      const appear = stillness ? 1 : clamp01((clock - spritesAt) / 0.6);
      // Faded at the ends of its flight, faint behind the question and at the edges.
      const strength = (f: Flight, i: number) => appear * clamp01(fadeOf(f)) * behind(cx[i], cy[i]) * seen(cx[i], cy[i], 0);
      for (let i = 0; i < flights.length; i++) drawTrail(flights[i], i, strength(flights[i], i));
      for (let i = 0; i < flights.length; i++) drawShadow(flights[i], i, strength(flights[i], i));
      for (let i = 0; i < flights.length; i++) drawPlane(flights[i], i, strength(flights[i], i));
    }

    // ── The stir ──────────────────────────────────────────────────────────

    /** Pointer in client coordinates, and a smoothed point trailing it in scene px, so a flick leaves a smooth wake. */
    let pointer: { x: number; y: number } | null = null;
    const aim = { x: 0, y: 0, vx: 0, vy: 0, on: false };
    const inClouds = (y: number) => y < deckReach() || y > footTop();

    function steer(dt: number) {
      // The page may have moved under the pointer.
      let over = false;
      let tx = aim.x;
      let ty = aim.y;
      if (pointer) {
        const rect = box!.getBoundingClientRect();
        tx = pointer.x - rect.left;
        ty = pointer.y - rect.top;
        over = tx >= 0 && ty >= 0 && tx <= rect.width && ty <= rect.height;
      }
      // On entry, snap to the pointer instead of sweeping in from the last position.
      if (!aim.on) {
        aim.x = tx;
        aim.y = ty;
        aim.vx = 0;
        aim.vy = 0;
      }
      aim.on = over;
      const px = aim.x;
      const py = aim.y;
      const k = 1 - Math.exp(-dt / FOLLOW);
      aim.x += (tx - aim.x) * k;
      aim.y += (ty - aim.y) * k;
      const kv = 1 - Math.exp(-dt / 0.09);
      aim.vx += ((aim.x - px) / dt - aim.vx) * kv;
      aim.vy += ((aim.y - py) / dt - aim.vy) * kv;
      wake.follow(px, py, aim.x, aim.y, aim.vx, aim.vy, dt, over && inClouds(aim.y), scale());
    }

    function drawSky() {
      const n = stir.pack(splatA, splatB);
      sky?.draw({ time: clock, sets: states, splatA, splatB, splats: n });
    }

    // ── The clock ─────────────────────────────────────────────────────────

    let frame = 0;
    let requoted = 0;
    let running = false;
    let last = 0;
    let probed = false;
    let probeN = 0;
    let probeMs = 0;
    const tick = (now: number) => {
      // Time-based motion; dt is capped at 50 ms so a stall doesn't cause a jump.
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      if (!probed && last && clock > PROBE_SETTLE_S) {
        probeMs += now - last;
        probeN++;
        if (probeMs >= PROBE_S * 1000) {
          probed = true;
          const fps = (probeN * 1000) / probeMs;
          if (fps < STILL_FPS) return freeze();
          if (sky && fps < SOFT_FPS) {
            quality = 0.6;
            sky.resize(w, h, dpr * quality);
          }
        }
      }
      last = now;
      clock += dt;
      traffic.step(dt);
      // The question can move (animated layout), so re-measure it every 8 frames and redraw if it moved.
      if (++requoted % 8 === 0 && requote()) {
        renderLand();
        renderPorts();
      }
      if (lightPorts(dt)) renderPorts();
      place();
      paint();
      steer(dt);
      windClouds(dt);
      placeClouds();
      drawSky();
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (running || stillness || document.hidden) return;
      running = true;
      last = 0;
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(frame);
    };
    /** Switches to a static image: stops the loop permanently and ignores the pointer. */
    const freeze = () => {
      stillness = true;
      stop();
      pointer = null;
      paint();
      drawSky();
    };
    /** Draws one static frame when the loop isn't running. */
    const still1 = () => {
      if (running) return;
      lightPorts(0);
      renderPorts();
      place();
      paint();
      placeClouds();
      drawSky();
    };

    layout();
    still1();
    start();

    loadSprites(`rgb(${ACCENT})`, "rgba(16, 38, 92, 0.9)")
      .then((got) => {
        if (disposed) return;
        sprites = got;
        spritesAt = clock;
        if (!running) paint();
      })
      .catch(() => {
        // No silhouettes: the aircraft are drawn as dots.
        spritesAt = clock;
        if (!running) paint();
      });
    fetch(LAND_URL)
      .then((r) => r.json() as Promise<Topology>)
      .then((t) => {
        if (disposed) return;
        rings = decodeLand(t);
        renderLand();
        if (!running) drawSky();
      })
      .catch(() => {
        // Without land the traffic still flies.
      });
    loadPorts(PORTS_URL)
      .then((list) => {
        if (!disposed) traffic.setPorts(list);
      })
      .catch(() => {
        // Keep the built-in airport table the traffic already uses.
      });

    // Redraw at the new size immediately so the sky doesn't show stretched; re-bake the clouds once resizing settles.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const redraw = () => {
      if (!running) return still1();
      place();
      paint();
      drawSky();
    };
    const ro = new ResizeObserver(() => {
      layout(false);
      redraw();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        bakeClouds();
        placeClouds();
        if (!sky) drawStill();
        redraw();
      }, 120);
    });
    ro.observe(box);
    // When the loop isn't running (reduced motion, slow device), catch question moves via the column's size changes.
    const column = document.querySelector("[data-quiet]")?.closest("main");
    const moves = new ResizeObserver(() => {
      if (running || !requote()) return;
      renderLand();
      still1();
    });
    if (column) moves.observe(column);
    const onPointer = (e: PointerEvent) => {
      if (stillness) return;
      if (e.pointerType !== "touch") {
        pointer = { x: e.clientX, y: e.clientY };
        return;
      }
      // Touch has no hover: a tap stirs the clouds where it lands, and a drag scrolls.
      if (e.type !== "pointerdown") return;
      const rect = box.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x >= 0 && y >= 0 && x <= rect.width && y <= rect.height && inClouds(y)) stir.emit(x, y, 130 * scale(), [0, 0], 120 * scale(), 0, 1.5);
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType !== "touch") pointer = null;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerdown", onPointer, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    const io = new IntersectionObserver(([entry]) => (entry.isIntersecting ? start() : stop()), { threshold: 0 });
    io.observe(box);

    return () => {
      disposed = true;
      stop();
      io.disconnect();
      ro.disconnect();
      moves.disconnect();
      clearTimeout(resizeTimer);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerdown", onPointer);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      sky?.dispose();
    };
  }, []);

  return (
    <div ref={wrap} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0" style={{ background: SKY }} />
      <canvas ref={landRef} className="absolute inset-0 h-full w-full opacity-0 transition-opacity duration-1000 data-[ready]:opacity-100" />
      <canvas ref={portRef} className="absolute inset-0 h-full w-full" />
      <canvas ref={skyRef} className="fade absolute inset-0 h-full w-full" />
      <canvas ref={stillRef} className="fade absolute inset-0 h-full w-full" />
      <canvas ref={airRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
