/**
 * Approximate USD rates, set by hand, for totalling savings across currencies (lib/currencies.ts). Only for headline numbers, never
 * for displayed fares. A missing currency counts as zero.
 */
const USD_PER: Record<string, number> = {
  USD: 1,
  EUR: 1.16,
  GBP: 1.34,
  INR: 0.0113,
  SAR: 0.2667, // pegged at 3.75
  AED: 0.2723, // pegged at 3.6725
  JPY: 0.0067,
  CNY: 0.14,
  KRW: 0.00071,
};

export const toUsd = (amount: number, currency: string): number => amount * (USD_PER[currency.toUpperCase()] ?? 0);
