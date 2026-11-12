/**
 * Many buyers, one flight, overlapping seats. Reports latency and checks
 * afterwards that no seat ended up in two confirmed bookings.
 *
 *   npx tsx scripts/loadtest.ts http://localhost:8080 200
 */
import { randomUUID } from "node:crypto";

const base = process.argv[2] ?? "http://localhost:8080";
const buyers = Number(process.argv[3] ?? 200);

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

const date = new Date(Date.now() + 2 * 86400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const flights = (await call("GET", `/api/flights?from=BOM&to=GOI&date=${date}`)).body;
// The emptiest flight, so repeated runs do not fight over leftovers.
const flight = flights.sort((a: { seatsLeft: number }, b: { seatsLeft: number }) => b.seatsLeft - a.seatsLeft)[0];
const detail = (await call("GET", `/api/flights/${flight.id}`)).body;
const free: string[] = detail.seats.filter((x: { available: boolean }) => x.available).map((x: { seat: string }) => x.seat);
console.log(`${flight.number} on ${date}: ${free.length} seats free, ${buyers} buyers`);

const tokens = await Promise.all(
  Array.from({ length: buyers }, async (_, i) => {
    const r = await call("POST", "/api/auth/register", {
      email: `load.${randomUUID().slice(0, 8)}.${i}@example.com`,
      name: "Load Tester",
      password: "load test password",
    });
    return r.body.token as string;
  }),
);

const holdMs: number[] = [];
const payMs: number[] = [];
const outcome: Record<string, number> = {};
const started = performance.now();
await Promise.all(
  tokens.map(async (token) => {
    const a = free[Math.floor(Math.random() * free.length)]!;
    let b = a;
    while (b === a) b = free[Math.floor(Math.random() * free.length)]!;
    const auth = { authorization: `Bearer ${token}` };
    let t = performance.now();
    const held = await call(
      "POST",
      "/api/bookings",
      { flightId: flight.id, passengers: [{ name: "Load Tester", age: 30, seat: a }, { name: "Load Helper", age: 30, seat: b }] },
      { ...auth, "idempotency-key": randomUUID() },
    );
    holdMs.push(performance.now() - t);
    if (held.status !== 201) {
      outcome[held.body?.error ?? held.status] = (outcome[held.body?.error ?? held.status] ?? 0) + 1;
      return;
    }
    t = performance.now();
    const paid = await call("POST", `/api/bookings/${held.body.id}/pay`, { method: "mock_card" }, auth);
    payMs.push(performance.now() - t);
    outcome[paid.body.status] = (outcome[paid.body.status] ?? 0) + 1;
  }),
);
const seconds = (performance.now() - started) / 1000;

console.log(`done in ${seconds.toFixed(1)} s: ${JSON.stringify(outcome)}`);
console.log(`hold  p50 ${pct(holdMs, 0.5).toFixed(0)} ms  p95 ${pct(holdMs, 0.95).toFixed(0)} ms`);
if (payMs.length) console.log(`pay   p50 ${pct(payMs, 0.5).toFixed(0)} ms  p95 ${pct(payMs, 0.95).toFixed(0)} ms`);

const after = (await call("GET", `/api/flights/${flight.id}`)).body;
const taken = after.seats.filter((x: { available: boolean }) => !x.available).length - (detail.seats.length - free.length);
const confirmed = outcome.CONFIRMED ?? 0;
console.log(`seats taken in this run: ${taken}, confirmed bookings x 2 seats: ${2 * confirmed}`);
if (taken !== 2 * confirmed) process.exitCode = 1;
