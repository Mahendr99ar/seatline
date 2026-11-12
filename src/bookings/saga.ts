import { createHash, randomUUID } from "node:crypto";
import type { Claims } from "../shared/auth.js";
import { type Db, type Tx, tx } from "../shared/db.js";
import { emit } from "../shared/events.js";
import { conflict, HttpError, notFound } from "../shared/http.js";
import { type FlightsClient, FlightsRefused, FlightsUnavailable } from "./flights-client.js";
import type { PaymentMethod, PaymentProvider } from "./payments.js";

/*
 * A booking moves through these states. Every change goes through move(),
 * which only applies if the booking is still in one of the expected states,
 * so two workers racing on the same booking cannot both act on it.
 *
 *   NEW ──hold ok──> HELD ──pay──> PAYING ──seats confirmed──> CONFIRMED ──> CANCELLED
 *    │                 │             │                              └──────> CANCELLED_BY_AIRLINE
 *    │ seats taken     │ timer       ├─ card declined ──> PAYMENT_FAILED
 *    v                 v             └─ hold lost, refunded ──> FAILED
 *  REJECTED         EXPIRED
 */
export type Status =
  | "NEW"
  | "HELD"
  | "PAYING"
  | "CONFIRMED"
  | "REJECTED"
  | "EXPIRED"
  | "PAYMENT_FAILED"
  | "FAILED"
  | "CANCELLED"
  | "CANCELLED_BY_AIRLINE";

export interface Passenger {
  name: string;
  age: number;
  seat: string;
}

