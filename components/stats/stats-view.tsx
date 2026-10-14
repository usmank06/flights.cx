"use client";

import { useMemo, useState, type ReactNode } from "react";
import { cx } from "@/components/ui/primitives";

/** One calendar day's counts, summed over every trip shape. */
export type Day = { day: string; searches: number; completed: number; failed: number; durationMs: number; costUsd: number };

const RANGES = [
  { key: "7", label: "7 days", days: 7 },
  { key: "30", label: "30 days", days: 30 },
  { key: "all", label: "All", days: 0 },
] as const;

const W = 420;
const H = 170;
const PAD = { l: 34, r: 10, t: 10, b: 24 };

/** Tick values up to a round number above `max`: four or five of them. */
function ticks(max: number): number[] {
  const m = Math.max(1, max);
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000].find((s) => m / s <= 4) ?? Math.ceil(m / 4);
  const top = Math.ceil(m / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top; v += step) out.push(v);
  return out;
}

const label = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fmt = (n: number, digits = 0) => n.toLocaleString("en-US", { maximumFractionDigits: digits });

/** The frame every chart shares: a faint grid, tick labels on the left, day labels along the bottom. */
function Frame({ rows, max, unit, children }: { rows: Day[]; max: number; unit: string; children: (y: (v: number) => number, x: (i: number) => number, slot: number) => ReactNode }) {
  const t = ticks(max);
  const top = t[t.length - 1];
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / top);
  const slot = (W - PAD.l - PAD.r) / rows.length;
  const x = (i: number) => PAD.l + i * slot;
  const every = rows.length > 10 ? Math.ceil(rows.length / 6) : 1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" aria-hidden>
      {t.map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="stroke-rule" strokeWidth={1} />
          <text x={PAD.l - 6} y={y(v) + 3.5} textAnchor="end" fontSize={10} className="fill-ink-faint nums">
            {fmt(v)}
            {v ? unit : ""}
          </text>
        </g>
      ))}
      {children(y, x, slot)}
      {rows.map((r, i) =>
        i % every === 0 || i === rows.length - 1 ? (
          <text key={r.day} x={x(i) + slot / 2} y={H - 7} textAnchor="middle" fontSize={10} className="fill-ink-faint">
            {label(r.day)}
          </text>
        ) : null
      )}
    </svg>
  );
}

/** Hover targets, one per day, with the day's line as a native tooltip. */
function Hits({ rows, x, slot, text }: { rows: Day[]; x: (i: number) => number; slot: number; text: (r: Day) => string }) {
  return (
    <>
      {rows.map((r, i) => (
        <rect key={r.day} x={x(i)} y={PAD.t} width={slot} height={H - PAD.t - PAD.b} fill="transparent" className="hover:fill-accent/5">
          <title>{`${label(r.day)}: ${text(r)}`}</title>
        </rect>
      ))}
    </>
  );
}

function Bars({ rows }: { rows: Day[] }) {
  return (
    <Frame rows={rows} max={Math.max(...rows.map((r) => r.searches))} unit="">
      {(y, x, slot) => {
        const w = Math.max(3, slot * 0.6);
        return (
          <>
            {rows.map((r, i) => {
              const left = x(i) + (slot - w) / 2;
              const okTop = y(r.completed);
              const badTop = y(r.completed + r.failed);
              return (
                <g key={r.day}>
                  {r.completed > 0 && <rect x={left} y={okTop} width={w} height={y(0) - okTop} rx={3} className="fill-accent" />}
                  {r.failed > 0 && <rect x={left} y={badTop} width={w} height={Math.max(0, okTop - badTop - (r.completed ? 2 : 0))} rx={r.completed ? 0 : 3} className="fill-warn" />}
                </g>
              );
            })}
            <Hits rows={rows} x={x} slot={slot} text={(r) => `${r.completed} finished, ${r.failed} stopped`} />
          </>
        );
      }}
    </Frame>
  );
}

