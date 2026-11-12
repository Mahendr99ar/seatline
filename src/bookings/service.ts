import { connect, migrate } from "../shared/db.js";
import { env, envInt, secret } from "../shared/env.js";
import { connectBroker, consume, every, startRelay } from "../shared/events.js";
import { buildBookingsApp } from "./app.js";
import { type FlightsClient, httpFlightsClient } from "./flights-client.js";
import { mockProvider } from "./payments.js";
import { type Deps, expireStale, onFlightCancelled, reconcile } from "./saga.js";
import { MIGRATIONS } from "./schema.js";

export async function startBookings(overrides: { flights?: FlightsClient } = {}) {
  const db = connect(env("BOOKINGS_DATABASE_URL"));
  await migrate(db, MIGRATIONS);
  const broker = await connectBroker(env("AMQP_URL", "amqp://localhost"), env("EVENTS_EXCHANGE", "seatline.events"));

  const deps: Deps = {
    db,
    flights: overrides.flights ?? httpFlightsClient(env("FLIGHTS_URL", "http://localhost:8081"), secret("INTERNAL_TOKEN")),
    payments: mockProvider(db),
    holdSeconds: envInt("HOLD_SECONDS", 600),
    payingStaleSeconds: envInt("PAYING_STALE_SECONDS", 10),
  };
  const app = buildBookingsApp(deps, secret("JWT_SECRET"));

  const sweepMs = envInt("SWEEP_MS", 5000);
  const stoppers = [
    startRelay(db, broker),
    every(sweepMs, "expire", () => expireStale(db)),
    every(sweepMs, "reconcile", () => reconcile(deps)),
    await consume(db, broker, "bookings-flight-changes", ["flight.cancelled"], (c, event) =>
      onFlightCancelled(deps, c, String(event.payload.flightId)),
    ),
  ];

  return {
    app,
    db,
    deps,
    broker,
    async stop() {
      await app.close();
      for (const stop of stoppers.reverse()) await stop();
      await broker.close();
      await db.end();
    },
  };
}
