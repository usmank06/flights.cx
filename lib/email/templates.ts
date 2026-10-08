import { SITE_URL } from "@/lib/site";

/**
 * HTML and plain-text bodies for the sign-in and price alert emails. Layout uses tables and inline styles. Only some clients (Apple
 * Mail, iOS) load the web fonts; others fall back to system fonts. Text from a search is escaped.
 */

const INK = "#0f1217";
const SOFT = "#373d47";
const MUTED = "#5d636e";
const BLUE = "#1a5ae0";
const GOOD = "#0b7a44";
const WARN = "#955200";
/** Page background (globals.css --color-sky) and the card border. */
const SKY = "#e3eefd";
const EDGE = "#d4e5fc";
const WELL = "#eef4fd";
const SYSTEM = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const FONT = `'Nunito', ${SYSTEM}`;
const TITLE = `'Comfortaa', 'Nunito', ${SYSTEM}`;
const FONTS = "https://fonts.googleapis.com/css2?family=Comfortaa:wght@700&family=Nunito:wght@400;600;700&display=swap";

/**
 * Dark mode for clients that support it (Apple Mail, Outlook apps; `[data-ogsc]` targets Outlook.com). Gmail ignores this and inverts
 * colours itself, so the light palette uses pale blues that survive inversion.
 */
