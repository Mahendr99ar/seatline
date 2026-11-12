import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { FlightsUnavailable } from "../src/bookings/flights-client.ts";
import { type Stack, eventually, startStack } from "./stack.ts";

let s: Stack;
const outage = { confirm: 0 };
const mail = { down: false, sent: [] as string[] };

before(async () => {
  process.env.PAYING_STALE_SECONDS = "1";
  s = await startStack({
    wrapFlights: (real) => ({
      hold: real.hold,
      async confirm(...args) {
        if (outage.confirm > 0) {
          outage.confirm--;
          throw new FlightsUnavailable("simulated timeout");
        }
        return real.confirm(...args);
      },
    }),
    mailer: {
      async send(m) {
        if (mail.down) throw new Error("smtp: connection refused");
        mail.sent.push(m.subject);
        return `test-${randomUUID()}`;
      },
    },
  });
});
after(() => s.stop());

const get = (token: string, id: string) => s.api("GET", `/api/bookings/${id}`, { token }).then((r) => r.body);
const payWith = (token: string, id: string, method = "mock_card") =>
  s.api("POST", `/api/bookings/${id}/pay`, { token, body: { method } });
const mailFor = (bookingId: string) =>
  s.notifications.db.query("SELECT * FROM outgoing_mail WHERE booking_id = $1 ORDER BY created_at", [bookingId]).then((r) => r.rows);

describe("paying for a booking", () => {
  it("confirms, books the seats and emails the passenger", async () => {
    const flightId = await s.addFlight(72 * 60);
    const token = await s.user("Asha Rao");
    const held = await s.book(token, flightId, ["1A", "15F"]);
    assert.equal(held.body.status, "HELD");
    assert.equal(held.body.totalPaise, 1_500_000 + 500_000);

    const paid = await payWith(token, held.body.id);
    assert.equal(paid.status, 200);
    assert.equal(paid.body.status, "CONFIRMED");
    assert.equal((await s.seat(flightId, "1A")).status, "booked");

    const mails = await eventually(async () => {
      const rows = await mailFor(held.body.id);
      return rows.length === 2 && rows.find((m) => m.kind === "confirmation")?.status === "sent" ? rows : null;
    });
    const reminder = mails.find((m) => m.kind === "reminder")!;
    assert.equal(reminder.status, "pending");
    const departs = Date.parse(held.body.flight.departsAt);
    assert.equal(reminder.send_at.getTime(), departs - 24 * 3600_000);

    const again = await payWith(token, held.body.id);
    assert.equal(again.status, 409);
  });

  it("releases the seats when the card is declined", async () => {
    const flightId = await s.addFlight(72 * 60);
    const token = await s.user();
    const held = await s.book(token, flightId, ["16A"]);
    const res = await payWith(token, held.body.id, "mock_card_declined");
    assert.equal(res.body.status, "PAYMENT_FAILED");
    await eventually(async () => (await s.seat(flightId, "16A")).status === "free");
  });

  it("expires an unpaid hold and puts the seat back on sale", async () => {
    const flightId = await s.addFlight(72 * 60);
    const token = await s.user();
    s.bookings.deps.holdSeconds = 1;
    const held = await s.book(token, flightId, ["17B"]).finally(() => {
      s.bookings.deps.holdSeconds = 600;
    });
    await eventually(async () => (await get(token, held.body.id)).status === "EXPIRED");
    await eventually(async () => (await s.seat(flightId, "17B")).status === "free");
    assert.equal((await payWith(token, held.body.id)).body.error, "not_payable");
  });

  it("refunds when the hold ran out and someone else took the seat", async () => {
    const flightId = await s.addFlight(72 * 60);
    const slow = await s.user("Slow Payer");
    const fast = await s.user("Fast Payer");
    const first = await s.book(slow, flightId, ["18C"]);
    // The flights service considers the hold over; bookings has not swept it yet.
    await s.flights.db.query("UPDATE seats SET held_until = now() - interval '1 second' WHERE booking_id = $1", [
      first.body.id,
    ]);
    const second = await s.book(fast, flightId, ["18C"]);
    assert.equal(second.status, 201);

    const res = await payWith(slow, first.body.id);
    assert.equal(res.body.status, "FAILED");
    assert.equal(res.body.failure, "hold_lost");
    assert.match(res.body.refundId, /^rfnd_/);
    assert.equal((await s.seat(flightId, "18C")).booking_id, second.body.id);
  });

  it("finishes a payment after the flights service times out", async () => {
    const flightId = await s.addFlight(72 * 60);
    const token = await s.user();
    const held = await s.book(token, flightId, ["19D"]);
    outage.confirm = 2;
    const res = await payWith(token, held.body.id);
    assert.equal(res.status, 202);
    assert.equal(res.body.status, "PAYING");

    const done = await eventually(async () => {
      const b = await get(token, held.body.id);
      return b.status === "CONFIRMED" ? b : null;
    }, 10_000);
    assert.equal(outage.confirm, 0);
    const charges = await s.bookings.db.query("SELECT count(*)::int AS n FROM mock_payments WHERE idempotency_key = $1", [
      `booking:${held.body.id}`,
    ]);
    assert.equal(charges.rows[0].n, 1, "charged once despite retries");
    assert.ok(done.history.some((h: { status: string }) => h.status === "PAYING"));
  });
});

