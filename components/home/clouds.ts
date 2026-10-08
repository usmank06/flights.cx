/**
 * Home page cloud layout and pointer stir. Banks and decks are laid out from fixed seeds and baked once as tiling strips;
 * sky-gl.ts draws them. The stir is integrated in seconds rather than frames, so it's frame-rate independent.
 */

export type Bank = {
  seed: number;
  /** Where the cluster bottoms sit, and how much they vary, as shares of the cloud band's height. */
  base: number;
  spread: number;
  size: number;
  height: number;
  light: string;
  alpha: number;
  /** Spacing between clusters: [fixed, random] shares of a cluster's width. */
  gap: [number, number];
  /** The wind at this depth, px a second on a laptop. */
  wind: number;
  /** How much of the stir this bank takes: the nearer, the more. */
  push: number;
  thin: number;
};

export const BANKS: Bank[] = [
  { seed: 11, base: 0.58, spread: 0.1, size: 0.85, height: 0.85, light: "238,245,255", alpha: 0.6, gap: [1.2, 1], wind: 7, push: 0.55, thin: 0.7 },
  { seed: 5, base: 0.77, spread: 0.1, size: 1.1, height: 0.95, light: "251,253,255", alpha: 0.92, gap: [0.95, 0.6], wind: 12, push: 0.8, thin: 0.9 },
  { seed: 29, base: 0.98, spread: 0.05, size: 1.4, height: 0.95, light: "255,255,255", alpha: 1, gap: [0.6, 0.25], wind: 19, push: 1, thin: 1 },
];

/** The band the clouds are laid out in: the scene below this share of its height, and LIFT px above it. */
export const BAND_TOP = 0.65;
export const LIFT = 140;
/** Texels per CSS pixel in the baked banks: enough for the small puffs on their tops to keep a shape. */
const BAKE = 0.66;

/** A small seeded PRNG (mulberry32), so the clouds are the same every time. */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Radius of the puff sprites, px: one soft puff drawn once and scaled to every puff. */
const SPRITE = 64;

function puffSprite(stops: [number, string][], inner: [number, number]): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = SPRITE * 2;
  c.height = SPRITE * 2;
  const x = c.getContext("2d");
  if (x) {
    const g = x.createRadialGradient(inner[0], inner[1], 0, SPRITE, SPRITE, SPRITE);
    for (const [at, color] of stops) g.addColorStop(at, color);
    x.fillStyle = g;
    x.fillRect(0, 0, SPRITE * 2, SPRITE * 2);
  }
  return c;
}

/**
 * Layout width for a strip, in the puffs' own scale. Constant up to large-laptop widths, so a resize or rotation rescales
 * the same clouds instead of generating new ones.
 */
const cover = (W: number) => Math.max(W, 1920 * Math.min(1, Math.max(0.5, W / 1100)));

/** A baked tiling strip: its canvas, tile width, and vertical placement, in CSS px. */
export type BakedBank = { canvas: HTMLCanvasElement; tileW: number; top: number; height: number };

