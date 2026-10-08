import { AIRPORT_LIST } from "@/lib/airports";
import { bearing, distance, step } from "./geo";

/**
 * Simulated air traffic for the home page map. Airports (lib/airports.ts plus public/airports-map.json) and aircraft
 * types are real; the flights are invented and show no flight numbers, airlines, times or prices. Each flies a great
 * circle TIME_SCALE times faster than real time, and when it lands another departs from that airport.
 */

export type Port = { code: string; city: string; lat: number; lon: number; tier: 1 | 2 | 3 | 4; weight: number };

/** Traffic weight by tier: the app's hubs draw the most, airports outside its table (tier 4) the least. */
const WEIGHT = { 1: 12, 2: 5, 3: 2, 4: 1 } as const;

/** Airports from the bundled table, available before anything loads so the first frame has traffic. */
const basePorts = (): Port[] => AIRPORT_LIST.map((a) => ({ code: a.code, city: a.city, lat: a.lat, lon: a.lon, tier: a.tier, weight: WEIGHT[a.tier] }));

/** The bundled table plus every other large airport with scheduled service, loaded from `url`. */
export async function loadPorts(url: string): Promise<Port[]> {
  const rows = (await (await fetch(url)).json()) as [string, string, number, number][];
  const out = basePorts();
  const known = new Set(out.map((p) => p.code));
  for (const [code, city, lat, lon] of rows) if (!known.has(code)) out.push({ code, city, lat, lon, tier: 4, weight: WEIGHT[4] });
  return out;
}

// ── The aircraft ────────────────────────────────────────────────────────────

/**
 * An aircraft type, drawn as its silhouette (`icon`, from public/aircraft) scaled by real length. Types without their own
 * icon use a close relative's; types with no close relative in the set (787, A350) are left out of the roster.
 */
export type Aircraft = { name: string; icon: string; length: number; cruise: number; range: [number, number]; weight: number };

export const ROSTER: Aircraft[] = [
  // Narrow-bodies, the bulk of traffic.
  { name: "Airbus A320neo", icon: "airbus-a320", length: 37.6, cruise: 840, range: [300, 5500], weight: 10 },
  { name: "Airbus A321neo", icon: "airbus-a320", length: 44.5, cruise: 840, range: [500, 7000], weight: 6 },
  { name: "Boeing 737-800", icon: "boeing-737-800", length: 39.5, cruise: 840, range: [300, 5000], weight: 10 },
  { name: "Boeing 737 MAX 8", icon: "boeing-737-800", length: 39.5, cruise: 840, range: [300, 6000], weight: 6 },
  { name: "Boeing 737-700", icon: "boeing-737-600", length: 33.6, cruise: 830, range: [300, 5000], weight: 4 },
  { name: "Boeing 757-200", icon: "boeing-757", length: 47.3, cruise: 850, range: [800, 6500], weight: 2 },
  // Regionals: rear engines and T-tails, or propellers on a high wing.
  { name: "Bombardier CRJ900", icon: "fokker-100", length: 36.2, cruise: 830, range: [200, 2500], weight: 3 },
  { name: "ATR 72-600", icon: "dash-8-q300", length: 27.2, cruise: 510, range: [150, 1200], weight: 3 },
  { name: "Dash 8 Q400", icon: "dash-8-q300", length: 32.8, cruise: 660, range: [150, 1800], weight: 2 },
  // Wide-bodies, for long haul.
  { name: "Boeing 767-300ER", icon: "boeing-767", length: 54.9, cruise: 850, range: [1500, 10000], weight: 2 },
  { name: "Airbus A330-300", icon: "airbus-a330", length: 63.7, cruise: 870, range: [2000, 11000], weight: 4 },
  { name: "Airbus A330-900", icon: "airbus-a330", length: 63.7, cruise: 870, range: [2000, 12000], weight: 3 },
  { name: "Boeing 777-300ER", icon: "boeing-777", length: 73.9, cruise: 900, range: [3000, 13500], weight: 6 },
  { name: "Boeing 747-8", icon: "boeing-747", length: 76.3, cruise: 910, range: [3000, 14000], weight: 2 },
  { name: "Airbus A380", icon: "airbus-a380", length: 72.7, cruise: 900, range: [4000, 15000], weight: 2 },
  { name: "Airbus A340-600", icon: "airbus-a340-600", length: 75.4, cruise: 870, range: [3000, 13000], weight: 1 },
  { name: "McDonnell Douglas MD-11F", icon: "mcdonnell-douglas-md-11", length: 61.6, cruise: 880, range: [2000, 12000], weight: 1 },
  // Business and general aviation.
  { name: "Gulfstream G650", icon: "learjet-60", length: 30.4, cruise: 900, range: [500, 12000], weight: 1 },
  { name: "Learjet 60", icon: "learjet-60", length: 17.9, cruise: 780, range: [300, 4000], weight: 1 },
  { name: "Beechcraft Baron", icon: "cessna-303", length: 9.1, cruise: 370, range: [100, 1200], weight: 1 },
  { name: "Cessna 208 Caravan", icon: "cessna-206", length: 12.7, cruise: 340, range: [80, 1000], weight: 1 },
];
/** A long-haul type: one that is not flown under 1,500 km. */
const isLong = (a: Aircraft) => a.range[0] >= 1500;

