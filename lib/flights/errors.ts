/** A provider call that failed. `kind` goes in the search log. */
export class FlightsError extends Error {
  constructor(
    readonly kind: "HTTP_ERROR" | "NO_PAYLOAD" | "BAD_QUERY" | "TIMEOUT",
    message: string
  ) {
    super(message);
    this.name = "FlightsError";
  }
}
