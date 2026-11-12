import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authHooks } from "../shared/auth.js";
import { type Db, tx } from "../shared/db.js";
import { emit } from "../shared/events.js";
import { createApp, HttpError, notFound, parse } from "../shared/http.js";
import { confirm, hold } from "./inventory.js";
import { seatPlan } from "./schema.js";

export interface FlightsConfig {
  jwtSecret: string;
  internalToken: string;
}

const airportCode = z.string().regex(/^[A-Z]{3}$/, "three capital letters");
const seatNo = z.string().regex(/^[1-9]\d?[A-F]$/, "a seat like 14C");
const seatList = z
  .array(seatNo)
  .min(1)
  .max(9)
  .refine((s) => new Set(s).size === s.length, "seats must not repeat");

const search = z.object({
  from: airportCode,
  to: airportCode,
  date: z.iso.date(),
});

const newFlight = z
  .strictObject({
    number: z.string().regex(/^SL ?\d{2,4}$/, "a flight number like SL 204"),
    origin: airportCode,
    destination: airportCode,
    departsAt: z.iso.datetime({ offset: true }),
    arrivesAt: z.iso.datetime({ offset: true }),
    baseFarePaise: z.int().min(50_000).max(5_000_000),
    rows: z.int().min(4).max(40).default(20),
  })
  .refine((f) => f.origin !== f.destination, "origin and destination must differ")
  .refine((f) => Date.parse(f.arrivesAt) > Date.parse(f.departsAt), "arrival must be after departure");

const holdRequest = z.strictObject({
  bookingId: z.uuid(),
  flightId: z.uuid(),
  seats: seatList,
  holdSeconds: z.int().min(1).max(3600),
});

const confirmRequest = z.strictObject({ flightId: z.uuid(), seats: seatList });
const idParam = z.object({ id: z.uuid() });

export function buildFlightsApp(db: Db, config: FlightsConfig): FastifyInstance {
  const app = createApp("flights");
  const { requireAdmin } = authHooks(config.jwtSecret);
  const expected = Buffer.from(config.internalToken);

  // Routes under /internal are for other services. The gateway never forwards
  // them, and they also need the shared token in case the network is not as
  // private as it should be.
  const requireInternal = async (req: FastifyRequest) => {
    const given = Buffer.from(String(req.headers["x-internal-token"] ?? ""));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new HttpError(401, "unauthorized", "Internal route");
    }
  };

  app.get("/api/airports", async () => {
    const { rows } = await db.query("SELECT code, city, name FROM airports ORDER BY city");
    return rows;
  });

  app.get("/api/flights", async (req) => {
    const q = parse(search, req.query);
    // "date" is a calendar day in India, whatever timezone the server runs in.
    const { rows } = await db.query(
      `SELECT f.id, f.number, f.origin, f.destination, f.departs_at, f.arrives_at, f.status,
              count(*) FILTER (WHERE s.status = 'free' OR (s.status = 'held' AND s.held_until < now()))::int
                AS seats_left,
              min(s.price_paise) FILTER (WHERE s.status = 'free' OR (s.status = 'held' AND s.held_until < now()))
                AS from_paise
       FROM flights f JOIN seats s ON s.flight_id = f.id
       WHERE f.origin = $1 AND f.destination = $2
         AND f.departs_at >= ($3::date::timestamp AT TIME ZONE 'Asia/Kolkata')
         AND f.departs_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
         AND f.departs_at > now()
       GROUP BY f.id
       ORDER BY f.departs_at`,
      [q.from, q.to, q.date],
    );
    return rows.map(flightView);
  });

  app.get("/api/flights/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const { rows } = await db.query("SELECT * FROM flights WHERE id = $1", [id]);
    if (!rows[0]) throw notFound("No such flight");
    // Who holds a seat is nobody else's business; only say whether it is available.
    const seats = await db.query(
      `SELECT seat_no, cabin, price_paise,
              (status = 'free' OR (status = 'held' AND held_until < now())) AS available
       FROM seats WHERE flight_id = $1
       ORDER BY substring(seat_no from '^\\d+')::int, seat_no`,
      [id],
    );
    return {
      ...flightView(rows[0]),
      seats: seats.rows.map((s) => ({
        seat: s.seat_no,
        cabin: s.cabin,
        pricePaise: s.price_paise,
        available: s.available,
      })),
    };
  });

  app.post("/api/flights", { preHandler: requireAdmin }, async (req, reply) => {
    const f = parse(newFlight, req.body);
    const id = randomUUID();
    const number = f.number.replace(/^SL ?/, "SL ");
    await tx(db, async (c) => {
      const airports = await c.query("SELECT code FROM airports WHERE code = ANY($1)", [[f.origin, f.destination]]);
      if (airports.rowCount !== 2) throw new HttpError(400, "unknown_airport", "Unknown airport code");
      const clash = await c.query(
        "INSERT INTO flights (id, number, origin, destination, departs_at, arrives_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING",
        [id, number, f.origin, f.destination, f.departsAt, f.arrivesAt],
      );
      if (clash.rowCount === 0) throw new HttpError(409, "duplicate", `${number} already departs at that time`);
      const plan = seatPlan(f.rows, f.baseFarePaise);
      await c.query(
        `INSERT INTO seats (flight_id, seat_no, cabin, price_paise)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::int[])`,
        [id, plan.map((p) => p.seat), plan.map((p) => p.cabin), plan.map((p) => p.pricePaise)],
      );
    });
    return reply.status(201).send({ id, number });
  });

  app.post("/api/flights/:id/cancel", { preHandler: requireAdmin }, async (req) => {
    const { id } = parse(idParam, req.params);
    return tx(db, async (c) => {
      const { rows } = await c.query("SELECT status FROM flights WHERE id = $1 FOR UPDATE", [id]);
      if (!rows[0]) throw notFound("No such flight");
      if (rows[0].status === "cancelled") return { id, status: "cancelled" };
      await c.query("UPDATE flights SET status = 'cancelled' WHERE id = $1", [id]);
      // Bookings refunds the passengers when it sees this event.
      await emit(c, "flight.cancelled", { flightId: id });
      return { id, status: "cancelled" };
    });
  });

  app.post("/internal/holds", { preHandler: requireInternal }, async (req) => {
    const h = parse(holdRequest, req.body);
    return tx(db, (c) => hold(c, h.bookingId, h.flightId, h.seats, h.holdSeconds));
  });

  app.post("/internal/holds/:id/confirm", { preHandler: requireInternal }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(confirmRequest, req.body);
    await tx(db, (c) => confirm(c, id, body.flightId, body.seats));
    return { ok: true };
  });

  return app;
}

function flightView(f: Record<string, unknown>) {
  return {
    id: f.id,
    number: f.number,
    origin: f.origin,
    destination: f.destination,
    departsAt: f.departs_at,
    arrivesAt: f.arrives_at,
    status: f.status,
    ...(f.seats_left !== undefined && { seatsLeft: f.seats_left, fromPaise: f.from_paise }),
  };
}
