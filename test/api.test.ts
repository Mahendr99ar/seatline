import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Stack, startStack } from "./stack.ts";

let s: Stack;
let flightId: string;
before(async () => {
  s = await startStack();
  flightId = await s.addFlight(48 * 60);
});
after(() => s.stop());

describe("accounts", () => {
  it("registers, logs in and refuses a wrong password", async () => {
    const email = "meera@example.com";
    const reg = await s.api("POST", "/api/auth/register", {
      body: { email, name: "Meera Iyer", password: "a long password" },
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.role, "customer");

    const ok = await s.api("POST", "/api/auth/login", { body: { email: "MEERA@example.com", password: "a long password" } });
    assert.equal(ok.status, 200);
    const me = await s.api("GET", "/api/auth/me", { token: ok.body.token });
    assert.equal(me.body.email, email);

    const bad = await s.api("POST", "/api/auth/login", { body: { email, password: "wrong password" } });
    assert.equal(bad.status, 401);
    const unknown = await s.api("POST", "/api/auth/login", { body: { email: "nobody@example.com", password: "x" } });
    assert.equal(unknown.status, 401);
    assert.deepEqual(unknown.body.message, bad.body.message);
  });

  it("does not let a sign-up choose its own role", async () => {
    const res = await s.api("POST", "/api/auth/register", {
      body: { email: "sneaky@example.com", name: "Sneaky", password: "a long password", role: "admin" },
    });
    assert.equal(res.status, 400);
  });

  it("rejects a duplicate email regardless of case", async () => {
    await s.api("POST", "/api/auth/register", { body: { email: "dup@example.com", name: "One", password: "a long password" } });
    const again = await s.api("POST", "/api/auth/register", {
      body: { email: "DUP@example.com", name: "Two", password: "a long password" },
    });
    assert.equal(again.status, 409);
  });

  it("refuses forged and expired-looking tokens", async () => {
    const forged = await s.api("GET", "/api/bookings", { token: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0." });
    assert.equal(forged.status, 401);
    const none = await s.api("GET", "/api/bookings");
    assert.equal(none.status, 401);
  });
});

describe("admin routes", () => {
  const flight = {
    number: "SL 900",
    origin: "DEL",
    destination: "BLR",
    departsAt: new Date(Date.now() + 5 * 86400_000).toISOString(),
    arrivesAt: new Date(Date.now() + 5 * 86400_000 + 3 * 3600_000).toISOString(),
    baseFarePaise: 450_000,
    rows: 10,
  };

  it("lets only admins create and cancel flights", async () => {
    assert.equal((await s.api("POST", "/api/flights", { body: flight })).status, 401);
    const customer = await s.user();
    assert.equal((await s.api("POST", "/api/flights", { token: customer, body: flight })).status, 403);

    const admin = await s.admin();
    const created = await s.api("POST", "/api/flights", { token: admin, body: flight });
    assert.equal(created.status, 201);
    const detail = await s.api("GET", `/api/flights/${created.body.id}`);
    assert.equal(detail.body.seats.length, 60);
    assert.equal(detail.body.seats.find((x: { seat: string }) => x.seat === "1A").pricePaise, 1_350_000);

    assert.equal((await s.api("POST", `/api/flights/${created.body.id}/cancel`, { token: customer })).status, 403);
  });

  it("validates new flights", async () => {
    const admin = await s.admin();
    const bad = await s.api("POST", "/api/flights", {
      token: admin,
      body: { ...flight, destination: "DEL", baseFarePaise: -5 },
    });
    assert.equal(bad.status, 400);
  });

  it("never forwards internal routes", async () => {
    const res = await s.api("POST", "/internal/holds", { body: {} });
    assert.equal(res.status, 404);
  });
});

describe("booking requests", () => {
  it("requires an Idempotency-Key", async () => {
    const token = await s.user();
    const res = await s.api("POST", "/api/bookings", {
      token,
      body: { flightId, passengers: [{ name: "A B", age: 3, seat: "5A" }] },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "idempotency_key_required");
  });

  it("rejects bad passenger lists", async () => {
    const token = await s.user();
    const p = (seat: string, age = 30) => ({ name: "Kabir Shah", age, seat });
    const cases = [
      [],
      Array.from({ length: 10 }, (_, i) => p(`${i + 5}A`)),
      [p("5A"), p("5A")],
      [p("5A", -1)],
      [p("99Z")],
      [{ ...p("5A"), pricePaise: 1 }],
    ];
    for (const passengers of cases) {
      const res = await s.api("POST", "/api/bookings", { token, key: crypto.randomUUID(), body: { flightId, passengers } });
      assert.equal(res.status, 400, JSON.stringify(passengers));
    }
  });

  it("ignores a price sent by the client", async () => {
    const token = await s.user();
    const res = await s.api("POST", "/api/bookings", {
      token,
      key: crypto.randomUUID(),
      body: { flightId, totalPaise: 100, passengers: [{ name: "Cheap Skate", age: 30, seat: "6A" }] },
    });
    assert.equal(res.status, 400);
  });

  it("hides other people's bookings", async () => {
    const owner = await s.user("Owner");
    const other = await s.user("Other");
    const { body } = await s.book(owner, flightId, ["7C"]);
    for (const [method, path, payload] of [
      ["GET", `/api/bookings/${body.id}`, undefined],
      ["POST", `/api/bookings/${body.id}/pay`, { method: "mock_card" }],
      ["POST", `/api/bookings/${body.id}/cancel`, undefined],
    ] as const) {
      const res = await s.api(method, path, { token: other, body: payload });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
    const list = await s.api("GET", "/api/bookings", { token: other });
    assert.equal(list.body.length, 0);
  });

  it("refuses unknown seats, cancelled and closing flights", async () => {
    const token = await s.user();
    assert.equal((await s.book(token, flightId, ["30A"])).body.error, "unknown_seats");
    const soon = await s.addFlight(30);
    assert.equal((await s.book(token, soon, ["5A"])).body.error, "flight_closed");
    const missing = await s.book(token, crypto.randomUUID(), ["5A"]);
    assert.equal(missing.status, 404);
  });
});
