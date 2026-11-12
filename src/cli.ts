import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import bcrypt from "bcryptjs";
import { connect, migrate, tx } from "./shared/db.js";
import { env } from "./shared/env.js";
import { MIGRATIONS as FLIGHTS, seatPlan } from "./flights/schema.js";
import { MIGRATIONS as USERS } from "./gateway/schema.js";

const AIRPORTS: [string, string, string][] = [
  ["DEL", "Delhi", "Indira Gandhi International"],
  ["BOM", "Mumbai", "Chhatrapati Shivaji Maharaj International"],
  ["BLR", "Bengaluru", "Kempegowda International"],
  ["HYD", "Hyderabad", "Rajiv Gandhi International"],
  ["MAA", "Chennai", "Chennai International"],
  ["CCU", "Kolkata", "Netaji Subhas Chandra Bose International"],
  ["GOI", "Goa", "Dabolim"],
  ["COK", "Kochi", "Cochin International"],
  ["AMD", "Ahmedabad", "Sardar Vallabhbhai Patel International"],
  ["PNQ", "Pune", "Pune International"],
];

// Sample schedule: route and block time in minutes. Each runs both ways.
const ROUTES: [string, string, number][] = [
  ["DEL", "BOM", 130], ["DEL", "BLR", 165], ["DEL", "HYD", 135], ["DEL", "MAA", 170],
  ["DEL", "CCU", 130], ["DEL", "GOI", 155], ["DEL", "AMD", 95], ["DEL", "PNQ", 125],
  ["BOM", "BLR", 100], ["BOM", "HYD", 85], ["BOM", "MAA", 115], ["BOM", "GOI", 70],
  ["BOM", "CCU", 160], ["BLR", "HYD", 75], ["BLR", "MAA", 60], ["BLR", "COK", 70],
];
const DEPARTURES_IST = ["06:10", "13:45", "20:30"];

async function seed(days: number) {
  const db = connect(env("FLIGHTS_DATABASE_URL"), 2);
  await migrate(db, FLIGHTS);
  let created = 0;
  await tx(db, async (c) => {
    for (const [code, city, name] of AIRPORTS) {
      await c.query("INSERT INTO airports VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [code, city, name]);
    }
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    let n = 100;
    for (const [a, b, minutes] of ROUTES) {
      for (const [origin, destination] of [[a, b], [b, a]] as const) {
        const baseFarePaise = (2500 + minutes * 30) * 100;
        for (const [slot, time] of DEPARTURES_IST.entries()) {
          const number = `SL ${n + slot}`;
          for (let d = 0; d < days; d++) {
            const day = new Date(Date.parse(`${today}T00:00:00+05:30`) + d * 86_400_000)
              .toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
            const departs = new Date(`${day}T${time}:00+05:30`);
            const arrives = new Date(departs.getTime() + minutes * 60_000);
            const id = randomUUID();
            const res = await c.query(
              `INSERT INTO flights (id, number, origin, destination, departs_at, arrives_at)
               VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
              [id, number, origin, destination, departs, arrives],
            );
            if (res.rowCount === 0) continue;
            const plan = seatPlan(20, baseFarePaise);
            await c.query(
              `INSERT INTO seats (flight_id, seat_no, cabin, price_paise)
               SELECT $1, * FROM unnest($2::text[], $3::text[], $4::int[])`,
              [id, plan.map((p) => p.seat), plan.map((p) => p.cabin), plan.map((p) => p.pricePaise)],
            );
            created++;
          }
        }
        n += DEPARTURES_IST.length;
      }
    }
  });
  await db.end();
  console.log(`created ${created} flights over ${days} days`);
}

async function createAdmin(email: string, name: string) {
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question("Password (12+ characters): ");
    rl.close();
  }
  if (password.length < 12) throw new Error("Use at least 12 characters for an admin password");
  const db = connect(env("USERS_DATABASE_URL"), 1);
  await migrate(db, USERS);
  await db.query(
    `INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, lower($2), $3, $4, 'admin')
     ON CONFLICT (lower(email)) DO UPDATE SET role = 'admin', password_hash = excluded.password_hash`,
    [randomUUID(), email, name, await bcrypt.hash(password, 10)],
  );
  await db.end();
  console.log(`${email} is an admin`);
}

const [command, ...args] = process.argv.slice(2);
if (command === "seed") await seed(Number(args[0] ?? 14));
else if (command === "create-admin" && args[0] && args[1]) await createAdmin(args[0], args.slice(1).join(" "));
else {
  console.error("usage: cli seed [days] | cli create-admin <email> <name>");
  process.exit(2);
}
