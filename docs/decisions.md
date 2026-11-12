# Design decisions

## Seats are rows, not a counter

A `seats_available` column has to be decremented correctly by every code path
forever, and one missed check sells seat 121 of 120. Here every seat is a row
with a status, so overselling would need two bookings to own the same row,
which the hold query cannot produce.

The hold in `src/flights/inventory.ts` does three things in one transaction:

1. `SELECT ... ORDER BY seat_no FOR UPDATE` locks the requested seats in a
   fixed order. Without the fixed order, one request for {1A, 1B} and another
   for {1B, 1A} can each lock one seat and wait on the other forever.
2. An `UPDATE` claims only seats that are free, whose hold has run out, or that
   this booking already holds.
3. If fewer rows came back than were asked for, it throws, and the rollback
   gives back the seats it did get.

The concurrency tests fire 40 and 80 requests at once to check this.

## Holds expire by time, not by a cleanup job

A held seat stores `held_until`. Every query that asks "is this seat
available" treats an expired hold as free. Nothing has to run on time for a
seat to come back on sale. The expiry sweep in bookings only updates the
booking's own status and tells flights to release, which tidies up.

## The booking is a state machine with guarded transitions

`src/bookings/saga.ts` lists the states. Every change is an
`UPDATE ... WHERE status = ANY(expected)`, so if two things race (the user
clicks pay as the hold expires, two reconcilers pick up the same booking) only
one transition applies and the other sees nothing to do.

## Payment and seat confirmation can each fail on their own

The awkward case is: the card was charged, then the call to confirm the seats
timed out. We do not know whether the seats were confirmed. The booking stays
in PAYING and the reconciler calls `settle()` again a few seconds later. That
is safe because each step is idempotent:

- the charge uses the key `booking:<id>`, so a second charge returns the first,
- confirming seats that are already confirmed succeeds again,
- refunding twice returns the same refund.

If confirmation comes back with a definite no (the hold ran out and someone
else took the seat, or the flight was cancelled), the charge is refunded and
the booking ends as FAILED.

## Events go through an outbox

Publishing to RabbitMQ inside a request has two failure modes: the database
commits and the publish fails (event lost), or the publish succeeds and the
commit fails (event about something that did not happen). Instead, the event
is a row in an `outbox` table written in the same transaction as the state
change. A relay publishes unsent rows with publisher confirms and marks them
sent only after RabbitMQ has them. A crash in between means the event is sent
again, never lost.

Consumers therefore see some events twice. Each one records the message id in
`processed_messages` in the same transaction as its own changes, and skips ids
it has seen. A handler that fails twice goes to a dead-letter queue instead of
retrying forever.

## Synchronous where the user waits, events everywhere else

Holding and confirming seats are HTTP calls because the user is looking at the
screen and needs the answer. Releasing seats, refunds after an airline
cancellation, and emails are events, because nobody waits on them and they
must survive a service being down for a while.

## Every service checks the token

The gateway forwards the `Authorization` header and each service verifies the
JWT itself. A service that trusted an `X-User-Id` header from the gateway would
trust it from anything else that could reach it. Internal routes need a shared
token as well and the gateway never forwards `/internal/*`.

The role is read from the database at login and signed into the token. A user
who is made admin has to log in again; tokens last 4 hours.

## Email is a queue, not a side effect

Notifications writes every email into `outgoing_mail` with a `send_at`. A loop
sends what is due and marks a row sent only after the mail server accepts it.
A failure is retried with backoff up to five times. Reminders are rows with
`send_at` 24 hours before departure, and cancelling a booking cancels its
pending reminder.

## Known gaps

- **Cancelling refunds before it records the cancellation.** If the process
  dies between the two, the booking still shows CONFIRMED with the money
  refunded. Cancelling again finishes it, because the refund is idempotent. A
  CANCELLING state picked up by the reconciler would close this properly.
- **Rate limits are in memory** in the gateway. With more than one gateway
  they would move to Redis.
- **Payments are a mock.** `payments.ts` has the same shape as a real provider
  (idempotency keys, refunds by payment id), so swapping in Razorpay or Stripe
  test mode means one new implementation of `PaymentProvider`, plus a webhook
  for payments that complete later.
- **If RabbitMQ goes away, a service exits** and Docker restarts it. Events wait
  in the outbox meanwhile, so nothing is lost, but there is no in-process
  reconnect.
- **One Postgres server hosts all four databases** to fit on a small VM. The
  services never read each other's tables, so splitting them later is a config change.
