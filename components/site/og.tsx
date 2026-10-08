/**
 * Link preview cards rendered by next/og (Satori): a site card and a per-search card. Satori supports only a subset of CSS, so
 * every box is flex and every style is inline.
 */
export const OG_SIZE = { width: 1200, height: 630 };

const INK = "#0f1217";
const MUTED = "#5d636e";
const BLUE = "#1a5ae0";

/**
 * Body (Nunito) and title (Comfortaa) fonts, matching the site. Satori only draws fonts it is given, so they're fetched from
 * Google Fonts once per process. If the fetch fails, the cards use next/og's default font.
 */
const FACE = "Nunito";
const TITLE = "Comfortaa";
type OgFont = { name: string; data: ArrayBuffer; weight: 400 | 600; style: "normal" };
let fonts: Promise<OgFont[]> | null = null;

export function ogFonts(): Promise<OgFont[]> {
  fonts ??= (async () => {
    const css = await fetch(`https://fonts.googleapis.com/css2?family=${FACE}:wght@400;600&family=${TITLE}:wght@600`, {
      // An old Safari user agent gets TrueType, which Satori can read. Modern browsers get WOFF2, which it can't.
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1" },
      signal: AbortSignal.timeout(4_000),
    }).then((r) => r.text());
    const faces = css.split("@font-face").flatMap((block) => {
      const family = block.match(/font-family:\s*'([^']+)'/)?.[1];
      const weight = block.match(/font-weight:\s*(\d+)/)?.[1];
      const url = block.match(/src:\s*url\(([^)]+)\)\s*format\('truetype'\)/)?.[1];
      return family && weight && url ? [{ family, weight: Number(weight) as 400 | 600, url }] : [];
    });
    const out = await Promise.all(
      faces.map(async ({ family, weight, url }) => ({
        name: family,
        data: await fetch(url, { signal: AbortSignal.timeout(4_000) }).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`font ${r.status}`)))),
        weight,
        style: "normal" as const,
      }))
    );
    if (out.length !== 3) throw new Error(`expected three faces, got ${out.length}`);
    return out;
  })().catch((e) => {
    console.warn(`[og] could not load ${FACE} and ${TITLE} (${(e as Error).message}) — drawing in next/og's own face`);
    fonts = null;
    return [];
  });
  return fonts;
}

/**
 * Whether Satori can draw the text. It can't join Arabic letters or order right-to-left text, draws direction marks as boxes,
 * and has no full-width yen. Callers render such cards in English, in the same currency.
 */
export const drawable = (text: string) => !/[֐-ࣿיִ-﷿ﹰ-﻿؜‎‏‪-‮⁦-⁩＀-￯]/.test(text);

/** The wordmark, matching globals.css `.wordmark`. */
function Wordmark({ size = 34 }: { size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", fontSize: size, fontWeight: 600, letterSpacing: -size * 0.03, lineHeight: 1, color: INK }}>
      <div style={{ display: "flex" }}>flights</div>
      {/* In Satori 0.02em draws the same gap as the stylesheet's 0.07em on the page (`.wordmark-dot`). */}
      <div style={{ display: "flex", width: size * 0.205, height: size * 0.205, borderRadius: 999, background: BLUE, margin: `0 ${size * 0.06}px 0 ${size * 0.02}px` }} />
      <div style={{ display: "flex", color: MUTED }}>cx</div>
    </div>
  );
}

/** Dotted route line. Satori has no dotted borders, so each dot is its own box. */
function Route({ width = 360 }: { width?: number }) {
  const dots = Math.max(3, Math.floor((width - 22 - 26 - 28) / 13));
  return (
    <div style={{ display: "flex", alignItems: "center", width }}>
      <div style={{ display: "flex", width: 22, height: 22, borderRadius: 999, border: "4px solid #a3a8b1", background: "#fff" }} />
      <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "space-between", margin: "0 14px" }}>
        {Array.from({ length: dots }, (_, i) => (
          <div key={i} style={{ display: "flex", width: 5, height: 5, borderRadius: 999, background: "#aab6c8" }} />
        ))}
      </div>
      <div style={{ display: "flex", width: 26, height: 26, borderRadius: 999, background: BLUE, boxShadow: "0 0 0 10px rgba(26,90,224,0.14)" }} />
    </div>
  );
}

/** Card background with the wordmark on top. Content is centred so a square crop keeps all of it. */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        width: "100%",
        height: "100%",
        padding: "52px 72px",
        background: "linear-gradient(180deg, #bcd6f7 0%, #dbe9fc 45%, #f4f8ff 100%)",
        fontFamily: FACE,
        color: INK,
      }}
    >
      <Wordmark />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, justifyContent: "center" }}>{children}</div>
    </div>
  );
}

/** Title style matching globals.css `.display`. */
const title = (size: number) => ({ display: "flex", fontFamily: TITLE, fontSize: size, fontWeight: 600, letterSpacing: -size * 0.02, lineHeight: 1 }) as const;

/** Card for a search that can't be found. The home page uses a screenshot instead (scripts/og-image.mjs). */
export function SiteCard() {
  return (
    <Frame>
      <div style={title(92)}>Where to next?</div>
      <div style={{ display: "flex", marginTop: 28, fontSize: 34, color: MUTED, maxWidth: 820, lineHeight: 1.3, textAlign: "center" }}>
        Tell it the trip in your own words. It finds the best few ways to fly, and says why.
      </div>
      <div style={{ display: "flex", marginTop: 44 }}>
        <Route width={360} />
      </div>
    </Frame>
  );
}

/** Card for a search: route, dates and price. */
export function SearchCard({ from, to, fromName, toName, when, price }: { from: string; to: string; fromName: string; toName: string; when: string; price: string | null }) {
  // Multi-airport codes ("LIS/OPO") get a smaller font and a shorter route so both ends fit.
  // An open destination has no code, so its name takes the code's place.
  const long = Math.max(from.length, to.length) > 3 || !to;
  const code = title(long ? 72 : 96);
  const name = { display: "block", marginTop: 14, fontSize: 30, color: MUTED, maxWidth: 360, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
  return (
    <Frame>
      <div style={{ display: "flex", alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <div style={code}>{from}</div>
          <div style={name}>{fromName}</div>
        </div>
        <div style={{ display: "flex", margin: "0 34px", marginBottom: 44 }}>
          <Route width={long ? 170 : 230} />
        </div>
        {to ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <div style={code}>{to}</div>
            <div style={{ ...name, textAlign: "right" }}>{toName}</div>
          </div>
        ) : (
          <div style={{ ...title(52), maxWidth: 420, marginBottom: 44, lineHeight: 1.1 }}>{toName}</div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", marginTop: 52, gap: 24 }}>
        {when && <div style={{ display: "flex", fontSize: 34, color: INK }}>{when}</div>}
        {price && (
          <div style={{ display: "flex", padding: "12px 26px", borderRadius: 999, background: BLUE, color: "#fff", fontSize: 34, fontWeight: 600 }}>
            from {price}
          </div>
        )}
      </div>
    </Frame>
  );
}