describe("cancelling", () => {
  it("refunds the passenger, frees the seat and drops the reminder", async () => {
    const flightId = await s.addFlight(72 * 60);
    const token = await s.user();
    const held = await s.book(token, flightId, ["20E"]);
    await payWith(token, held.body.id);
    await eventually(async () => (await mailFor(held.body.id)).length === 2);

    const res = await s.api("POST", `/api/bookings/${held.body.id}/cancel`, { token });
    assert.equal(res.body.status, "CANCELLED");
    assert.match(res.body.refundId, /^rfnd_/);

    await eventually(async () => (await s.seat(flightId, "20E")).status === "free");
    const mails = await eventually(async () => {
      const rows = await mailFor(held.body.id);
      return rows.length === 3 ? rows : null;
    });
    assert.equal(mails.find((m) => m.kind === "reminder")!.status, "cancelled");
    assert.ok(mails.some((m) => m.kind === "cancellation"));
  });

  it("refuses to cancel within three hours of departure", async () => {
    const flightId = await s.addFlight(150);
    const token = await s.user();
    const held = await s.book(token, flightId, ["5A"]);
    await payWith(token, held.body.id);
    const res = await s.api("POST", `/api/bookings/${held.body.id}/cancel`, { token });
    assert.equal(res.body.error, "too_late");
  });

  it("refunds everyone when the airline cancels the flight", async () => {
    const flightId = await s.addFlight(72 * 60);
    const paid = await s.user("Paid Passenger");
    const unpaid = await s.user("Unpaid Passenger");
    const a = await s.book(paid, flightId, ["6A"]);
    await payWith(paid, a.body.id);
    const b = await s.book(unpaid, flightId, ["6B"]);

    const admin = await s.admin();
    assert.equal((await s.api("POST", `/api/flights/${flightId}/cancel`, { token: admin })).status, 200);

    const refunded = await eventually(async () => {
      const x = await get(paid, a.body.id);
      return x.status === "CANCELLED_BY_AIRLINE" ? x : null;
    });
    assert.match(refunded.refundId, /^rfnd_/);
    await eventually(async () => (await get(unpaid, b.body.id)).status === "CANCELLED_BY_AIRLINE");
    await eventually(async () => (await mailFor(a.body.id)).some((m) => m.kind === "cancellation"));
    assert.equal((await s.book(paid, flightId, ["7A"])).body.error, "flight_cancelled");
  });
});

describe("notifications", () => {
  it("handles a redelivered event once", async () => {
    const ch = await s.notifications.broker.conn.createConfirmChannel();
    const bookingId = randomUUID();
    const payload = {
      bookingId,
      email: "twice@example.com",
      flightNumber: "SL 1",
      origin: "DEL",
      destination: "BOM",
      departsAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
      seats: ["1A"],
      passengers: ["Twice Sent"],
      totalPaise: 100_000,
    };
    const messageId = randomUUID();
    for (let i = 0; i < 2; i++) {
      ch.publish(s.notifications.broker.exchange, "booking.confirmed", Buffer.from(JSON.stringify(payload)), {
        messageId,
        persistent: true,
      });
    }
    await ch.waitForConfirms();
    await ch.close();
    await eventually(async () => (await mailFor(bookingId)).length > 0);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await mailFor(bookingId)).length, 2, "one confirmation and one reminder");
  });

  it("keeps a mail pending and retries later when the mail server is down", async () => {
    mail.down = true;
    try {
      const flightId = await s.addFlight(72 * 60);
      const token = await s.user();
      const held = await s.book(token, flightId, ["8F"]);
      await payWith(token, held.body.id);
      const m = await eventually(async () => {
        const rows = await mailFor(held.body.id);
        const c = rows.find((r) => r.kind === "confirmation");
        return c && c.attempts > 0 ? c : null;
      });
      assert.equal(m.status, "pending");
      assert.match(m.last_error, /connection refused/);
      assert.ok(m.send_at.getTime() > Date.now(), "pushed back for a later try");
      assert.equal(m.sent_at, null);
    } finally {
      mail.down = false;
    }
  });
});
