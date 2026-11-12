export interface Hold {
  heldUntil: string;
  seats: { seat: string; cabin: string; pricePaise: number }[];
  flight: { number: string; origin: string; destination: string; departsAt: string; arrivesAt: string };
}

/** Flights answered and said no. Retrying will not change the answer. */
export class FlightsRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** We could not get an answer. The call may or may not have taken effect. */
export class FlightsUnavailable extends Error {}

export interface FlightsClient {
  hold(bookingId: string, flightId: string, seats: string[], holdSeconds: number): Promise<Hold>;
  confirm(bookingId: string, flightId: string, seats: string[]): Promise<void>;
}

export function httpFlightsClient(baseUrl: string, internalToken: string, timeoutMs = 3000): FlightsClient {
  async function call(path: string, body: object) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": internalToken },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new FlightsUnavailable(`flights unreachable: ${(err as Error).message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (res.status >= 500) throw new FlightsUnavailable(`flights returned ${res.status}`);
    if (!res.ok) throw new FlightsRefused(res.status, data.error ?? "refused", data.message ?? "", data.details);
    return data;
  }

  return {
    hold: (bookingId, flightId, seats, holdSeconds) =>
      call("/internal/holds", { bookingId, flightId, seats, holdSeconds }),
    confirm: async (bookingId, flightId, seats) => {
      await call(`/internal/holds/${bookingId}/confirm`, { flightId, seats });
    },
  };
}
