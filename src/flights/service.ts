import { connect, migrate } from "../shared/db.js";
import { connectBroker, consume, startRelay } from "../shared/events.js";
import { env, secret } from "../shared/env.js";
import { buildFlightsApp } from "./app.js";
import { release } from "./inventory.js";
import { MIGRATIONS } from "./schema.js";

export async function startFlights() {
  const db = connect(env("FLIGHTS_DATABASE_URL"));
  await migrate(db, MIGRATIONS);
  const broker = await connectBroker(env("AMQP_URL", "amqp://localhost"), env("EVENTS_EXCHANGE", "seatline.events"));

  const app = buildFlightsApp(db, { jwtSecret: secret("JWT_SECRET"), internalToken: secret("INTERNAL_TOKEN") });
  const stopRelay = startRelay(db, broker);
  // Seats go back on sale when a booking expires, fails to pay or is cancelled.
  const stopConsumer = await consume(
    db,
    broker,
    "flights-releases",
    ["booking.released", "booking.cancelled"],
    async (c, event) => {
      await release(c, String(event.payload.bookingId));
    },
  );

  return {
    app,
    db,
    broker,
    async stop() {
      await app.close();
      await stopConsumer();
      await stopRelay();
      await broker.close();
      await db.end();
    },
  };
}
