import { OUTBOX_SCHEMA } from "../shared/events.js";

export const MIGRATIONS = [
  `
  CREATE TABLE bookings (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    contact_email text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    flight_id uuid NOT NULL,
    flight_number text,
    origin char(3),
    destination char(3),
    departs_at timestamptz,
    passengers jsonb NOT NULL,
    total_paise integer CHECK (total_paise > 0),
    status text NOT NULL,
    expires_at timestamptz,
    payment_method text,
    payment_id text,
    refund_id text,
    failure text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, idempotency_key)
  );
  CREATE INDEX bookings_user ON bookings (user_id, created_at DESC);
  CREATE INDEX bookings_flight ON bookings (flight_id);
  CREATE INDEX bookings_open ON bookings (status, updated_at) WHERE status IN ('NEW', 'HELD', 'PAYING');

  CREATE TABLE booking_history (
    booking_id uuid NOT NULL REFERENCES bookings,
    at timestamptz NOT NULL DEFAULT clock_timestamp(),
    status text NOT NULL,
    note text NOT NULL
  );
  CREATE INDEX booking_history_booking ON booking_history (booking_id, at);

  -- Stands in for a payment provider such as Razorpay or Stripe. Kept in its
  -- own table and only reached through payments.ts, the way a real provider
  -- would only be reached through its API.
  CREATE TABLE mock_payments (
    id text PRIMARY KEY,
    idempotency_key text NOT NULL UNIQUE,
    amount_paise integer NOT NULL,
    status text NOT NULL CHECK (status IN ('captured', 'declined')),
    refund_id text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ${OUTBOX_SCHEMA}
  `,
];
