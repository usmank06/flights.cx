/** Geometry for the home page map: land decoding and great-circle maths. Angles in degrees, distances in metres. */

/** Earth's radius, metres. */
const R = 6371000;

export type Topology = {
  transform: { scale: [number, number]; translate: [number, number] };
  arcs: [number, number][][];
  objects: { land: { geometries: { type: "Polygon" | "MultiPolygon"; arcs: number[][] | number[][][] }[] } };
};

/**
 * Decodes Natural Earth land (public/land-110m.json) into [lon, lat] rings. TopoJSON arcs are quantised and delta-encoded,
 * so decoding is a running sum scaled to degrees. Rings that cross the antimeridian (Chukotka, Fiji) are unwrapped.
 */
export function decodeLand(t: Topology): [number, number][][] {
  const [sx, sy] = t.transform.scale;
  const [tx, ty] = t.transform.translate;
  const arcs = t.arcs.map((a) => {
    let x = 0;
    let y = 0;
    return a.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty] as [number, number];
    });
  });
  // A negative index `~i` is arc `i` walked backwards. Consecutive arcs share their joining point, so it is added once.
  const ring = (idx: number[]) => {
    const pts: [number, number][] = [];
    for (const i of idx) {
      const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
      for (let k = pts.length ? 1 : 0; k < a.length; k++) pts.push(a[k]);
    }
    // A jump of more than 180° is an antimeridian crossing; shift by 360° to keep the ring continuous.
    for (let k = 1; k < pts.length; k++) {
      const d = pts[k][0] - pts[k - 1][0];
      if (d > 180) pts[k] = [pts[k][0] - 360, pts[k][1]];
      else if (d < -180) pts[k] = [pts[k][0] + 360, pts[k][1]];
    }
    return pts;
  };
  const rings: [number, number][][] = [];
  for (const g of t.objects.land.geometries) {
    const polys = (g.type === "Polygon" ? [g.arcs] : g.arcs) as number[][][];
    for (const poly of polys) for (const r of poly) rings.push(ring(r));
  }
  return rings;
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function distance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = rad(lat1);
  const φ2 = rad(lat2);
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial great-circle bearing from one point toward another, degrees from north. */
export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = rad(lat1);
  const φ2 = rad(lat2);
  const dλ = rad(lon2 - lon1);
  return (deg(Math.atan2(Math.sin(dλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ))) + 360) % 360;
}

/** Destination `d` metres from (lat, lon) along the great circle on bearing `brg`. */
export function step(lat: number, lon: number, brg: number, d: number): [number, number] {
  const φ1 = rad(lat);
  const θ = rad(brg);
  const δ = d / R;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = rad(lon) + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [deg(φ2), ((deg(λ2) + 540) % 360) - 180];
}
