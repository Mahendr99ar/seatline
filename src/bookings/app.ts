import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authHooks } from "../shared/auth.js";
import { createApp, HttpError, parse } from "../shared/http.js";
import { type BookingRow, cancel, create, type Deps, findOwn, pay } from "./saga.js";

const passenger = z.strictObject({
  name: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[\p{L} .'-]+$/u, "letters, spaces, dots, hyphens and apostrophes only"),
  age: z.int().min(0).max(120),
  seat: z.string().regex(/^[1-9]\d?[A-F]$/, "a seat like 14C"),
});

const newBooking = z.strictObject({
  flightId: z.uuid(),
  passengers: z
    .array(passenger)
    .min(1)
    .max(9)
    .refine((ps) => new Set(ps.map((p) => p.seat)).size === ps.length, "two passengers cannot share a seat"),
});

const payment = z.strictObject({ method: z.enum(["mock_card", "mock_card_declined"]) });
const idParam = z.object({ id: z.uuid() });
const idempotencyKey = z.string().regex(/^[\w-]{8,64}$/, "8 to 64 letters, digits, - or _");

export function view(b: BookingRow) {
  return {
    id: b.id,
    status: b.status,
    flight: {
      id: b.flight_id,
      number: b.flight_number,
      origin: b.origin,
      destination: b.destination,
      departsAt: b.departs_at,
    },
    passengers: b.passengers,
    totalPaise: b.total_paise,
    expiresAt: b.status === "HELD" ? b.expires_at : null,
    paymentId: b.payment_id,
    refundId: b.refund_id,
    failure: b.failure,
    createdAt: b.created_at,
  };
}

export function buildBookingsApp(deps: Deps, jwtSecret: string): FastifyInstance {
  const app = createApp("bookings");
  const { requireUser } = authHooks(jwtSecret);
  const { db } = deps;

  app.addHook("preHandler", requireUser);

  app.post("/api/bookings", async (req, reply) => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string") {
      throw new HttpError(400, "idempotency_key_required", "Send an Idempotency-Key header so a retry cannot book twice");
    }
    parse(idempotencyKey, key);
    const body = parse(newBooking, req.body);
    const { booking, replayed } = await create(deps, req.user!, key, body);
    return reply.status(replayed ? 200 : 201).send(view(booking));
  });

  app.get("/api/bookings", async (req) => {
    const { rows } = await db.query<BookingRow>(
      `SELECT * FROM bookings WHERE user_id = $1 AND status NOT IN ('NEW', 'REJECTED')
       ORDER BY created_at DESC LIMIT 100`,
      [req.user!.sub],
    );
    return rows.map(view);
  });

  app.get("/api/bookings/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    const b = await findOwn(db, req.user!, id);
    const history = await db.query("SELECT at, status, note FROM booking_history WHERE booking_id = $1 ORDER BY at", [
      id,
    ]);
    return { ...view(b), history: history.rows };
  });

  app.post("/api/bookings/:id/pay", async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const { method } = parse(payment, req.body);
    const b = await pay(deps, req.user!, id, method);
    // 202: money taken, seats not confirmed yet. The reconciler finishes it.
    return reply.status(b.status === "PAYING" ? 202 : 200).send(view(b));
  });

  app.post("/api/bookings/:id/cancel", async (req) => {
    const { id } = parse(idParam, req.params);
    return view(await cancel(deps, req.user!, id));
  });

  return app;
}