function Line({ rows, value, unit, digits, tone }: { rows: Day[]; value: (r: Day) => number | null; unit: string; digits: number; tone: "accent" | "warn" }) {
  const vals = rows.map(value);
  const max = Math.max(0, ...vals.filter((v): v is number => v != null));
  return (
    <Frame rows={rows} max={max} unit={unit}>
      {(y, x, slot) => {
        const pts = vals.map((v, i) => (v == null ? null : ([x(i) + slot / 2, y(v)] as const)));
        let d = "";
        pts.forEach((p, i) => {
          if (p) d += `${d && pts[i - 1] ? " L" : " M"}${p[0]} ${p[1]}`;
        });
        const first = pts.find(Boolean);
        const last = [...pts].reverse().find(Boolean);
        const area = first && last ? `${d.replace(/M/g, "L").replace(/^ L/, " M")} L${last[0]} ${y(0)} L${first[0]} ${y(0)} Z` : "";
        const stroke = tone === "accent" ? "stroke-accent" : "stroke-warn";
        const fill = tone === "accent" ? "fill-accent" : "fill-warn";
        return (
          <>
            <path d={area} className={cx(fill, "opacity-10")} />
            <path d={d} fill="none" strokeWidth={2} strokeLinejoin="round" className={stroke} />
            {last && <circle cx={last[0]} cy={last[1]} r={4} className={cx(fill, "stroke-paper")} strokeWidth={2} />}
            <Hits rows={rows} x={x} slot={slot} text={(r) => (value(r) == null ? "no searches" : `${fmt(value(r)!, digits)}${unit}`)} />
          </>
        );
      }}
    </Frame>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="slip rounded-3xl px-5 py-4">
      <div className="text-[12px] font-semibold tracking-[0.06em] text-ink-faint uppercase">{label}</div>
      <div className="display nums mt-1 text-[28px] leading-none font-semibold text-ink">{value}</div>
    </div>
  );
}

function Chart({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="slip rounded-3xl px-5 pt-4 pb-3">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** The day-by-day counts: four tiles and four charts over the chosen range. */
export function StatsView({ days }: { days: Day[] }) {
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("30");
  const rows = useMemo(() => {
    const n = RANGES.find((r) => r.key === range)!.days;
    return n ? days.slice(-n) : days;
  }, [days, range]);
  const total = rows.reduce((s, r) => s + r.searches, 0);
  const ok = rows.reduce((s, r) => s + r.completed, 0);
  const secs = rows.reduce((s, r) => s + r.durationMs, 0) / 1000;
  const usd = rows.reduce((s, r) => s + r.costUsd, 0);
  return (
    <div className="mt-6 flex flex-col gap-4 sm:mt-8">
      <div className="flex gap-1.5" role="group" aria-label="Days shown">
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => setRange(r.key)}
            aria-pressed={range === r.key}
            className={cx("press h-9 rounded-full px-4 text-[13.5px] font-semibold", range === r.key ? "bg-accent text-white" : "float text-ink-soft hover:text-ink")}
          >
            {r.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Searches" value={fmt(total)} />
        <Tile label="Finished" value={total ? `${Math.round((ok / total) * 100)}%` : "–"} />
        <Tile label="Seconds each" value={ok ? fmt(secs / ok) : "–"} />
        <Tile label="Cents each" value={total ? fmt((usd / total) * 100, 1) : "–"} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Chart title="Searches a day">
          <p className="flex gap-4 text-[12.5px] text-ink-muted">
            <span className="flex items-center gap-1.5">
              <i className="inline-block h-2.5 w-2.5 rounded-[3px] bg-accent" />
              finished
            </span>
            <span className="flex items-center gap-1.5">
              <i className="inline-block h-2.5 w-2.5 rounded-[3px] bg-warn" />
              stopped
            </span>
          </p>
          <Bars rows={rows} />
        </Chart>
        <Chart title="Stopped">
          <p className="text-[12.5px] text-ink-muted">share of the day’s searches</p>
          <Line rows={rows} value={(r) => (r.searches ? (r.failed / r.searches) * 100 : null)} unit="%" digits={0} tone="warn" />
        </Chart>
        <Chart title="Seconds a search">
          <p className="text-[12.5px] text-ink-muted">average, question to plans</p>
          <Line rows={rows} value={(r) => (r.completed ? r.durationMs / 1000 / r.completed : null)} unit="s" digits={0} tone="accent" />
        </Chart>
        <Chart title="Cents a search">
          <p className="text-[12.5px] text-ink-muted">model calls only</p>
          <Line rows={rows} value={(r) => (r.searches ? (r.costUsd / r.searches) * 100 : null)} unit="¢" digits={1} tone="accent" />
        </Chart>
      </div>
    </div>
  );
}
