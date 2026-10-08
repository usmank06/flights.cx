"use client";

import { useCallback, useState } from "react";

/** Whether an <img> failed to load. The ref also checks on mount, since `onError` misses failures before hydration. */
export function useBrokenImage() {
  const [broken, setBroken] = useState(false);
  const ref = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth === 0) setBroken(true);
  }, []);
  const onError = useCallback(() => setBroken(true), []);
  return { broken, ref, onError };
}
