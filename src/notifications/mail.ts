import { randomUUID } from "node:crypto";
import type { Tx } from "../shared/db.js";
import type { Mailer } from "./mailer.js";

export interface BookingEvent {
  bookingId: string;
  email: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departsAt: string;
  seats: string[];
  passengers: string[];
  totalPaise: number;
  reason?: "passenger" | "flight_cancelled";
}

const rupees = (paise: number) =>
  (paise / 100).toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const ist = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

const REMINDER_BEFORE_MS = 24 * 3600_000;

async function queue(c: Tx, e: BookingEvent, kind: string, subject: string, body: string, sendAt: Date) {
  await c.query(
    `INSERT INTO outgoing_mail (id, booking_id, kind, to_address, subject, body, send_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), e.bookingId, kind, e.email, subject, body, sendAt],
  );
}

export async function onConfirmed(c: Tx, e: BookingEvent, now = new Date()) {
  const route = `${e.origin} to ${e.destination}`;
  await queue(
    c,
    e,
    "confirmation",
    `Booked: ${e.flightNumber} ${route}, ${ist(e.departsAt)}`,
    [
      `Your booking ${e.bookingId} is confirmed.`,
      "",
      `Flight: ${e.flightNumber}, ${route}`,
      `Departs: ${ist(e.departsAt)} IST`,
      `Passengers: ${e.passengers.map((p, i) => `${p} (${e.seats[i]})`).join(", ")}`,
      `Paid: ${rupees(e.totalPaise)}`,
    ].join("\n"),
    now,
  );

  const remindAt = new Date(Date.parse(e.departsAt) - REMINDER_BEFORE_MS);
  // Booked less than a day out: the confirmation is the reminder.
  if (remindAt > now) {
    await queue(
      c,
      e,
      "reminder",
      `Tomorrow: ${e.flightNumber} ${route}`,
      `${e.flightNumber} leaves ${e.origin} at ${ist(e.departsAt)} IST. Seats ${e.seats.join(", ")}.`,
      remindAt,
    );
  }
}

export async function onCancelled(c: Tx, e: BookingEvent, now = new Date()) {
  await c.query(
    "UPDATE outgoing_mail SET status = 'cancelled' WHERE booking_id = $1 AND kind = 'reminder' AND status = 'pending'",
    [e.bookingId],
  );
  const why =
    e.reason === "flight_cancelled"
      ? `We are sorry: ${e.flightNumber} on ${ist(e.departsAt)} has been cancelled.`
      : `You cancelled booking ${e.bookingId}.`;
  await queue(
    c,
    e,
    "cancellation",
    `Cancelled: ${e.flightNumber} ${e.origin} to ${e.destination}`,
    `${why}\n\n${rupees(e.totalPaise)} has been refunded to your original payment method.`,
    now,
  );
}

export const MAX_ATTEMPTS = 5;

/** Sends what is due. A failed send is retried later with backoff, never marked sent. */
export async function sendDue(c: Tx, mailer: Mailer): Promise<number> {
  const { rows } = await c.query(
    `SELECT id, to_address, subject, body, attempts FROM outgoing_mail
     WHERE status = 'pending' AND send_at <= now()
     ORDER BY send_at LIMIT 20 FOR UPDATE SKIP LOCKED`,
  );
  for (const m of rows) {
    try {
      const providerId = await mailer.send({ to: m.to_address, subject: m.subject, text: m.body });
      await c.query(
        "UPDATE outgoing_mail SET status = 'sent', sent_at = now(), provider_id = $2, attempts = attempts + 1 WHERE id = $1",
        [m.id, providerId],
      );
    } catch (err) {
      const attempts = m.attempts + 1;
      await c.query(
        `UPDATE outgoing_mail SET attempts = $2, last_error = $3,
           status = CASE WHEN $2 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
           send_at = now() + make_interval(secs => 30 * 2 ^ $2)
         WHERE id = $1`,
        [m.id, attempts, String((err as Error).message).slice(0, 500)],
      );
    }
  }
  return rows.length;
}
