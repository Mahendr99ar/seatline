import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";
import type { FlightsClient } from "../src/bookings/flights-client.js";
import { seatPlan } from "../src/flights/schema.js";
import type { Mailer } from "../src/notifications/mailer.js";

const db = (name: string) => `postgres://postgres@localhost/seatline_test_${name}?host=/tmp`;

Object.assign(process.env, {
  NODE_ENV: "test",
  JWT_SECRET: "test-jwt-secret-".padEnd(48, "x"),
  INTERNAL_TOKEN: "test-internal-token-".padEnd(48, "y"),
  USERS_DATABASE_URL: process.env.TEST_USERS_DATABASE_URL ?? db("users"),
  FLIGHTS_DATABASE_URL: process.env.TEST_FLIGHTS_DATABASE_URL ?? db("flights"),
  BOOKINGS_DATABASE_URL: process.env.TEST_BOOKINGS_DATABASE_URL ?? db("bookings"),
  NOTIFICATIONS_DATABASE_URL: process.env.TEST_NOTIFICATIONS_DATABASE_URL ?? db("notifications"),
  AMQP_URL: process.env.AMQP_URL ?? "amqp://localhost",
  SWEEP_MS: "150",
  SEND_EVERY_MS: "150",
  RATE_ALL_PER_MIN: "100000",
  RATE_BOOKINGS_PER_MIN: "100000",
  RATE_AUTH_PER_MIN: "100000",
});

async function wipe(url: string) {
  const c = new pg.Client(url);
  await c.connect();
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await c.end();
}

export interface StackOptions {
  wrapFlights?: (real: FlightsClient) => FlightsClient;
  mailer?: Mailer;
}

export type Stack = Awaited<ReturnType<typeof startStack>>;

/** All four services in this process, on random ports, against empty test databases. */
export async function startStack(opts: StackOptions = {}) {
  // A fresh exchange per run keeps leftovers from an earlier run out of this one.
  process.env.EVENTS_EXCHANGE = `seatline.test.${randomBytes(4).toString("hex")}`;
  for (const name of ["users", "flights", "bookings", "notifications"]) {
    await wipe(process.env[`${name.toUpperCase()}_DATABASE_URL`]!);
  }

  const { startFlights } = await import("../src/flights/service.js");
  const { startBookings } = await import("../src/bookings/service.js");
  const { startNotifications } = await import("../src/notifications/service.js");
  const { startGateway } = await import("../src/gateway/service.js");
  const { httpFlightsClient } = await import("../src/bookings/flights-client.js");

  const flights = await startFlights();
  await flights.app.listen({ port: 0, host: "127.0.0.1" });
  const flightsUrl = `http://127.0.0.1:${(flights.app.server.address() as AddressInfo).port}`;
  process.env.FLIGHTS_URL = flightsUrl;

  const real = httpFlightsClient(flightsUrl, process.env.INTERNAL_TOKEN!);
  const bookings = await startBookings({ flights: opts.wrapFlights ? opts.wrapFlights(real) : real });
  await bookings.app.listen({ port: 0, host: "127.0.0.1" });
  process.env.BOOKINGS_URL = `http://127.0.0.1:${(bookings.app.server.address() as AddressInfo).port}`;

  const notifications = await startNotifications({ mailer: opts.mailer });
  await notifications.app.listen({ port: 0, host: "127.0.0.1" });
  process.env.NOTIFICATIONS_URL = `http://127.0.0.1:${(notifications.app.server.address() as AddressInfo).port}`;

  process.env.WEB_ROOT = new URL("../web", import.meta.url).pathname;
  const gateway = await startGateway();
  await gateway.app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;

  await flights.db.query(
    "INSERT INTO airports VALUES ('DEL', 'Delhi', 'IGI'), ('BOM', 'Mumbai', 'CSMIA'), ('BLR', 'Bengaluru', 'KIA')",
  );

  async function addFlight(departsInMinutes: number, rows = 20, baseFarePaise = 500_000): Promise<string> {
    const id = randomUUID();
    const departs = new Date(Date.now() + departsInMinutes * 60_000);
    await flights.db.query(
      `INSERT INTO flights (id, number, origin, destination, departs_at, arrives_at)
       VALUES ($1, $2, 'DEL', 'BOM', $3, $4)`,
      [id, `SL ${Math.floor(Math.random() * 9000) + 1000}`, departs, new Date(departs.getTime() + 2 * 3600_000)],
    );
    const plan = seatPlan(rows, baseFarePaise);
    await flights.db.query(
      `INSERT INTO seats (flight_id, seat_no, cabin, price_paise)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::int[])`,
      [id, plan.map((p) => p.seat), plan.map((p) => p.cabin), plan.map((p) => p.pricePaise)],
    );
    return id;
  }

  async function api(method: string, path: string, opts: { token?: string; body?: unknown; key?: string } = {}) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.key) headers["idempotency-key"] = opts.key;
    const res = await fetch(base + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  let users = 0;
  async function user(name = `User ${++users}`): Promise<string> {
    const email = `${name.toLowerCase().replace(/\W+/g, ".")}.${randomBytes(3).toString("hex")}@example.com`;
    const res = await api("POST", "/api/auth/register", { body: { email, name, password: "long enough password" } });
    if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
    return res.body.token;
  }

  async function admin(): Promise<string> {
    const email = `admin.${randomBytes(3).toString("hex")}@example.com`;
    const password = "long enough password";
    await api("POST", "/api/auth/register", { body: { email, name: "Admin Person", password } });
    await gateway.db.query("UPDATE users SET role = 'admin' WHERE email = $1", [email]);
    // The role is read at login, so log in again for a token that carries it.
    const res = await api("POST", "/api/auth/login", { body: { email, password } });
    return res.body.token;
  }

  const book = (token: string, flightId: string, seats: string[], key = randomUUID()) =>
    api("POST", "/api/bookings", {
      token,
      key,
      body: { flightId, passengers: seats.map((seat, i) => ({ name: `Passenger ${"ABCDEFGHI"[i]}`, age: 30, seat })) },
    });

  async function seat(flightId: string, seatNo: string) {
    const { rows } = await flights.db.query("SELECT * FROM seats WHERE flight_id = $1 AND seat_no = $2", [
      flightId,
      seatNo,
    ]);
    return rows[0];
  }

  return {
    base,
    flights,
    bookings,
    notifications,
    gateway,
    api,
    user,
    admin,
    book,
    seat,
    addFlight,
    async stop() {
      await gateway.stop();
      await bookings.stop();
      await notifications.stop();
      await flights.stop();
    },
  };
}

/** Polls until fn returns something truthy, for things that happen through events. */
export async function eventually<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}
