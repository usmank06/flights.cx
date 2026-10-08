import type { MetadataRoute } from "next";

/** Manifest for "Add to Home Screen". White to match the top of the home page (app/page.tsx). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "flights.cx",
    short_name: "flights.cx",
    description: "Tell it the trip in your own words. It finds the best few ways to fly, and says why.",
    start_url: "/",
    display: "browser",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
