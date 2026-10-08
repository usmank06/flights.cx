"use client";

import { useEffect, useRef } from "react";
import { BANKS, bakeBank } from "@/components/home/clouds";
import { cx } from "@/components/ui/primitives";

/**
 * Sky band at the top of inner pages, with the landing's cloud banks (components/home/clouds.ts) drawn once onto a static canvas.
 * The sky itself is CSS (globals.css `.cloud-band`), so it shows before the script runs. The clouds fade in over it.
 * The parent must be `relative isolate`. `className` sets the band's height.
 */
export function CloudBand({ className }: { className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = box.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    let drawn = "";
    const draw = () => {
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      // Lay out the banks for a landing screen of this window's height, clamped to 640-1000px.
      const H = Math.max(640, Math.min(1000, window.innerHeight));
      const key = `${w}×${h}×${H}`;
      if (!w || !h || key === drawn) return;
      drawn = key;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      const g = cv.getContext("2d");
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      // Sink the banks as the landing does (scene.tsx), with the band's bottom edge standing in for the screen's.
      const sink = Math.min(110, H * 0.12);
      BANKS.forEach((b, i) => {
        const baked = bakeBank(b, w, H, H + 40);
        const y = baked.top + sink - (H - h);
        const shift = (baked.tileW * (0.37 + i * 0.23)) % baked.tileW;
        for (let x = -shift; x < w; x += baked.tileW) g.drawImage(baked.canvas, x, y, baked.tileW, baked.height);
      });
      cv.dataset.ready = "";
    };
    draw();
    const seen = new ResizeObserver(draw);
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  return (
    <div ref={box} aria-hidden className={cx("cloud-band pointer-events-none absolute inset-x-0 top-0 -z-10 overflow-hidden", className)}>
      <canvas ref={canvas} className="absolute inset-0 h-full w-full opacity-0 transition-opacity duration-700 data-[ready]:opacity-100" />
    </div>
  );
}
