import { OUTBOX_SCHEMA } from "../shared/events.js";

export const MIGRATIONS = [
  `
  CREATE TABLE airports (
    code char(3) PRIMARY KEY,
    city text NOT NULL,
    name text NOT NULL
  );

  CREATE TABLE flights (
    id uuid PRIMARY KEY,
    number text NOT NULL,
    origin char(3) NOT NULL REFERENCES airports,
    destination char(3) NOT NULL REFERENCES airports,
    departs_at timestamptz NOT NULL,
    arrives_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (origin <> destination),
    CHECK (arrives_at > departs_at),
    UNIQUE (number, departs_at)
  );
  CREATE INDEX flights_route_day ON flights (origin, destination, departs_at);

  -- One row per seat. Inventory is the seat rows themselves, not a counter,
  -- so there is no number that can drift below zero.
  CREATE TABLE seats (
    flight_id uuid NOT NULL REFERENCES flights ON DELETE CASCADE,
    seat_no text NOT NULL,
    cabin text NOT NULL CHECK (cabin IN ('business', 'economy')),
    price_paise integer NOT NULL CHECK (price_paise > 0),
    status text NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'held', 'booked')),
    booking_id uuid,
    held_until timestamptz,
    PRIMARY KEY (flight_id, seat_no),
    CHECK ((status = 'free') = (booking_id IS NULL)),
    CHECK ((status = 'held') = (held_until IS NOT NULL))
  );
  CREATE INDEX seats_booking ON seats (booking_id) WHERE booking_id IS NOT NULL;
  ${OUTBOX_SCHEMA}
  `,
];

export const LETTERS = ["A", "B", "C", "D", "E", "F"] as const;
export const BUSINESS_ROWS = 2;
export const BUSINESS_MULTIPLIER = 3;

export function seatPlan(rows: number, baseFarePaise: number) {
  const plan: { seat: string; cabin: "business" | "economy"; pricePaise: number }[] = [];
  for (let row = 1; row <= rows; row++) {
    const business = row <= BUSINESS_ROWS;
    for (const letter of LETTERS) {
      plan.push({
        seat: `${row}${letter}`,
        cabin: business ? "business" : "economy",
        pricePaise: business ? baseFarePaise * BUSINESS_MULTIPLIER : baseFarePaise,
      });
    }
  }
  return plan;
}