const DARK = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .bg { background: #0d1726 !important; }
    .card { background: #16243a !important; border-color: #24364f !important; }
    .ink { color: #edf2fa !important; }
    .soft { color: #c9d3e1 !important; }
    .muted, .muted a { color: #9aa6b8 !important; }
    .well { background: #0f1b2e !important; color: #edf2fa !important; }
    .good { color: #4cc58a !important; }
    .warn { color: #f0a54a !important; }
    .accent { color: #7aa7ff !important; }
  }
  [data-ogsc] .bg { background: #0d1726 !important; }
  [data-ogsc] .card { background: #16243a !important; border-color: #24364f !important; }
  [data-ogsc] .ink { color: #edf2fa !important; }
  [data-ogsc] .soft { color: #c9d3e1 !important; }
  [data-ogsc] .muted { color: #9aa6b8 !important; }
  [data-ogsc] .well { background: #0f1b2e !important; color: #edf2fa !important; }
`;

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Logo and wordmark as in the site header. The image's alt text is a plane, for clients that block images. */
function wordmark(): string {
  return `<a href="${SITE_URL}" style="text-decoration:none;"><img src="${SITE_URL}/email/plane.png" width="24" height="24" alt="✈" style="display:inline-block;width:24px;height:24px;border:0;vertical-align:middle;margin:0 8px 0 0;color:${BLUE};font-size:20px;line-height:24px;"><span class="ink" style="font-family:${FONT};font-size:20px;font-weight:700;letter-spacing:-0.5px;color:${INK};vertical-align:middle;">flights<span class="accent" style="color:${BLUE};">.</span><span class="soft" style="color:${SOFT};">cx</span></span></a>`;
}

/** Shared message frame. `preheader` is the preview text inboxes show beside the subject. */
export function layout({ preheader, body, footer }: { preheader: string; body: string; footer: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>flights.cx</title>
<link href="${FONTS}" rel="stylesheet">
<style>${DARK}</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${SKY};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
<table class="bg" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${SKY};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
        <tr><td style="padding:0 8px 18px 8px;">${wordmark()}</td></tr>
        <tr>
          <td class="card ink" style="background:#ffffff;border-radius:24px;padding:32px 30px;border:1px solid ${EDGE};font-family:${FONT};color:${INK};">
            ${body}
          </td>
        </tr>
        <tr>
          <td class="muted" style="padding:18px 10px 0 10px;font-family:${FONT};font-size:12.5px;line-height:1.6;color:${MUTED};">
            ${footer}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 6px 0;"><tr><td style="border-radius:999px;background:${BLUE};">
  <a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 26px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(label)}</a>
</td></tr></table>`;
}

/* -------------------------------- Sign-in -------------------------------- */

export function signInEmail(code: string): { subject: string; text: string; html: string } {
  const text =
    `Your sign-in code is ${code}.\n\n` +
    `It works for the next 10 minutes. If you didn’t ask for it, you can ignore this. ` +
    `Nobody can sign in without the code, and no account has been created.\n\n— flights.cx\n`;
  const spaced = code.split("").join("&#8202;");
  // 8px of left padding offsets the letter-spacing after the last digit, centring the code.
  const html = layout({
    preheader: `${code} is your sign-in code. It works for 10 minutes.`,
    body: `
      <p class="accent" style="margin:0 0 6px 0;font-size:15px;font-weight:600;color:${BLUE};">Sign in</p>
      <h1 class="ink" style="margin:0;font-family:${TITLE};font-size:24px;line-height:1.3;letter-spacing:-0.4px;color:${INK};">Here’s your code</h1>
      <p class="soft" style="margin:12px 0 0 0;font-size:15px;line-height:1.6;color:${SOFT};">Type it where you asked for it. It works for the next 10 minutes.</p>
      <div class="well" style="margin:24px 0 4px 0;padding:18px 0 18px 8px;border-radius:16px;background:${WELL};text-align:center;font-size:36px;font-weight:700;letter-spacing:8px;color:${INK};font-variant-numeric:tabular-nums;">${spaced}</div>
      <p class="muted" style="margin:18px 0 0 0;font-size:13.5px;line-height:1.6;color:${MUTED};">Didn’t ask for this? You can ignore it. Nobody can sign in without the code, and no account has been created.</p>`,
    footer: `You’re getting this because someone entered this address to sign in to flights.cx.`,
  });
  return { subject: `${code} is your flights.cx sign-in code`, text, html };
}

/* ------------------------------ Price alert ------------------------------ */

export function priceAlertEmail(a: {
  route: string;
  /** Which trip: "Nov 10 – 17 · 2 adults · Business". */
  trip: string;
  headline: string;
  price: string;
  delta: number;
  /** Previous price, shown struck through; null when unchanged. */
  was: string | null;
  /** "Down $235", "Up $120". */
  deltaText: string | null;
  /** "Below your $1,400 target", on a target alert. */
  targetText: string | null;
  sinceText: string | null;
  /** One line per direction: "Out: British Airways · nonstop · 7h 10m". */
  flights: string[];
  url: string;
  stopUrl: string;
}): { text: string; html: string } {
  const text =
    // The headline already includes the target.
    `${a.headline}.\n\n` +
    (a.deltaText ? `${a.deltaText}${a.was ? ` from ${a.was}` : ""}.\n` : "") +
    (a.sinceText ? `${a.sinceText}\n` : "") +
    (a.flights.length ? `\n${a.flights.join("\n")}\n` : "") +
    `\nSee the new options:\n${a.url}\n\n` +
    `Prices change daily, so check them before you book.\n\n— flights.cx\n\nStop tracking this price: ${a.stopUrl}\n`;
  const tone = a.delta > 0 ? GOOD : a.delta < 0 ? WARN : SOFT;
  const toneClass = a.delta > 0 ? "good" : a.delta < 0 ? "warn" : "soft";
  const html = layout({
    preheader: [a.trip, a.targetText ?? (a.deltaText && a.was ? `${a.deltaText} from ${a.was}` : null)].filter(Boolean).join(" · ") || a.headline,
    body: `
      <p class="accent" style="margin:0 0 6px 0;font-size:15px;font-weight:600;color:${BLUE};">Price alert</p>
      <h1 class="ink" style="margin:0;font-family:${TITLE};font-size:24px;line-height:1.3;letter-spacing:-0.4px;color:${INK};">${escapeHtml(a.route)}</h1>
      ${a.trip ? `<p class="soft" style="margin:6px 0 0 0;font-size:15px;line-height:1.5;color:${SOFT};">${escapeHtml(a.trip)}</p>` : ""}
      <p style="margin:18px 0 0 0;font-variant-numeric:tabular-nums;">
        <span class="${a.delta > 0 ? "good" : "ink"}" style="font-size:40px;font-weight:700;letter-spacing:-1px;color:${a.delta > 0 ? GOOD : INK};">${escapeHtml(a.price)}</span>
        ${a.was ? `<span class="muted" style="margin-left:8px;font-size:18px;color:${MUTED};text-decoration:line-through;">${escapeHtml(a.was)}</span>` : ""}
      </p>
      ${a.targetText ? `<p class="good" style="margin:6px 0 0 0;font-size:15px;font-weight:600;color:${GOOD};">${escapeHtml(a.targetText)}</p>` : ""}
      ${a.deltaText ? `<p class="${a.targetText ? "muted" : toneClass}" style="margin:${a.targetText ? 4 : 6}px 0 0 0;font-size:${a.targetText ? 14 : 15}px;font-weight:${a.targetText ? 400 : 600};color:${a.targetText ? MUTED : tone};">${escapeHtml(a.deltaText)}</p>` : ""}
      ${a.sinceText ? `<p class="muted" style="margin:4px 0 0 0;font-size:14px;color:${MUTED};">${escapeHtml(a.sinceText)}</p>` : ""}
      ${
        a.flights.length
          ? `<div class="well" style="margin:20px 0 0 0;padding:12px 16px;border-radius:14px;background:${WELL};">${a.flights
              .map((f, i) => `<p class="soft" style="margin:${i ? 4 : 0}px 0 0 0;font-size:14.5px;line-height:1.5;color:${SOFT};">${escapeHtml(f)}</p>`)
              .join("")}</div>`
          : ""
      }
      ${button(a.url, "See the new options")}
      <p class="muted" style="margin:14px 0 0 0;font-size:13.5px;line-height:1.6;color:${MUTED};">Prices change daily, so check them before you book.</p>`,
    footer: `You’re tracking this price on flights.cx. <a href="${escapeHtml(a.stopUrl)}" style="color:${MUTED};text-decoration:underline;">Stop tracking</a>.`,
  });
  return { text, html };
}
