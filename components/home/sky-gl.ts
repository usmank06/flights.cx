import { BANKS, MAX_SPLATS, type BakedBank } from "./clouds";

/**
 * WebGL cloud renderer, layered between the map and the traffic. scene.tsx supplies positions and the stir; this only draws.
 * `createSkyGL` returns null without WebGL, with software rendering, without highp fragment floats, or when the context isn't
 * real WebGL (some bots and privacy tools fake one). The clouds are then drawn once as a still image. It never throws.
 */

const VERT = `
attribute vec2 aPos;
uniform vec2 uSize;
varying vec2 vPx;
void main() {
  vPx = aPos;
  vec2 c = aPos / uSize * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;

const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif`;

/** Fragment shader for three banks, back to front, each shifted, warped, stirred and thinned; supports `n` stir patches. */
const cloudShader = (n: number) => `${PRECISION}
varying vec2 vPx;
uniform float uTime;
uniform sampler2D uBank0;
uniform sampler2D uBank1;
uniform sampler2D uBank2;
uniform vec4 uGeo[3];  // wind shift (px), tile width (px), top of the strip (px), its height (px)
uniform vec4 uOff[3];  // 0, the bob (px), share of the stir, share of the thinning
uniform vec4 uWarp[3]; // seed, and two wavenumbers across that fit a whole number of waves into a tile
${n ? `uniform vec4 uSplatA[${n}]; // x, y (px), 1 / radius², thinning
uniform vec4 uSplatB[${n}]; // drag x, drag y, outward, swirl (px)
uniform int uSplats;` : ""}

// Slow waves that travel with the cloud and change as it goes: it billows rather than sliding by as a picture.
vec2 warp(vec2 q, float t, vec4 k) {
  float s = k.x;
  vec2 big = vec2(
    sin(q.y * 0.0121 + t * 0.23 + s + 1.3 * sin(q.x * k.y - t * 0.17 + s * 1.7)),
    sin(q.x * k.y + t * 0.19 + s * 2.1 + 1.2 * sin(q.y * 0.0097 + t * 0.13)));
  vec2 small = vec2(
    sin(q.y * 0.035 - t * 0.41 + s * 3.3 + sin(q.x * k.z + t * 0.29)),
    sin(q.x * k.z + t * 0.37 + s * 0.7 + sin(q.y * 0.029 - t * 0.23)));
  return big * 9.0 + small * 3.0;
}

vec4 bank(sampler2D tex, vec4 geo, vec4 off, vec4 wk, vec2 p, vec2 disp, float thin) {
  // Where this pixel looks in the air: back along the stir, then into the cloud's own frame, carried by the wind.
  vec2 q = p - off.xy - disp * off.z;
  q.x -= geo.x;
  q += warp(q, uTime, wk);
  float v = (q.y - geo.z) / geo.w;
  if (v <= 0.0 || v >= 1.0) return vec4(0.0);
  vec4 c = texture2D(tex, vec2(fract(q.x / geo.y), v));
  return c * (1.0 - min(0.82, thin * off.w));
}

void main() {
  vec2 p = vPx;
  vec2 disp = vec2(0.0);
  float thin = 0.0;
  ${n ? "" : "/*"}
  for (int i = 0; i < ${Math.max(1, n)}; i++) {
    if (i >= uSplats) break;
    vec4 A = uSplatA[i];
    vec2 d = p - A.xy;
    float f = 1.0 - dot(d, d) * A.z;
    if (f <= 0.0) continue;
    vec4 B = uSplatB[i];
    float g = f * f * f;
    float len = length(d) + 0.001;
    vec2 n = d / len;
    // Which side of the pointer's path, and how far round: the swirl turns one way on each side, and not at all on it.
    float side = (d.x * B.y - d.y * B.x) / (len * max(length(B.xy), 24.0));
    // The push and the swirl point away from the middle, which has no direction: they fade in from it, or each patch leaves a pinpoint there.
    float core = smoothstep(0.0, 0.35, len * sqrt(A.z));
    disp += g * (B.xy + core * (n * B.z + vec2(-n.y, n.x) * side * B.w));
    thin += g * A.w;
  }
  ${n ? "" : "*/"}
  vec4 c = bank(uBank0, uGeo[0], uOff[0], uWarp[0], p, disp, thin);
  vec4 c1 = bank(uBank1, uGeo[1], uOff[1], uWarp[1], p, disp, thin);
  c = c1 + c * (1.0 - c1.a);
  vec4 c2 = bank(uBank2, uGeo[2], uOff[2], uWarp[2], p, disp, thin);
  gl_FragColor = c2 + c * (1.0 - c2.a);
}`;