export interface BookingRow {
  id: string;
  user_id: string;
  contact_email: string;
  request_hash: string;
  flight_id: string;
  flight_number: string | null;
  origin: string | null;
  destination: string | null;
  departs_at: Date | null;
  passengers: (Passenger & { cabin?: string; pricePaise?: number })[];
  total_paise: number | null;
  status: Status;
  expires_at: Date | null;
  payment_method: PaymentMethod | null;
  payment_id: string | null;
  refund_id: string | null;
  failure: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Deps {
  db: Db;
  flights: FlightsClient;
  payments: PaymentProvider;
  holdSeconds: number;
  payingStaleSeconds: number;
}

/** Customers can cancel up to this long before departure. */
export const CANCEL_CUTOFF_HOURS = 3;
/** A booking stuck in NEW this long means the hold call never came back. */
const NEW_TIMEOUT = "2 minutes";

async function move(
  c: Tx | Db,
  id: string,
  from: Status[],
  to: Status,
  note: string,
  set: Partial<Record<keyof BookingRow, unknown>> = {},
  extraCondition = "",
): Promise<BookingRow | null> {
  const cols = Object.keys(set);
  const assignments = cols.map((col, i) => `, ${col} = $${i + 4}`).join("");
  const { rows } = await c.query<BookingRow>(
    `UPDATE bookings SET status = $2, updated_at = now() ${assignments}
     WHERE id = $1 AND status = ANY($3) ${extraCondition}
     RETURNING *`,
    [id, to, from, ...cols.map((col) => set[col as keyof BookingRow])],
  );
  if (rows[0]) {
    await c.query("INSERT INTO booking_history (booking_id, status, note) VALUES ($1, $2, $3)", [id, to, note]);
  }
  return rows[0] ?? null;
}

function eventFor(b: BookingRow) {
  return {
    bookingId: b.id,
    flightId: b.flight_id,
    email: b.contact_email,
    flightNumber: b.flight_number,
    origin: b.origin,
    destination: b.destination,
    departsAt: b.departs_at,
    seats: b.passengers.map((p) => p.seat),
    passengers: b.passengers.map((p) => p.name),
    totalPaise: b.total_paise,
  };
}

const releaseEvent = (b: BookingRow) => ({ bookingId: b.id, flightId: b.flight_id });

export async function findOwn(db: Db, user: Claims, id: string): Promise<BookingRow> {
  // Someone else's booking gets the same 404 as one that does not exist.
  const { rows } = await db.query<BookingRow>("SELECT * FROM bookings WHERE id = $1 AND user_id = $2", [id, user.sub]);
  if (!rows[0]) throw notFound("No such booking");
  return rows[0];
}

export async function create(
  deps: Deps,
  user: Claims,
  idempotencyKey: string,
  request: { flightId: string; passengers: Passenger[] },
): Promise<{ booking: BookingRow; replayed: boolean }> {
  const { db } = deps;
  const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const id = randomUUID();

  const inserted = await db.query<BookingRow>(
    `INSERT INTO bookings (id, user_id, contact_email, idempotency_key, request_hash, flight_id, passengers, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'NEW')
     ON CONFLICT (user_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [id, user.sub, user.email, idempotencyKey, hash, request.flightId, JSON.stringify(request.passengers)],
  );

  if (!inserted.rows[0]) {
    // Same key again: a double click or a client retry after a timeout.
    const { rows } = await db.query<BookingRow>(
      "SELECT * FROM bookings WHERE user_id = $1 AND idempotency_key = $2",
      [user.sub, idempotencyKey],
    );
    const existing = rows[0]!;
    if (existing.request_hash !== hash) {
      throw new HttpError(422, "idempotency_key_reused", "This Idempotency-Key was already used for a different booking");
    }
    return { booking: existing, replayed: true };
  }
  await db.query("INSERT INTO booking_history (booking_id, status, note) VALUES ($1, 'NEW', 'Booking started')", [id]);

  const seats = request.passengers.map((p) => p.seat);
  let hold;
  try {
    hold = await deps.flights.hold(id, request.flightId, seats, deps.holdSeconds);
  } catch (err) {
    if (err instanceof FlightsRefused) {
      await move(db, id, ["NEW"], "REJECTED", err.message, { failure: err.code });
      throw new HttpError(err.status, err.code, err.message, err.details);
    }
    if (err instanceof FlightsUnavailable) {
      // The hold may have gone through. The expiry sweep will release it.
      throw new HttpError(503, "flights_unavailable", "Could not reach the flights service, try again");
    }
    throw err;
  }

  const priced = request.passengers.map((p) => {
    const seat = hold.seats.find((s) => s.seat === p.seat)!;
    return { ...p, cabin: seat.cabin, pricePaise: seat.pricePaise };
  });
  const booking = await move(db, id, ["NEW"], "HELD", `Seats ${seats.join(", ")} held`, {
    flight_number: hold.flight.number,
    origin: hold.flight.origin,
    destination: hold.flight.destination,
    departs_at: hold.flight.departsAt,
    passengers: JSON.stringify(priced),
    // The price comes from the flights service, never from the client.
    total_paise: priced.reduce((sum, p) => sum + p.pricePaise, 0),
    expires_at: hold.heldUntil,
  });
  if (!booking) throw new Error(`booking ${id} left NEW while its hold was being placed`);
  return { booking, replayed: false };
}

export async function pay(deps: Deps, user: Claims, id: string, method: PaymentMethod): Promise<BookingRow> {
  const own = await findOwn(deps.db, user, id);
  const paying = await move(deps.db, id, ["HELD"], "PAYING", "Payment started", { payment_method: method }, "AND expires_at > now()");
  if (!paying) {
    if (own.status === "HELD") throw conflict("hold_expired", "The seat hold ran out. Start a new booking.");
    throw conflict("not_payable", `A ${own.status.toLowerCase()} booking cannot be paid`);
  }
  return settle(deps, paying);
}

/**
 * Takes a PAYING booking as far as it can go. Safe to call any number of
 * times: the charge, the seat confirmation and the refund are all idempotent,
 * and move() ignores a transition that already happened. Whatever stops it
 * halfway (a crash, the flights service timing out) leaves the booking in
 * PAYING for the reconciler to call this again.
 */
export async function settle(deps: Deps, booking: BookingRow): Promise<BookingRow> {
  const { db } = deps;
  const payment = await deps.payments.charge(
    `booking:${booking.id}`,
    booking.total_paise!,
    booking.payment_method ?? "mock_card",
  );

  if (payment.status === "declined") {
    return tx(db, async (c) => {
      const failed = await move(c, booking.id, ["PAYING"], "PAYMENT_FAILED", "Card declined", { failure: "card_declined" });
      if (failed) await emit(c, "booking.released", releaseEvent(failed));
      return failed ?? booking;
    });
  }

  await db.query("UPDATE bookings SET payment_id = $2 WHERE id = $1", [booking.id, payment.id]);
  const seats = booking.passengers.map((p) => p.seat);
  try {
    await deps.flights.confirm(booking.id, booking.flight_id, seats);
  } catch (err) {
    if (err instanceof FlightsUnavailable) return { ...booking, payment_id: payment.id };
    if (!(err instanceof FlightsRefused)) throw err;
    // We took the money but cannot give the seats. Give the money back.
    const refundId = await deps.payments.refund(payment.id);
    return tx(db, async (c) => {
      const failed = await move(c, booking.id, ["PAYING"], "FAILED", `${err.message}. Refunded in full.`, {
        failure: err.code,
        refund_id: refundId,
      });
      if (failed) await emit(c, "booking.released", releaseEvent(failed));
      return failed ?? booking;
    });
  }

  return tx(db, async (c) => {
    const confirmed = await move(c, booking.id, ["PAYING"], "CONFIRMED", "Paid and ticketed", { payment_id: payment.id });
    if (confirmed) await emit(c, "booking.confirmed", eventFor(confirmed));
    return confirmed ?? booking;
  });
}

export async function cancel(deps: Deps, user: Claims, id: string): Promise<BookingRow> {
  const { db } = deps;
  const b = await findOwn(db, user, id);
  if (b.status !== "CONFIRMED") throw conflict("not_cancellable", `A ${b.status.toLowerCase()} booking cannot be cancelled`);
  if (b.departs_at && b.departs_at.getTime() - Date.now() < CANCEL_CUTOFF_HOURS * 3600_000) {
    throw conflict("too_late", `Bookings can be cancelled up to ${CANCEL_CUTOFF_HOURS} hours before departure`);
  }
  // Refund first: it is idempotent, so a crash before the state change is
  // fixed by cancelling again, and the passenger is never left unrefunded.
  const refundId = await deps.payments.refund(b.payment_id!);
  return tx(db, async (c) => {
    const cancelled = await move(c, id, ["CONFIRMED"], "CANCELLED", "Cancelled by passenger. Refunded in full.", {
      refund_id: refundId,
    });
    if (!cancelled) throw conflict("not_cancellable", "The booking changed while cancelling, refresh and retry");
    await emit(c, "booking.cancelled", { ...eventFor(cancelled), reason: "passenger" });
    return cancelled;
  });
}

/** Releases holds nobody paid for, and bookings whose hold call never answered. */
export async function expireStale(db: Db): Promise<number> {
  return tx(db, async (c) => {
    const { rows } = await c.query<BookingRow>(
      `UPDATE bookings SET status = 'EXPIRED', updated_at = now()
       WHERE id IN (
         SELECT id FROM bookings
         WHERE (status = 'HELD' AND expires_at < now())
            OR (status = 'NEW' AND created_at < now() - interval '${NEW_TIMEOUT}')
         LIMIT 200 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
    );
    for (const b of rows) {
      await c.query("INSERT INTO booking_history (booking_id, status, note) VALUES ($1, 'EXPIRED', $2)", [
        b.id,
        "Hold ran out before payment",
      ]);
      await emit(c, "booking.released", releaseEvent(b));
    }
    return rows.length;
  });
}

