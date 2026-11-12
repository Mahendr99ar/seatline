import { OUTBOX_SCHEMA } from "../shared/events.js";

export const MIGRATIONS = [
  `
  -- Every email we mean to send, now or later. The sender loop delivers rows
  -- whose send_at has passed and only marks them sent once the mail server
  -- has accepted them.
  CREATE TABLE outgoing_mail (
    id uuid PRIMARY KEY,
    booking_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('confirmation', 'cancellation', 'reminder')),
    to_address text NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    send_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    provider_id text,
    sent_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX outgoing_mail_due ON outgoing_mail (send_at) WHERE status = 'pending';
  CREATE INDEX outgoing_mail_booking ON outgoing_mail (booking_id);
  ${OUTBOX_SCHEMA}
  `,
];