/** Bakes a bank for a `W` × `H` px scene as a tiling strip ending at `bottom`. Narrower screens get smaller puffs. */
export function bakeBank(b: Bank, W: number, H: number, bottom = H + 40, shrink = 1): BakedBank {
  const r = seeded(b.seed);
  // 0.9 leaves room for the map above; `shrink` is for short screens.
  const k = 0.9 * Math.min(1, Math.max(0.5, W / 1100)) * shrink;
  const bandTop = H * BAND_TOP;
  const bandH = H - bandTop;
  const margin = 360 * k;
  type P = { x: number; y: number; r: number };
  const puffs: P[] = [];
  let x = 0;
  // At least a screen and a half of cloud before the strip repeats.
  while (x < cover(W) * 1.5 + margin * 2) {
    const cw = (170 + r() * 260) * b.size * k;
    const by = bandTop + bandH * b.base + r() * bandH * b.spread;
    const n = (9 + r() * 9) | 0;
    for (let i = 0; i < n; i++) {
      const t = 0.08 + r() * 0.84;
      const hump = Math.sin(Math.PI * t);
      const p = { x: x + t * cw, y: by - hump * (24 + r() * 70) * b.height * k + r() * 18 * k, r: (26 + r() * 26 + hump * 52) * b.size * k };
      puffs.push(p);
      // A few smaller puffs along the upper rim, centred just inside it.
      const m = 2 + ((r() * 3) | 0);
      for (let j = 0; j < m; j++) {
        const a = Math.PI * (1.12 + r() * 0.76);
        const rr = p.r * (0.26 + r() * 0.18);
        const d = p.r - rr * (0.55 + r() * 0.35);
        puffs.push({ x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d, r: rr });
      }
    }
    x += cw * b.gap[0] + r() * cw * b.gap[1];
  }
  // The strip ends after the last gap, so spacing across the wrap seam matches the rest.
  const span = x;
  const top = bandTop - LIFT;
  const height = Math.max(1, bottom - top);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.round(span * BAKE));
  canvas.height = Math.max(2, Math.round(height * BAKE));
  const sx = canvas.width / span;
  const sy = canvas.height / height;
  const g = canvas.getContext("2d");
  if (g) {
    // Brightest a little up and to the left.
    const light = puffSprite(
      [
        [0, `rgba(${b.light},1)`],
        [0.62, `rgba(${b.light},0.96)`],
        [0.86, `rgba(${b.light},0.45)`],
        [1, `rgba(${b.light},0)`],
      ],
      [SPRITE * 0.88, SPRITE * 0.82]
    );
    g.globalAlpha = b.alpha;
    // Uniformly lit (no darker base). Puffs crossing a strip end are drawn again at the other end so it tiles.
    for (const p of puffs) {
      const py = p.y - top;
      for (const wrap of [-span, 0, span]) {
        const px = p.x + wrap;
        if (px + p.r < 0 || px - p.r > span) continue;
        g.drawImage(light, (px - p.r) * sx, (py - p.r) * sy, p.r * 2 * sx, p.r * 2 * sy);
      }
    }
    if (bottom < H + 40) {
      // Ended early under other clouds: fade the bottom out so thinning those clouds doesn't reveal a hard edge.
      g.globalAlpha = 1;
      g.globalCompositeOperation = "destination-out";
      const fade = g.createLinearGradient(0, canvas.height - 90 * sy, 0, canvas.height);
      fade.addColorStop(0, "rgba(0,0,0,0)");
      fade.addColorStop(1, "rgba(0,0,0,1)");
      g.fillStyle = fade;
      g.fillRect(0, canvas.height - 90 * sy, canvas.width, 90 * sy);
      g.globalCompositeOperation = "source-over";
    }
  }
  return { canvas, tileW: span, top, height };
}

// ── The stir ────────────────────────────────────────────────────────────────

/** Max patches of stirred air the shader supports; GPUs with fewer uniforms get fewer (see sky-gl.ts). */
export const MAX_SPLATS = 32;

type Spring = { x: number; v: number };
type Splat = {
  on: boolean;
  x: number;
  y: number;
  /** 1 / radius², for the shader's falloff. */
  k: number;
  /** Drag (dx, dy), outward push, swirl and thinning, each a damped spring; displacements in px. */
  dx: Spring;
  dy: Spring;
  out: Spring;
  swirl: Spring;
  thin: Spring;
  age: number;
};

const spring = (): Spring => ({ x: 0, v: 0 });
/** Drag, push and swirl springs: ω = 2.5 rad/s (about a 2.5 s period), damping 0.55 for slight overshoot. */
const W_MOVE = 2.5;
const Z_MOVE = 0.55;
/** Thinning spring: a little slower, and critically damped (no overshoot). */
const W_THIN = 1.35;

function settleSpring(s: Spring, w: number, z: number, dt: number) {
  s.v += (-w * w * s.x - 2 * z * w * s.v) * dt;
  s.x += s.v * dt;
}

export type Stir = {
  /**
   * Adds a patch of stirred air at (x, y), radius r, with initial velocities (px/s; thinning in share/s). Returns false when
   * every slot holds a patch still moving, since recycling one would make the clouds jump back.
   */
  emit(x: number, y: number, r: number, drag: [number, number], out: number, swirl: number, thin: number): boolean;
  /** Advances `dt` seconds, drifting the wake `drift` px/s with the wind. */
  step(dt: number, drift: number): void;
  /** Packs live patches into the shader's two arrays and returns the count. */
  pack(a: Float32Array, b: Float32Array): number;
  clear(): void;
};

