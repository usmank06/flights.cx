"use client";

import { useEffect } from "react";
import { reportClientError } from "./report-error";

/**
 * Reports errors that error boundaries miss (event handlers, unhandled rejections). Only errors from the site's own scripts
 * are sent. Extensions and third-party scripts are ignored.
 */
export function ErrorListener() {
  useEffect(() => {
    const ours = (source: string | undefined) => Boolean(source?.startsWith(location.origin));
    const onError = (e: ErrorEvent) => {
      if (ours(e.filename)) reportClientError(e.error ?? e.message, "window.onerror");
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (e.reason instanceof Error && e.reason.stack?.includes(location.origin)) reportClientError(e.reason, "unhandledrejection");
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
