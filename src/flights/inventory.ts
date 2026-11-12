import type { Tx } from "../shared/db.js";
import { conflict, notFound } from "../shared/http.js";

export interface HeldSeat {
  seat: string;
  cabin: string;
  pricePaise: number;
}

// No new holds this close to departure; check-in has effectively closed.
const CUTOFF = "1 hour";

/**
 * Holds every requested seat for one booking, or none of them.
 *
 * The seats are locked in a fixed order first. Two bookings asking for
 * {1A, 1B} and {1B, 1A} would otherwise lock in opposite orders and deadlock.
 * After the lock, the UPDATE only touches seats that are free, whose hold has
 * run out, or that this booking already holds (a retried request). If fewer
 * rows come back than were asked for, the transaction rolls back.
 */
export async function hold(c: Tx, bookingId: string, flightId: string, seats: string[], holdSeconds: number) {
  const flight = await c.query(
    `SELECT number, origin, destination, departs_at, arrives_at, status,
            departs_at > now() + interval '${CUTOFF}' AS open
     FROM flights WHERE id = $1 FOR SHARE`,
    [flightId],
  );
  const f = flight.rows[0];
  if (!f) throw notFound("No such flight");
  if (f.status !== "scheduled") throw conflict("flight_cancelled", "This flight has been cancelled");
  if (!f.open) throw conflict("flight_closed", "Booking has closed for this flight");

  const locked = await c.query<{ seat_no: string }>(
    "SELECT seat_no FROM seats WHERE flight_id = $1 AND seat_no = ANY($2) ORDER BY seat_no FOR UPDATE",
    [flightId, seats],
  );
  const unknown = seats.filter((s) => !locked.rows.some((r) => r.seat_no === s));
  if (unknown.length) throw conflict("unknown_seats", "Some seats do not exist on this aircraft", { seats: unknown });

  const { rows } = await c.query<{ seat_no: string; cabin: string; price_paise: number; held_until: Date }>(
    `UPDATE seats
     SET status = 'held', booking_id = $1, held_until = now() + make_interval(secs => $4)
     WHERE flight_id = $2 AND seat_no = ANY($3)
       AND (status = 'free'
            OR (status = 'held' AND (held_until < now() OR booking_id = $1)))
     RETURNING seat_no, cabin, price_paise, held_until`,
    [bookingId, flightId, seats, holdSeconds],
  );
  if (rows.length !== seats.length) {
    const got = new Set(rows.map((r) => r.seat_no));
    // Throwing rolls back the seats we did manage to grab.
    throw conflict("seats_taken", "Some seats were just taken", { seats: seats.filter((s) => !got.has(s)) });
  }

  return {
    heldUntil: rows[0]!.held_until,
    seats: rows.map<HeldSeat>((r) => ({ seat: r.seat_no, cabin: r.cabin, pricePaise: r.price_paise })),
    flight: {
      number: f.number as string,
      origin: f.origin as string,
      destination: f.destination as string,
      departsAt: f.departs_at as Date,
      arrivesAt: f.arrives_at as Date,
    },
  };
}

/**
 * Turns a hold into a sale. Succeeds again if it already succeeded, so the
 * booking service can retry after a timeout without double-booking anything.
 * A hold that ran out still confirms as long as nobody else took the seat.
 */
export async function confirm(c: Tx, bookingId: string, flightId: string, seats: string[]) {
  const flight = await c.query("SELECT status FROM flights WHERE id = $1 FOR SHARE", [flightId]);
  if (!flight.rows[0]) throw notFound("No such flight");
  if (flight.rows[0].status !== "scheduled") throw conflict("flight_cancelled", "This flight has been cancelled");

  const { rowCount } = await c.query(
    `UPDATE seats SET status = 'booked', held_until = NULL
     WHERE flight_id = $1 AND seat_no = ANY($2) AND booking_id = $3`,
    [flightId, seats, bookingId],
  );
  if (rowCount !== seats.length) {
    throw conflict("hold_lost", "The hold ran out and the seats went to someone else");
  }
}

export async function release(c: Tx, bookingId: string): Promise<number> {
  const { rowCount } = await c.query(
    "UPDATE seats SET status = 'free', booking_id = NULL, held_until = NULL WHERE booking_id = $1",
    [bookingId],
  );
  return rowCount ?? 0;
}