export function createStir(limit: number): Stir {
  const splats: Splat[] = Array.from({ length: Math.max(0, Math.min(MAX_SPLATS, limit)) }, () => ({ on: false, x: 0, y: 0, k: 0, dx: spring(), dy: spring(), out: spring(), swirl: spring(), thin: spring(), age: 0 }));
  const energy = (s: Splat) => Math.abs(s.dx.x) + Math.abs(s.dy.x) + Math.abs(s.out.x) + Math.abs(s.swirl.x) + Math.abs(s.dx.v) * 0.2 + Math.abs(s.dy.v) * 0.2 + Math.abs(s.out.v) * 0.2 + s.thin.x * 60;
  return {
    emit(x, y, r, drag, out, swirl, thin) {
      if (!splats.length) return false;
      // A free slot, else the weakest patch if it has nearly settled.
      let pick = splats.find((s) => !s.on);
      if (!pick) {
        const weakest = splats.reduce((a, s) => (energy(s) < energy(a) ? s : a));
        if (energy(weakest) > 3) return false;
        pick = weakest;
      }
      Object.assign(pick, { on: true, x, y, k: 1 / (r * r), age: 0 });
      pick.dx = { x: 0, v: drag[0] };
      pick.dy = { x: 0, v: drag[1] };
      pick.out = { x: 0, v: out };
      pick.swirl = { x: 0, v: swirl };
      pick.thin = { x: 0, v: thin };
      return true;
    },
    step(dt, drift) {
      // Substeps of at most 1/60 s keep the springs stable on slow frames.
      const n = Math.max(1, Math.ceil(dt * 60));
      const h = dt / n;
      for (const s of splats) {
        if (!s.on) continue;
        for (let i = 0; i < n; i++) {
          settleSpring(s.dx, W_MOVE, Z_MOVE, h);
          settleSpring(s.dy, W_MOVE, Z_MOVE, h);
          settleSpring(s.out, W_MOVE, Z_MOVE, h);
          settleSpring(s.swirl, W_MOVE, Z_MOVE, h);
          settleSpring(s.thin, W_THIN, 1, h);
        }
        if (s.thin.x < 0) s.thin = { x: 0, v: Math.max(0, s.thin.v) };
        s.x += drift * dt;
        s.age += dt;
        if (s.age > 1 && energy(s) < 0.4) s.on = false;
      }
    },
    pack(a, b) {
      let n = 0;
      for (const s of splats) {
        if (!s.on) continue;
        a.set([s.x, s.y, s.k, Math.max(0, s.thin.x)], n * 4);
        b.set([s.dx.x, s.dy.x, s.out.x, s.swirl.x], n * 4);
        n++;
      }
      return n;
    },
    clear() {
      for (const s of splats) s.on = false;
    },
  };
}

// ── The wind and the wake ───────────────────────────────────────────────────

/** Gust multiplier at `t` seconds, wandering slowly between about 0.7 and 1.35. */
export const gust = (t: number) => 1 + 0.26 * Math.sin(t * 0.071) * Math.sin(t * 0.043 + 1.3) + 0.08 * Math.sin(t * 0.31 + 0.5);

/** Base px between wake patches at slow pointer speeds; spacing grows with speed. */
const SPACING = 34;

/**
 * The pointer's wake: patches spaced evenly along its path regardless of frame rate, larger and further apart at speed,
 * plus an occasional small one while it rests.
 */
export function createWake(stir: Stir) {
  let travelled = 0;
  let quietFor = 0;
  return {
    /**
     * The smoothed pointer moved from (px, py) to (x, y) over `dt` s at (vx, vy) px/s. `inside`: whether it is in the clouds.
     * `s`: the stir's scale for the screen size.
     */
    follow(px: number, py: number, x: number, y: number, vx: number, vy: number, dt: number, inside: boolean, s: number) {
      if (!inside) {
        travelled = 0;
        quietFor = 0;
        return;
      }
      const speed = Math.hypot(vx, vy);
      const moved = Math.hypot(x - px, y - py);
      const f = Math.min(1, speed / 1400);
      const g = Math.sqrt(f);
      const spacing = (SPACING + 40 * f) * s;
      const ux = speed > 1 ? vx / speed : 0;
      const uy = speed > 1 ? vy / speed : 0;
      travelled += moved;
      quietFor += dt;
      for (let left = 6; travelled >= spacing && left > 0; left--) {
        // Where along this frame's stretch of the path the patch falls.
        const t = moved > 0 ? Math.max(0, Math.min(1, 1 - (travelled - spacing) / moved)) : 1;
        stir.emit(px + (x - px) * t, py + (y - py) * t, (105 + 55 * g) * s, [ux * 170 * g * s, uy * 170 * g * s], (70 + 80 * g) * s, 150 * g * s, 1.1 + 0.9 * g);
        travelled -= spacing;
        quietFor = 0;
      }
      // After a stall, drop the backlog instead of emitting a burst.
      if (travelled >= spacing) travelled = 0;
      if (quietFor > 0.35 && speed < 40) {
        stir.emit(x, y, 115 * s, [0, 0], 50 * s, 0, 0.55);
        quietFor = 0;
      }
    },
  };
}

// ── The deck from below ─────────────────────────────────────────────────────