/** Finishes payments that were interrupted. */
export async function reconcile(deps: Deps): Promise<number> {
  // Leave fresh PAYING bookings to the request that is still working on them.
  const { rows } = await deps.db.query<BookingRow>(
    `SELECT * FROM bookings WHERE status = 'PAYING' AND updated_at < now() - make_interval(secs => $1)
     ORDER BY updated_at LIMIT 20`,
    [deps.payingStaleSeconds],
  );
  for (const b of rows) {
    await settle(deps, b).catch((err) => console.error(`reconcile ${b.id}:`, err));
  }
  return rows.length;
}

/**
 * The airline cancelled a flight. Paid bookings are refunded; unpaid holds are
 * dropped. Bookings in PAYING are left alone: their seat confirmation will now
 * be refused, and settle() refunds them.
 */
export async function onFlightCancelled(deps: Deps, c: Tx, flightId: string): Promise<void> {
  const { rows } = await c.query<BookingRow>(
    "SELECT * FROM bookings WHERE flight_id = $1 AND status IN ('NEW', 'HELD', 'CONFIRMED') FOR UPDATE",
    [flightId],
  );
  for (const b of rows) {
    if (b.status === "CONFIRMED") {
      const refundId = await deps.payments.refund(b.payment_id!);
      const done = await move(c, b.id, ["CONFIRMED"], "CANCELLED_BY_AIRLINE", "Flight cancelled by the airline. Refunded in full.", {
        refund_id: refundId,
      });
      if (done) await emit(c, "booking.cancelled", { ...eventFor(done), reason: "flight_cancelled" });
    } else {
      const done = await move(c, b.id, ["NEW", "HELD"], "CANCELLED_BY_AIRLINE", "Flight cancelled by the airline");
      if (done) await emit(c, "booking.released", releaseEvent(done));
    }
  }
}
