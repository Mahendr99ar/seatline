import { connect, migrate } from "../shared/db.js";
import { env, envInt, secret } from "../shared/env.js";
import { buildGateway } from "./app.js";
import { MIGRATIONS } from "./schema.js";

export async function startGateway() {
  const db = connect(env("USERS_DATABASE_URL"), 5);
  await migrate(db, MIGRATIONS);
  const app = buildGateway(db, {
    jwtSecret: secret("JWT_SECRET"),
    tokenTtlSeconds: envInt("TOKEN_TTL_SECONDS", 4 * 3600),
    flightsUrl: env("FLIGHTS_URL", "http://localhost:8081"),
    bookingsUrl: env("BOOKINGS_URL", "http://localhost:8082"),
    notificationsUrl: env("NOTIFICATIONS_URL", "http://localhost:8083"),
    webRoot: env("WEB_ROOT", "web"),
    trustProxy: env("TRUST_PROXY", "false") === "true",
    limits: {
      auth: envInt("RATE_AUTH_PER_MIN", 10),
      bookings: envInt("RATE_BOOKINGS_PER_MIN", 20),
      all: envInt("RATE_ALL_PER_MIN", 300),
    },
  });
  return {
    app,
    db,
    async stop() {
      await app.close();
      await db.end();
    },
  };
}
