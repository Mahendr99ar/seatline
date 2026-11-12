# Seatline

Flight booking split into four services that talk over HTTP and RabbitMQ. The
point of the project is the hard part of booking: two people clicking the same
seat at the same moment, a payment that succeeds while the seat confirmation
times out, a flight cancelled after people have paid.

```
             browser
                │
           ┌────▼────┐   auth, rate limits, routing, serves the web app
           │ gateway │
           └─┬─────┬─┘
     ┌───────▼┐   ┌▼─────────┐   hold / confirm (HTTP, internal token)
     │flights │◄──┤ bookings │
     └───┬────┘   └────┬─────┘
         │  outbox     │  outbox
         └──► RabbitMQ ◄──┘
                 │
          ┌──────▼──────┐   confirmation, cancellation and reminder emails
          │notifications│
          └─────────────┘
   each service has its own Postgres database
```

## What happens when you book

1. **Hold.** Bookings asks flights to hold the seats for 10 minutes. Flights
   locks the seat rows and holds all of them or none. The price comes from
   flights, never from the browser.
2. **Pay.** A mock payment provider charges with an idempotency key, so a
   retried charge is the same charge.
3. **Confirm.** Bookings asks flights to turn the hold into a sale, then marks
   the booking confirmed and writes a `booking.confirmed` event in the same
   transaction.
4. **Notify.** Notifications sends the confirmation and schedules a reminder
   24 hours before departure.

If the card is declined, the hold runs out, the seat went to someone else, or
the airline cancels the flight, the booking ends in a clear state and any money
taken is refunded. Every step is in the booking's history on its page.

## What is tested

28 tests in `test/` run against real Postgres and RabbitMQ:

- 40 buyers racing for one seat: exactly one gets it, 39 get a 409.
- 80 buyers grabbing random overlapping pairs of 30 seats: no seat in two
  bookings, no deadlocks, no 500s.
- Same Idempotency-Key sent twice at once: one booking. Same key with a
  different body: 422.
- Hold ran out and someone else took the seat before payment: refunded, booking FAILED.
- Flights service times out after the charge: booking waits in PAYING, the
  reconciler finishes it, and the card is charged once.
- Airline cancels a flight: paid passengers refunded, holds dropped, emails sent.
- An event delivered twice: handled once.
- Mail server down: the email stays pending with a backoff, never marked sent.
- Access control: `"role": "admin"` in a sign-up is a 400, another user's booking
  is a 404, `/internal/*` is not reachable through the gateway.

## Numbers

`scripts/loadtest.ts` against the compiled services, all on one 2 vCPU machine
with Postgres and RabbitMQ:

| Buyers at once, each wanting 2 of 120 seats | Hold p50 / p95 | Pay p50 / p95 |
|---|---|---|
| 50 | 160 / 203 ms | 133 / 154 ms |
| 200 | 692 / 888 ms | 544 / 662 ms |

In the 200-buyer run 46 bookings were confirmed and exactly 92 seats were
taken. The script exits with an error if those two ever disagree.

Memory while idle after that run: gateway 117 MB, bookings 119 MB, flights
80 MB, notifications 83 MB, RabbitMQ 127 MB.

## Run it

With Docker:

```bash
cp .env.example .env     # fill in the four secrets
docker compose up -d --build
docker compose run --rm gateway node dist/cli.js seed 14
docker compose run --rm gateway node dist/cli.js create-admin you@example.com "Your Name"
```

Open http://localhost:8080. Putting it online for free is covered in
[deploy/hosting.md](deploy/hosting.md).

Without Docker you need Node 22, Postgres 16 with the four databases from
`deploy/postgres-init.sql`, and RabbitMQ:

```bash
npm install
export JWT_SECRET=... INTERNAL_TOKEN=...   # 32+ characters each
export USERS_DATABASE_URL=postgres://localhost/seatline_users   # and FLIGHTS_, BOOKINGS_, NOTIFICATIONS_
npm run seed
npm run dev:flights & npm run dev:bookings & npm run dev:notifications & npm run dev:gateway
```

Tests need the `seatline_test_*` databases and RabbitMQ on localhost:

```bash
npm test
```

## Layout

```
src/shared/          db transactions and migrations, JWT, outbox relay, event consumer
src/gateway/         accounts, rate limits, routing to the services
src/flights/         airports, schedules, seat inventory (inventory.ts)
src/bookings/        the booking state machine (saga.ts), mock payments
src/notifications/   email queue, reminders
web/                 the web app, plain JS, no build step
test/                integration tests
```

Why it is built this way, and what it does not do yet:
[docs/decisions.md](docs/decisions.md).
