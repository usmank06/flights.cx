# flights.cx

Describe a trip in your own words, like "somewhere warm in March" or "Chicago to Lisbon, back before the 20th". It asks a
few follow-up questions, prices dozens of date and airport combinations, and shows the best few ways to fly. Each option
comes with a short note on what makes it different, a date grid and a Book button. You can ask follow-up questions about
the results, or watch a price and get an email when it drops.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

This version doesn't include a live flight data provider. Every search runs on a demo market with made-up fares (marked
"Demo data" on the page), so it works offline with no setup. To have real models read the trip, pick the options and write
the notes, copy `.env.example` to `.env` and set `OPENROUTER_API_KEY`. Without it, a simple stand-in planner reads the
form instead.

Without `DATABASE_URL`, searches are saved as JSON files in `.data/`. The rest of `.env.example` (database, email,
reCAPTCHA) is for production.

## Adding real flight data

The app talks to flights through one interface, `FlightBackend` in `lib/flights/backend.ts`. To use a real provider:

1. Implement `FlightBackend` against a flight data API, parsing its answers into the types in `lib/flights/types.ts`.
2. Return it from `liveBackend()` in `lib/flights/provider.ts`, and build its booking links in `bookingFor()`.
3. Add any settings it needs in production, and the hosts its images come from, to `lib/flights/provider-config.ts`.

The model prompts in `lib/search/prompts.ts` are shortened placeholders. They work, but you'll get better results by
writing your own.

## How a search works

1. **Plan.** A model turns the conversation into a trip plan: places, a window of dates, travellers and bags.
2. **Price.** The engine prices the exact trip, then nearby dates and airports, as one ticket or two.
3. **Pick.** A decision model chooses the best options by id. All price arithmetic is done in code.
4. **Write.** A short model call explains the trade-offs. Any reply that invents a number is thrown away.

## Project layout

| Path | What's there |
| --- | --- |
| `app/` | Pages and API routes |
| `components/` | React UI |
| `lib/search/` | The search engine, the planner, the demo market and the model calls |
| `lib/flights/` | Flight data types and the provider interface |
| `lib/intake/` | The questions asked before a search |
| `scripts/` | Generators for the map data and the link preview image |

## Checks

```bash
npm run typecheck
npm run lint
```

## Deploying

It's a single Next.js app on Vercel. A production build fails if a required setting is missing (see `lib/env.ts`), so the
previous deployment stays live. Keep secrets in `.env` and never commit them.
