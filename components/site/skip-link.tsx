"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/** "Skip to content" link. Pages render their own <main>, so this gives it an id on each navigation. */
export function SkipLink() {
  const pathname = usePathname();
  useEffect(() => {
    const main = document.querySelector("main");
    if (main && !main.id) main.id = "main";
  }, [pathname]);
  return (
    <a
      href="#main"
      onClick={(e) => {
        const main = document.querySelector("main");
        if (!main) return;
        e.preventDefault();
        if (!main.hasAttribute("tabindex")) main.tabIndex = -1;
        main.focus();
        main.scrollIntoView({ block: "start" });
      }}
      className="btn-primary sr-only rounded-full text-[15px] font-semibold focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:inline-flex focus:h-11 focus:items-center focus:px-5"
    >
      Skip to content
    </a>
  );
}