/** A deck: clouds seen from below, hanging from the top band with sky between them. Baked as a tiling strip like the banks. */
export type Deck = {
  seed: number;
  /** How far down the band the deck reaches, and where cloud bases hang within that, as shares. */
  reach: number;
  base: number;
  spread: number;
  size: number;
  /** Spacing between clouds: [fixed, random] shares of a cloud's width. Above 1 leaves sky between them. */
  gap: [number, number];
  light: string;
  alpha: number;
  /** The wind at this depth, px a second on a laptop; and its share of the stir. */
  wind: number;
  push: number;
  thin: number;
};

export const DECKS: Deck[] = [
  { seed: 17, reach: 0.26, base: 0.64, spread: 0.24, size: 0.62, gap: [0.8, 0.9], light: "250,252,255", alpha: 0.9, wind: 5, push: 0.55, thin: 0.7 },
  { seed: 29, reach: 0.32, base: 0.68, spread: 0.24, size: 0.84, gap: [0.9, 1.1], light: "253,254,255", alpha: 0.96, wind: 9, push: 0.8, thin: 0.9 },
  { seed: 41, reach: 0.4, base: 0.72, spread: 0.22, size: 1.08, gap: [0.95, 1.25], light: "255,255,255", alpha: 1, wind: 14, push: 1, thin: 1 },
];

/** How far above the band each deck's strip starts, px, so cloud bodies can reach up into the banks above. */
const ABOVE = 170;

/** Bakes one deck for a `W` × `H` px band as a tiling strip starting ABOVE px over the band's top. */
export function bakeDeck(d: Deck, W: number, H: number, shrink = 1): BakedBank {
  const r = seeded(d.seed);
  const k = Math.min(1, Math.max(0.5, W / 1100)) * shrink;
  const reach = H * d.reach;
  // Bodies reach past the band's top into the banks above, so the two read as one layer.
  const roof = -60 * k;
  type P = { x: number; y: number; r: number };
  type Cloud = { x: number; w: number; low: number; puffs: P[]; body: P[] };
  const clouds: Cloud[] = [];
  let x = 0;
  // At least a screen and a half of cloud before the strip repeats.
  while (x < cover(W) * 1.5 + 400 * k) {
    const cw = (120 + r() * 340) * d.size * k;
    const low = reach * d.base + (r() - 0.5) * reach * d.spread;
    const puffs: P[] = [];
    const n = (10 + r() * 8) | 0;
    for (let i = 0; i < n; i++) {
      const t = 0.05 + r() * 0.9;
      const sag = Math.sin(Math.PI * t);
      const pr = (22 + r() * 22 + sag * 44) * d.size * k;
      // Hanging: lowest in the middle, with puff undersides near the base but jittered.
      puffs.push({ x: x + t * cw, y: low - pr * 0.9 - (1 - sag) * (16 + r() * 40) * k + (r() - 0.5) * 26 * d.size * k, r: pr });
    }
    // Its body, up into the deck.
    const body: P[] = [];
    for (let y = low - 90 * d.size * k; y > roof - 30 * k; y -= 46 * d.size * k) {
      const pr = (46 + r() * 30) * d.size * k;
      body.push({ x: x + cw * (0.25 + r() * 0.5), y, r: pr });
    }
    clouds.push({ x, w: cw, low, puffs, body });
    x += cw * (d.gap[0] + r() * d.gap[1]);
  }
  // The strip ends after the last gap, so spacing across the wrap seam matches the rest.
  const span = x;
  const height = reach + ABOVE;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.round(span * BAKE));
  canvas.height = Math.max(2, Math.round(height * BAKE));
  const g = canvas.getContext("2d");
  if (g) {
    g.scale(canvas.width / span, canvas.height / height);
    g.translate(0, ABOVE);
    g.globalAlpha = d.alpha;
    // Lit from above, and through: brightest toward the top of each puff.
    const light = puffSprite(
      [
        [0, `rgba(${d.light},1)`],
        [0.62, `rgba(${d.light},0.96)`],
        [0.86, `rgba(${d.light},0.46)`],
        [1, `rgba(${d.light},0)`],
      ],
      [SPRITE, SPRITE * 0.7]
    );
    for (const c of clouds) {
      for (const wrap of [-span, 0, span]) {
        const cx = c.x + wrap;
        // Skip copies with nothing on the strip; puffs extend past the cloud's ends by up to their radius.
        const past = c.w * 0.1 + 110 * d.size * k;
        if (cx + c.w + past < 0 || cx - past > span) continue;
        // Uniformly lit, with no shaded base.
        for (const p of [...c.body, ...c.puffs]) g.drawImage(light, p.x + wrap - p.r, p.y - p.r * 0.14 - p.r, p.r * 2, p.r * 2);
      }
    }
  }
  return { canvas, tileW: span, top: -ABOVE, height };
}
