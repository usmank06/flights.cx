"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/** Browser theme colours: white for the home page's first screen, the sky band's blue (layout.tsx) everywhere else. */
const CLOUD = "#ffffff";
const SKY = "#c2d9fb";

/**
 * Switches the home page's theme-color between the landing screen (white, also set by app/page.tsx so it's right before any
 * script runs) and the conversation (sky). The landing screen marks itself with `data-landing`.
 */
export function ThemeColor() {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname !== "/") return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) return;
    const sync = () => {
      const want = document.querySelector("[data-landing]") ? CLOUD : SKY;
      if (meta.content !== want) meta.content = want;
    };
    sync();
    const watch = new MutationObserver(sync);
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-landing"] });
    return () => watch.disconnect();
  }, [pathname]);
  return null;
}
