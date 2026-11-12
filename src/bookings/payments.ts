import { randomBytes } from "node:crypto";
import type { Db } from "../shared/db.js";

export type PaymentMethod = "mock_card" | "mock_card_declined";

export interface Payment {
  id: string;
  status: "captured" | "declined";
  amountPaise: number;
}

export interface PaymentProvider {
  /** Charging twice with the same key returns the first result, like Stripe's Idempotency-Key. */
  charge(idempotencyKey: string, amountPaise: number, method: PaymentMethod): Promise<Payment>;
  /** Refunding twice returns the same refund. */
  refund(paymentId: string): Promise<string>;
}

const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;

/** A fake provider. "mock_card_declined" is always declined; everything else is captured. */
export function mockProvider(db: Db): PaymentProvider {
  return {
    async charge(key, amountPaise, method) {
      const status = method === "mock_card_declined" ? "declined" : "captured";
      await db.query(
        `INSERT INTO mock_payments (id, idempotency_key, amount_paise, status)
         VALUES ($1, $2, $3, $4) ON CONFLICT (idempotency_key) DO NOTHING`,
        [newId("pay"), key, amountPaise, status],
      );
      const { rows } = await db.query("SELECT id, status, amount_paise FROM mock_payments WHERE idempotency_key = $1", [
        key,
      ]);
      const row = rows[0]!;
      return { id: row.id, status: row.status, amountPaise: row.amount_paise };
    },

    async refund(paymentId) {
      const { rows } = await db.query(
        `UPDATE mock_payments SET refund_id = coalesce(refund_id, $2)
         WHERE id = $1 AND status = 'captured' RETURNING refund_id`,
        [paymentId, newId("rfnd")],
      );
      if (!rows[0]) throw new Error(`payment ${paymentId} cannot be refunded`);
      return rows[0].refund_id;
    },
  };
}
