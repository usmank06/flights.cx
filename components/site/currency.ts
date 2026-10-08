"use client";

import { useSyncExternalStore } from "react";
import { CURRENCIES as LIST, currencyForCountry, isSupportedCurrency } from "@/lib/currencies";

/**
 * The browser's currency: the user's pick (localStorage), else the IP's country (/api/where, asked once per browser), else the
 * browser language's region, else USD. The server snapshot is the default, and React reconciles after hydration.
 */
const KEY = "flights.currency.v1";
/** Country from the IP lookup, cached so it runs once per browser. "" when the lookup found none. */
const COUNTRY_KEY = "flights.country.v1";
const DEFAULT = "USD";
const listeners = new Set<() => void>();

const get = (k: string): string | null => {
  try {
    return window.localStorage.getItem(k);
  } catch {
    return null;
  }
};
const put = (k: string, v: string) => {
  try {
    window.localStorage.setItem(k, v);
  } catch {
    /* Storage unavailable (private mode): the choice lasts until reload. */
  }
};

/** Region from the browser's language tags ("en-GB" → "GB"), used when the IP lookup gave none. */
function languageCountry(): string | null {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const region = tag?.split("-")[1];
    if (region && /^[A-Za-z]{2}$/.test(region)) return region.toUpperCase();
  }
  return null;
}

function read(): string {
  const chosen = get(KEY);
  if (chosen && isSupportedCurrency(chosen)) return chosen.toUpperCase();
  return currencyForCountry(get(COUNTRY_KEY)) ?? currencyForCountry(languageCountry()) ?? DEFAULT;
}

let asked = false;
/** Asks the server where the visitor is, once per browser, unless they have already picked a currency. */
function locate() {
  if (asked) return;
  asked = true;
  if (get(KEY) || get(COUNTRY_KEY) != null) return;
  fetch("/api/where", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { country?: string | null } | null) => {
      if (!d) return;
      put(COUNTRY_KEY, d.country ?? "");
      for (const l of listeners) l();
    })
    .catch(() => {});
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  window.addEventListener("storage", fn);
  locate();
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", fn);
  };
}

export function useCurrency(): string {
  return useSyncExternalStore(subscribe, read, () => DEFAULT);
}

export function setCurrency(code: string): void {
  put(KEY, code.toUpperCase());
  for (const l of listeners) l();
}

export const CURRENCIES = LIST;
