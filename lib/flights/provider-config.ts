/**
 * Live provider settings that load without the provider's code. next.config.ts reads them, so this file has no imports.
 * This version has no live provider (see provider.ts), so they're empty.
 */

/** Environment variables a production deployment needs for the provider. */
export const PROVIDER_REQUIREMENTS: { names: string[]; why: string }[] = [];

/** Hosts the provider's airline logos and place photos come from, added to the Content-Security-Policy. */
export const PROVIDER_IMAGE_ORIGINS: string[] = [];

/** Where airline logos come from, or null to show the airline code instead. */
export const LOGO_ORIGIN: string | null = null;

/** A carrier's logo by IATA code. */
export const logoUrl = (code: string): string | null => (LOGO_ORIGIN ? `${LOGO_ORIGIN}/${code}.png` : null);
