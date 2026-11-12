import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Stack, startStack } from "./stack.ts";

let s: Stack;
before(async () => {
  s = await startStack();
});
after(() => s.stop());

describe("seat inventory under concurrency", () => {
  it("gives a contested seat to exactly one of 40 simultaneous buyers", async () => {
    const flightId = await s.addFlight(48 * 60);
    const tokens = await Promise.all(Array.from({ length: 40 }, () => s.user()));
    const results = await Promise.all(tokens.map((t) => s.book(t, flightId, ["10A"])));

    const won = results.filter((r) => r.status === 201);
    const lost = results.filter((r) => r.status === 409);
    assert.equal(won.length, 1);
    assert.equal(lost.length, 39);
    assert.ok(lost.every((r) => r.body.error === "seats_taken"));
    assert.equal((await s.seat(flightId, "10A")).booking_id, won[0]!.body.id);
  });

  it("never sells a seat twice when 80 buyers grab overlapping pairs", async () => {
    const flightId = await s.addFlight(48 * 60, 5); // 30 seats
    const seats = Array.from({ length: 5 }, (_, r) => ["A", "B", "C", "D", "E", "F"].map((l) => `${r + 1}${l}`)).flat();
    const pick = () => {
      const a = seats[Math.floor(Math.random() * seats.length)]!;
      let b = a;
      while (b === a) b = seats[Math.floor(Math.random() * seats.length)]!;
      return [a, b];
    };
    const tokens = await Promise.all(Array.from({ length: 80 }, () => s.user()));
    const results = await Promise.all(tokens.map((t) => s.book(t, flightId, pick())));
    assert.ok(results.every((r) => r.status === 201 || r.status === 409), "no 500s or deadlocks");

    const winners = results.filter((r) => r.status === 201).map((r) => r.body);
    const claimed = winners.flatMap((b) => b.passengers.map((p: { seat: string }) => p.seat));
    assert.equal(new Set(claimed).size, claimed.length, "a seat appears in two bookings");

    const { rows } = await s.flights.db.query(
      "SELECT count(*)::int AS n FROM seats WHERE flight_id = $1 AND status = 'held'",
      [flightId],
    );
    assert.equal(rows[0].n, claimed.length);
  });

  it("holds all seats of a booking or none of them", async () => {
    const flightId = await s.addFlight(48 * 60);
    const first = await s.user();
    await s.book(first, flightId, ["12B"]);
    const second = await s.user();
    const res = await s.book(second, flightId, ["12A", "12B", "12C"]);
    assert.equal(res.status, 409);
    assert.deepEqual(res.body.details.seats, ["12B"]);
    assert.equal((await s.seat(flightId, "12A")).status, "free");
    assert.equal((await s.seat(flightId, "12C")).status, "free");
  });

  it("treats a retried request with the same key as the same booking", async () => {
    const flightId = await s.addFlight(48 * 60);
    const token = await s.user();
    const key = "retry-key-0001";
    const [a, b] = await Promise.all([s.book(token, flightId, ["14D"], key), s.book(token, flightId, ["14D"], key)]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 201]);
    assert.equal(a.body.id, b.body.id);

    const changed = await s.book(token, flightId, ["14E"], key);
    assert.equal(changed.status, 422);

    const { rows } = await s.bookings.db.query("SELECT count(*)::int AS n FROM bookings WHERE idempotency_key = $1", [key]);
    assert.equal(rows[0].n, 1);
  });

  it("counts held seats as taken in search until the hold runs out", async () => {
    const flightId = await s.addFlight(48 * 60, 4);
    const token = await s.user();
    await s.book(token, flightId, ["4A", "4B"]);
    const detail = await s.api("GET", `/api/flights/${flightId}`);
    const map = new Map(detail.body.seats.map((x: { seat: string; available: boolean }) => [x.seat, x.available]));
    assert.equal(map.get("4A"), false);
    assert.equal(map.get("4C"), true);
    assert.equal(detail.body.seats.length, 24);
  });
});
