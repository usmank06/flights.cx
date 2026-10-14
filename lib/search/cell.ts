import type { FlightBackend } from "@/lib/flights/backend";
import type { Itinerary } from "@/lib/flights/types";
import { AIRPORTS } from "@/lib/airports";
import type { FlightPlan, SearchRequest } from "@/lib/types";
import { airportsOf, asker, faresAsker, resolveEndpoint, type Endpoint } from "./asking";
import { plansFromItineraries, plansFromOneWays, topPriced } from "./assemble";
import { describeInput, queryFor, type CompactRow } from "./core";

/**
 * The flights behind one grid cell or one open-search place, queried the way the search buys them (engine.ts, `buyCell`).
 * Anything unanswered by the deadline throws `Unanswered`, so partial results are not shown.
 */
export type CellAsk = {
  from: string;
  to: string;
  /** The airport the trip flies home from: `to`, unless the cell is an open-jaw. */
  backFrom: string;
  outDate: string;
  returnDate: string | null;
  tickets: "one" | "two";
};

export async function flightsForCell(opts: {
  backend: FlightBackend;
  /** The fares-only provider asked when the live one never answers (lib/flights/provider.ts). */
  fallback?: FlightBackend | null;
  req: SearchRequest;
  ask: CellAsk;
  /** Place names the search already has, by code; the table's city otherwise. */
  names?: Record<string, string>;
  signal: AbortSignal;
  tag: string;
  log?: (line: string) => void;
}): Promise<{ plans: FlightPlan[]; rows: CompactRow[] }> {
  const { backend, req, ask, tag } = opts;
  const asking = asker({ signal: opts.signal, log: (t) => opts.log?.(t.trim()) });
  const spare = opts.fallback ? asker({ signal: opts.signal, log: (t) => opts.log?.(t.trim()), bestEffort: true }) : null;
  const fares = faresAsker({ backend, fallback: opts.fallback, ask: asking, spare, log: (t) => opts.log?.(t.trim()) });
  const { from, to, backFrom, outDate, returnDate } = ask;
  const ends = new Map<string, Endpoint>();
  await Promise.all(
    [...new Set([from, to, backFrom])].map(async (code) => ends.set(code, await resolveEndpoint(backend, asking.must, { code, name: opts.names?.[code] ?? AIRPORTS[code]?.city ?? code })))
  );
  asking.allAnswered();
  const endpointOf = (code: string) => ends.get(code)?.q ?? code;
  const shopping = (input: ReturnType<typeof queryFor>) => fares(input, describeInput(input));

  if (ask.tickets === "two" && returnDate) {
    const inputOut = queryFor(req, endpointOf(from), endpointOf(to), outDate, null);
    const inputRet = queryFor(req, endpointOf(backFrom), endpointOf(from), returnDate, null);
    const [out, back] = await Promise.all([shopping(inputOut), shopping(inputRet)]);
    asking.allAnswered();
    return plansFromOneWays(out!.itineraries, back!.itineraries, inputOut, inputRet, req, `${tag}-two`);
  }

  const jaw = backFrom !== to;
  const inputs = airportsOf(from, ends.get(from)).flatMap((f) => (jaw ? [to] : airportsOf(to, ends.get(to))).map((t) => queryFor(req, f, t, outDate, returnDate, "", jaw ? backFrom : undefined)));
  const answers = await Promise.all(inputs.map(shopping));
  asking.allAnswered();
  const itins: Itinerary[] = answers.flatMap((a) => a!.itineraries);

  // Fetch the return half of each shown round-trip fare, as the search does for its plans. If the cheapest return still costs
  // more than the fare after a second ask, the return is left to the booking page. Open-jaw fares are skipped.
  const returns = new Map<number, Itinerary>();
  if (returnDate && !jaw && (backend.returns || opts.fallback?.returns)) {
    await Promise.all(
      topPriced(itins).map(async (id) => {
        const itin = itins[id];
        const input = queryFor(req, itin.from, itin.to, outDate, returnDate);
        const via = opts.fallback && itin.provider === opts.fallback.name ? opts.fallback : backend;
        if (!via.returns) return;
        const returnsOf = () => asking.must((o) => via.returns!(input, { segments: itin.segments }, o), `returns for ${itin.airlineCode}`);
        const first = await returnsOf();
        if (!first) return; // unanswered, already recorded
        let priced = first.itineraries.filter((it) => it.price != null);
        const cheapest = () => Math.min(...priced.map((it) => it.price!));
        if (!priced.length || (itin.price != null && cheapest() > itin.price)) priced = [...priced, ...((await returnsOf())?.itineraries.filter((it) => it.price != null) ?? [])];
        priced.sort((a, b) => a.price! - b.price!);
        if (priced[0] && (itin.price == null || priced[0].price! <= itin.price)) returns.set(id, priced[0]);
      })
    );
    asking.allAnswered();
  }
  return plansFromItineraries(itins, inputs[0], req, `${tag}${jaw ? `-${backFrom}` : ""}`, 6, returns);
}
