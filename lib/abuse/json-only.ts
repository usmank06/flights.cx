/**
 * Refuses a body that isn't `application/json` (415). A cross-site form can post `text/plain` without a preflight, which would allow
 * login CSRF and searches started from other sites. A cross-origin JSON post needs a CORS preflight, which this app never answers.
 */
export function notJson(headers: Headers): Response | null {
  const type = headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  return type === "application/json" ? null : Response.json({ error: "Expected JSON." }, { status: 415 });
}

/** Reads a JSON body up to `maxBytes`, answering 413 as soon as it goes over. `body` is null when it isn't valid JSON. */
export async function jsonUpTo(req: Request, maxBytes: number): Promise<{ body: unknown } | Response> {
  const tooBig = () => Response.json({ error: "That's more than this takes." }, { status: 413 });
  if (Number(req.headers.get("content-length")) > maxBytes) return tooBig();
  const reader = req.body?.getReader();
  if (!reader) return { body: null };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return tooBig();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { body: null };
  }
}
