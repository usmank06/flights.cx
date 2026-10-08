import type { Viewport } from "next";
import { Home } from "@/components/home/home";

// White to match the clouds at the top of the first screen. components/site/theme-color.tsx switches to sky after it.
export const viewport: Viewport = { themeColor: "#ffffff" };

/** Home page: the search, asked as a conversation. */
export default function Page() {
  return <Home />;
}