/** Share of the stir a layer takes: `push` scales drag, push and swirl; `thin` scales thinning. Nearer layers take more. */
export type Layer = { push: number; thin: number };
export type BankState = { shift: number; y: number };
/** Per-frame input: layer positions for each set, and the stir patches shared by all sets. */
export type SkyFrame = { time: number; sets: BankState[][]; splatA: Float32Array; splatB: Float32Array; splats: number };

export type SkyGL = {
  /** Stir patches the shader supports on this GPU (0 to MAX_SPLATS). */
  splats: number;
  resize(w: number, h: number, dpr: number): void;
  /** Sets the three cloud layers of `set`. Later sets draw over earlier ones. */
  setBanks(banks: BakedBank[], set?: number): void;
  draw(f: SkyFrame): void;
  dispose(): void;
};

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    console.warn("sky shader:", gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}

function program(gl: WebGLRenderingContext, frag: string) {
  const v = compile(gl, gl.VERTEX_SHADER, VERT);
  const f = compile(gl, gl.FRAGMENT_SHADER, frag);
  const p = gl.createProgram();
  if (!v || !f || !p) return null;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.bindAttribLocation(p, 0, "aPos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    console.warn("sky program:", gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

/** Creates the cloud renderer on `canvas`. `sets` gives each layer's stir shares; all sets share the same stir. */
export function createSkyGL(canvas: HTMLCanvasElement, sets: Layer[][] = [BANKS]): SkyGL | null {
  try {
    return create(canvas, sets);
  } catch (e) {
    // This runs on the page's first render, so a throw would break the whole page.
    console.warn("sky:", e);
    return null;
  }
}

function create(canvas: HTMLCanvasElement, sets: Layer[][]): SkyGL | null {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    // Decorative, so prefer no WebGL over software-rendered WebGL.
    failIfMajorPerformanceCaveat: true,
  });
  if (!gl) return null;
  // A fake context lacks methods used later, which would throw mid-draw.
  if (typeof WebGLRenderingContext === "undefined" || !(gl instanceof WebGLRenderingContext)) return null;
  // Sub-pixel motion across thousands of px needs highp; at mediump it steps.
  const high = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  if (!high || high.precision < 16) return null;

  let w = 1;
  let h = 1;
  // Two vec4s per patch, after about 24 for the rest of the shader. WebGL guarantees only 16, so this can be 0.
  const vectors = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) as number;
  const splats = Math.max(0, Math.min(MAX_SPLATS, Math.floor((vectors - 24) / 2)));
  let clouds: WebGLProgram | null = null;
  let quad: WebGLBuffer | null = null;
  const bankTex: (WebGLTexture | null)[][] = sets.map(() => []);
  const bankSrc: BakedBank[][] = sets.map(() => []);
  let lost = false;
  const loc: Record<string, WebGLUniformLocation | null> = {};
  const geo = new Float32Array(12);
  const off = new Float32Array(12);
  const warps = sets.map(() => new Float32Array(12));
  const verts = new Float32Array(12);

  function texture(src: HTMLCanvasElement, unit: number) {
    const t = gl!.createTexture();
    gl!.activeTexture(gl!.TEXTURE0 + unit);
    gl!.bindTexture(gl!.TEXTURE_2D, t);
    gl!.pixelStorei(gl!.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, src);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    return t;
  }

  function uploadBanks(set: number) {
    for (const t of bankTex[set]) if (t) gl!.deleteTexture(t);
    bankTex[set] = bankSrc[set].map((b, i) => texture(b.canvas, 1 + i));
    bankSrc[set].forEach((b, i) => {
      // An integer number of waves per tile, so the warp is seamless where the strip wraps.
      const kx = (period: number) => (Math.PI * 2 * Math.max(1, Math.round(b.tileW / period))) / b.tileW;
      warps[set].set([i * 2.3 + 0.4 + set * 5.1, kx(760), kx(240), 0], i * 4);
    });
  }

  function init() {
    clouds = program(gl!, cloudShader(splats));
    quad = gl!.createBuffer();
    if (!clouds || !quad) return false;
    for (const n of ["uSize", "uTime", "uBank0", "uBank1", "uBank2", "uGeo", "uOff", "uWarp", "uSplatA", "uSplatB", "uSplats"]) loc[`c.${n}`] = gl!.getUniformLocation(clouds, n);
    gl!.useProgram(clouds);
    gl!.uniform1i(loc["c.uBank0"], 1);
    gl!.uniform1i(loc["c.uBank1"], 2);
    gl!.uniform1i(loc["c.uBank2"], 3);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, quad);
    gl!.bufferData(gl!.ARRAY_BUFFER, verts.byteLength, gl!.DYNAMIC_DRAW);
    gl!.enableVertexAttribArray(0);
    gl!.vertexAttribPointer(0, 2, gl!.FLOAT, false, 0, 0);
    gl!.enable(gl!.BLEND);
    // Premultiplied-alpha "over" blending.
    gl!.blendFunc(gl!.ONE, gl!.ONE_MINUS_SRC_ALPHA);
    gl!.clearColor(0, 0, 0, 0);
    sets.forEach((_, i) => uploadBanks(i));
    return true;
  }

  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
  };
  const onRestored = () => {
    lost = !init();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  if (!init()) return null;

  /** Two triangles covering a box, in scene px, at `at` in the vertex array. */
  function box(at: number, x0: number, y0: number, x1: number, y1: number) {
    verts.set([x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1], at);
  }

  /** WebGL reports errors instead of throwing, so a throw means it can't draw. Stop the sky rather than the page. */
  function safely(step: () => void) {
    try {
      step();
    } catch (e) {
      lost = true;
      console.warn("sky:", e);
    }
  }

  return {
    splats,
    resize(nw, nh, dpr) {
      w = nw;
      h = nh;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
    },
    setBanks(banks, set = 0) {
      bankSrc[set] = banks;
      if (!lost) safely(() => uploadBanks(set));
    },
    draw(f) {
      if (lost || gl.isContextLost()) return;
      safely(() => {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        // Draw each set in order, later over earlier.
        sets.forEach((layers, set) => {
          const src = bankSrc[set];
          const tex = bankTex[set];
          if (tex.length !== layers.length || !tex.every(Boolean)) return;
          const states = f.sets[set] ?? [];
          src.forEach((b, i) => {
            const st = states[i] ?? { shift: 0, y: 0 };
            geo.set([st.shift, b.tileW, b.top, b.height], i * 4);
            off.set([0, st.y, layers[i].push, layers[i].thin], i * 4);
            gl.activeTexture(gl.TEXTURE1 + i);
            gl.bindTexture(gl.TEXTURE_2D, tex[i]);
          });
          // Bounding box of the set's strips, padded by how far a stir can displace a cloud.
          const top = Math.max(0, Math.min(...src.map((b, i) => b.top + (states[i]?.y ?? 0))) - 200);
          const bottom = Math.min(h, Math.max(...src.map((b, i) => b.top + b.height + (states[i]?.y ?? 0))) + 200);
          if (bottom <= top) return;
          box(0, 0, top, w, bottom);
          gl.bindBuffer(gl.ARRAY_BUFFER, quad);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts);
          gl.useProgram(clouds);
          gl.uniform2f(loc["c.uSize"], w, h);
          gl.uniform1f(loc["c.uTime"], f.time);
          gl.uniform4fv(loc["c.uGeo"], geo);
          gl.uniform4fv(loc["c.uOff"], off);
          gl.uniform4fv(loc["c.uWarp"], warps[set]);
          if (splats) {
            // Must match the array size the shader declares.
            gl.uniform4fv(loc["c.uSplatA"], f.splatA.subarray(0, splats * 4));
            gl.uniform4fv(loc["c.uSplatB"], f.splatB.subarray(0, splats * 4));
            gl.uniform1i(loc["c.uSplats"], Math.min(f.splats, splats));
          }
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        });
      });
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (!gl.isContextLost()) {
        for (const t of bankTex.flat()) if (t) gl.deleteTexture(t);
        gl.deleteBuffer(quad);
        gl.deleteProgram(clouds);
      }
      // Only lose the context if the canvas left the page: React's dev double-mount reuses the canvas, and getContext
      // would then return the lost context, which renders white.
      if (!canvas.isConnected) gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
