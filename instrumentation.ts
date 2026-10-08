import type { Instrumentation } from "next";

/**
 * Sends server errors caught by Next.js (route handlers, server rendering, proxy.ts) to the error log (lib/errors.ts), keyed by
 * route so one failing route is one row. Node runtime only, since the log writes to Postgres.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportError } = await import("./lib/errors");
  const digest = typeof error === "object" && error && "digest" in error ? String(error.digest) : null;
  await reportError("server", error, {
    where: `${context.routeType} ${context.routePath}`,
    detail: { method: request.method, path: request.path.split("?")[0].slice(0, 200), digest },
  });
};