/** Drawn length in px before screen scaling: proportional to real length, with a floor so small aircraft keep a shape. */
export const lengthPx = (a: Aircraft) => Math.max(12, 8 + a.length * 0.34);

// ── The flights ─────────────────────────────────────────────────────────────

/** Simulation speed-up. At 400×, 900 km/h is 100 km/s: an Atlantic crossing takes about a minute, 4 to 8 px/s on a laptop. */
export const TIME_SCALE = 400;
/** Distance decay for destination choice, km: pull is weight × e^(−km / REACH), so 2,000 km away is about a third as likely. */
const REACH = 1800;
/** Seconds to fade in on departure and out on arrival. */
export const FADE = 0.9;

export type Flight = {
  type: Aircraft;
  from: Port;
  to: Port;
  /** Route length and distance flown, metres. */
  total: number;
  flown: number;
  lat: number;
  lon: number;
  /** Degrees from north. */
  heading: number;
  /** Seconds since departure, and seconds since arrival (-1 while flying). */
  age: number;
  arrived: number;
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Altitude from 0 (ground) to 1 (cruise): climbs over the first 14% of the route and descends over the last 14%. */
export function altitude(f: Flight): number {
  const t = f.total > 0 ? f.flown / f.total : 1;
  return Math.min(smooth(0, 0.14, t), 1 - smooth(0.86, 1, t));
}

export type Traffic = {
  flights: Flight[];
  setPorts(ports: Port[]): void;
  /** Adds flights up to `n`, each starting partway along its route so the first frame looks busy. */
  seed(n: number): void;
  /** Advances by `dt` seconds. */
  step(dt: number): void;
};

export function createTraffic(): Traffic {
  let ports = basePorts();
  const flights: Flight[] = [];

  /** Weighted random airport, used as a seeded flight's origin. */
  const pickPort = (among: Port[]) => {
    let r = Math.random() * among.reduce((n, p) => n + p.weight, 0);
    for (const p of among) {
      r -= p.weight;
      if (r <= 0) return p;
    }
    return among[among.length - 1];
  };
  /** Weighted random type for a departure; long-haul types rarely leave non-hubs. */
  const pickType = (from: Port) => {
    const weigh = (a: Aircraft) => (isLong(a) && from.tier > 2 ? a.weight * 0.05 : a.weight);
    let r = Math.random() * ROSTER.reduce((n, a) => n + weigh(a), 0);
    for (const a of ROSTER) {
      r -= weigh(a);
      if (r <= 0) return a;
    }
    return ROSTER[0];
  };

  /**
   * A new departure from `from`: a type, then a destination in its range by a gravity model (weight × distance decay), so most
   * flights are short hops. Long-haul types go to a hub in range, weighted by weight² with no distance decay.
   */
  function depart(from: Port): Flight {
    for (let tries = 0; ; tries++) {
      const type = tries < 8 ? pickType(from) : ROSTER[0];
      const [lo, hi] = tries < 8 ? type.range : [0, Infinity];
      const long = isLong(type);
      const reach: Port[] = [];
      const pull: number[] = [];
      for (const p of ports) {
        if (p.code === from.code) continue;
        const km = distance(from.lat, from.lon, p.lat, p.lon) / 1000;
        if (km < lo || km > hi) continue;
        reach.push(p);
        pull.push(long ? (p.tier <= 2 ? p.weight * p.weight : 0) : p.weight * Math.exp(-km / REACH));
      }
      if (!reach.length) continue;
      let total = pull.reduce((n, x) => n + x, 0);
      // No hub in range: weight every reachable airport by its weight alone.
      if (!total) {
        reach.forEach((p, i) => (pull[i] = p.weight));
        total = pull.reduce((n, x) => n + x, 0);
      }
      let r = Math.random() * total;
      let to = reach[reach.length - 1];
      for (let i = 0; i < reach.length; i++) {
        r -= pull[i];
        if (r <= 0) {
          to = reach[i];
          break;
        }
      }
      return { type, from, to, total: distance(from.lat, from.lon, to.lat, to.lon), flown: 0, lat: from.lat, lon: from.lon, heading: bearing(from.lat, from.lon, to.lat, to.lon), age: 0, arrived: -1 };
    }
  }

  return {
    flights,
    setPorts(p) {
      ports = p;
    },
    seed(n) {
      while (flights.length < n) {
        const f = depart(pickPort(ports));
        f.flown = f.total * Math.random();
        [f.lat, f.lon] = step(f.from.lat, f.from.lon, bearing(f.from.lat, f.from.lon, f.to.lat, f.to.lon), f.flown);
        f.heading = bearing(f.lat, f.lon, f.to.lat, f.to.lon);
        f.age = FADE;
        flights.push(f);
      }
    },
    step(dt) {
      for (let i = 0; i < flights.length; i++) {
        const f = flights[i];
        if (f.arrived >= 0) {
          f.arrived += dt;
          if (f.arrived >= FADE) {
            // Replace it with a new departure from the arrival airport.
            flights[i] = depart(f.to);
          }
          continue;
        }
        f.age += dt;
        // Slower at low altitude.
        const d = (f.type.cruise / 3.6) * TIME_SCALE * (0.42 + 0.58 * altitude(f)) * dt;
        if (f.total - f.flown <= d) {
          f.lat = f.to.lat;
          f.lon = f.to.lon;
          f.flown = f.total;
          f.arrived = 0;
          continue;
        }
        f.heading = bearing(f.lat, f.lon, f.to.lat, f.to.lon);
        [f.lat, f.lon] = step(f.lat, f.lon, f.heading, d);
        f.flown += d;
      }
    },
  };
}

// ── What they look like ─────────────────────────────────────────────────────

/**
 * An aircraft sprite built once from its icon: a solid silhouette with a white keyline (legible over land and cloud) and a blurred
 * shadow copy. Drawn SPRITE px nose to tail, then scaled to each aircraft's length.
 */
export type Sprite = { plane: HTMLCanvasElement; shadow: HTMLCanvasElement; len: number; cx: number; cy: number };

const SPRITE = 96;
const PAD = 12;
/** The white keyline's width, sprite px: about a pixel on an A320, a pixel and a half on an A380. */
const KEY = 4.5;
/** Offset that puts the shape off any canvas, so only its shadow lands on it. */
const FAR = 4000;

function image(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function sprite(img: HTMLImageElement, color: string, shade: string): Sprite | null {
  const src = document.createElement("canvas");
  src.width = img.naturalWidth;
  src.height = img.naturalHeight;
  const sg = src.getContext("2d", { willReadFrequently: true });
  if (!sg) return null;
  sg.drawImage(img, 0, 0);
  // Find the silhouette's bounding box, since scale is set by nose-to-tail length.
  const data = sg.getImageData(0, 0, src.width, src.height).data;
  let x0 = src.width;
  let y0 = src.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++)
      if (data[(y * src.width + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < x0 || y1 < y0) return null;
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const k = SPRITE / bh;
  const W = Math.ceil(bw * k) + PAD * 2;
  const H = Math.ceil(bh * k) + PAD * 2;
  const canvas = () => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    return c;
  };
  const tint = (fill: string) => {
    const c = canvas();
    const g = c.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(img, x0, y0, bw, bh, PAD, PAD, bw * k, bh * k);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = fill;
    g.fillRect(0, 0, W, H);
    return c;
  };
  const white = tint("#fff");
  const solid = tint(color);
  const plane = canvas();
  const pg = plane.getContext("2d")!;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    pg.drawImage(white, Math.cos(a) * KEY, Math.sin(a) * KEY);
  }
  pg.drawImage(solid, 0, 0);
  // Draw the shape off-canvas so only its blurred shadow lands; shadowBlur is the blur every browser supports.
  const shadow = canvas();
  const hg = shadow.getContext("2d")!;
  hg.shadowColor = shade;
  hg.shadowBlur = 7;
  hg.shadowOffsetX = FAR;
  hg.drawImage(solid, -FAR, 0);
  return { plane, shadow, len: SPRITE, cx: PAD + (bw * k) / 2, cy: PAD + (bh * k) / 2 };
}

/** Loads a sprite in `color` for each roster icon. Icons that fail are skipped, and their aircraft draw as dots. */
export async function loadSprites(color: string, shade: string): Promise<Map<string, Sprite>> {
  const names = [...new Set(ROSTER.map((a) => a.icon))];
  const out = new Map<string, Sprite>();
  await Promise.all(
    names.map(async (n) => {
      try {
        const s = sprite(await image(`/aircraft/${n}.png`), color, shade);
        if (s) out.set(n, s);
      } catch {
        // No silhouette for this one; it is drawn as a dot.
      }
    })
  );
  return out;
}
