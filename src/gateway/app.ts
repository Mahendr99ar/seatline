import { randomUUID } from "node:crypto";
import path from "node:path";
import httpProxy from "@fastify/http-proxy";
import fastifyStatic from "@fastify/static";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authHooks, type Claims, signToken } from "../shared/auth.js";
import type { Db } from "../shared/db.js";
import { createApp, HttpError, parse } from "../shared/http.js";
import { RateLimiter } from "./rate-limit.js";

export interface GatewayConfig {
  jwtSecret: string;
  tokenTtlSeconds: number;
  flightsUrl: string;
  bookingsUrl: string;
  notificationsUrl: string;
  webRoot: string;
  trustProxy: boolean;
  limits: { auth: number; bookings: number; all: number };
}

const register = z.strictObject({
  email: z.email().max(254),
  name: z.string().trim().min(2).max(60),
  password: z.string().min(10, "at least 10 characters").max(128),
});
const login = z.strictObject({ email: z.string().max(254), password: z.string().max(128) });

// Compared against when the email is unknown, so a missing account takes as
// long to reject as a wrong password and response time does not reveal which.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export function buildGateway(db: Db, config: GatewayConfig): FastifyInstance {
  const app = createApp("gateway", { trustProxy: config.trustProxy });
  const { requireUser } = authHooks(config.jwtSecret);
  const limiter = new RateLimiter();

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const checks: [string, number][] = [["all", config.limits.all]];
    if (req.url.startsWith("/api/auth/") && req.method === "POST") checks.push(["auth", config.limits.auth]);
    if (req.url.startsWith("/api/bookings") && req.method === "POST") checks.push(["bookings", config.limits.bookings]);
    for (const [bucket, limit] of checks) {
      const wait = limiter.hit(`${bucket}:${req.ip}`, limit);
      if (wait > 0) {
        reply.header("retry-after", wait);
        throw new HttpError(429, "rate_limited", `Too many requests, try again in ${wait}s`);
      }
    }
  });

  const tokenFor = (u: { id: string; email: string; name: string; role: Claims["role"] }) => ({
    token: signToken(config.jwtSecret, { sub: u.id, email: u.email, name: u.name, role: u.role }, config.tokenTtlSeconds),
    user: { id: u.id, email: u.email, name: u.name, role: u.role },
  });

  app.post("/api/auth/register", async (req, reply) => {
    // strictObject: a "role" field in the body is a 400, not a quiet promotion to admin.
    const body = parse(register, req.body);
    const hash = await bcrypt.hash(body.password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING id, email, name, role`,
      [randomUUID(), body.email.toLowerCase(), body.name, hash],
    );
    if (!rows[0]) throw new HttpError(409, "email_taken", "An account with this email already exists");
    return reply.status(201).send(tokenFor(rows[0]));
  });

  app.post("/api/auth/login", async (req) => {
    const body = parse(login, req.body);
    const { rows } = await db.query("SELECT * FROM users WHERE lower(email) = lower($1)", [body.email]);
    const user = rows[0];
    const ok = await bcrypt.compare(body.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, "bad_credentials", "Wrong email or password");
    return tokenFor(user);
  });

  app.get("/api/auth/me", { preHandler: requireUser }, async (req) => {
    const { rows } = await db.query("SELECT id, email, name, role FROM users WHERE id = $1", [req.user!.sub]);
    if (!rows[0]) throw new HttpError(401, "unauthorized", "Account no longer exists");
    return rows[0];
  });

  // Each service checks the token itself; the gateway only routes. Paths not
  // listed here, /internal/* in particular, are never forwarded.
  const routes: [string, string][] = [
    ["/api/airports", config.flightsUrl],
    ["/api/flights", config.flightsUrl],
    ["/api/bookings", config.bookingsUrl],
    ["/api/admin/mail", config.notificationsUrl],
  ];
  for (const [prefix, upstream] of routes) {
    app.register(httpProxy, { upstream, prefix, rewritePrefix: prefix });
  }

  app.register(fastifyStatic, { root: path.resolve(config.webRoot) });
  return app;
}
