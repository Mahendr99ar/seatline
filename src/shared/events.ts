import amqp, { type Channel, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from "amqplib";
import { randomUUID } from "node:crypto";
import { type Db, type Tx, tx } from "./db.js";

/*
 * Services never publish straight to RabbitMQ from a request. They write the
 * event into an outbox table in the same transaction as the state change, and
 * a relay publishes it afterwards. Either both the change and the event happen
 * or neither does; a crash between them only delays the event.
 */

export const OUTBOX_SCHEMA = `
  CREATE TABLE outbox (
    id uuid PRIMARY KEY,
    type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz
  );
  CREATE INDEX outbox_unpublished ON outbox (created_at) WHERE published_at IS NULL;
  CREATE TABLE processed_messages (
    id uuid PRIMARY KEY,
    processed_at timestamptz NOT NULL DEFAULT now()
  );
`;

export async function emit(c: Tx, type: string, payload: object): Promise<void> {
  await c.query("INSERT INTO outbox (id, type, payload) VALUES ($1, $2, $3)", [randomUUID(), type, payload]);
}

export interface Broker {
  conn: ChannelModel;
  exchange: string;
  close(): Promise<void>;
}

export async function connectBroker(url: string, exchange: string): Promise<Broker> {
  const conn = await amqp.connect(url);
  const ch = await conn.createChannel();
  await ch.assertExchange(exchange, "topic", { durable: true });
  // Messages a consumer gives up on land here instead of being lost or looping.
  await ch.assertExchange(`${exchange}.dead`, "fanout", { durable: true });
  await ch.assertQueue(`${exchange}.dead`, { durable: true });
  await ch.bindQueue(`${exchange}.dead`, `${exchange}.dead`, "");
  await ch.close();
  return { conn, exchange, close: () => conn.close() };
}

export function startRelay(db: Db, broker: Broker, intervalMs = 300): () => Promise<void> {
  let channel: ConfirmChannel | null = null;

  async function drain(): Promise<void> {
    if (!channel) {
      channel = await broker.conn.createConfirmChannel();
      channel.on("error", () => {});
      channel.on("close", () => {
        channel = null;
      });
    }
    const ch = channel;
    for (;;) {
      const sent = await tx(db, async (c) => {
        // SKIP LOCKED lets several replicas relay in parallel without sending a row twice.
        const { rows } = await c.query<{ id: string; type: string; payload: object }>(
          `SELECT id, type, payload FROM outbox WHERE published_at IS NULL
           ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
        );
        if (rows.length === 0) return 0;
        for (const row of rows) {
          ch.publish(broker.exchange, row.type, Buffer.from(JSON.stringify(row.payload)), {
            messageId: row.id,
            type: row.type,
            persistent: true,
            contentType: "application/json",
          });
        }
        // Only mark rows published once the broker has them on disk.
        await ch.waitForConfirms();
        await c.query("UPDATE outbox SET published_at = now() WHERE id = ANY($1)", [rows.map((r) => r.id)]);
        return rows.length;
      });
      if (sent < 100) return;
    }
  }

  const stop = every(intervalMs, "outbox relay", drain);
  return async () => {
    await stop();
    await channel?.close().catch(() => {});
  };
}

export interface Event<T = Record<string, unknown>> {
  id: string;
  type: string;
  payload: T;
}

/**
 * Delivery is at least once, so every handler runs inside a transaction that
 * also records the message id. A redelivered message finds its id taken and is
 * acknowledged without running the handler again.
 */
export async function consume(
  db: Db,
  broker: Broker,
  queue: string,
  types: string[],
  handler: (c: Tx, event: Event) => Promise<void>,
): Promise<() => Promise<void>> {
  // Queues are named after the exchange, so two deployments (or a test run
  // next to a dev stack) on one broker never steal each other's messages.
  queue = `${broker.exchange}.${queue}`;
  const ch: Channel = await broker.conn.createChannel();
  ch.on("error", (err) => console.error(`${queue} channel:`, err.message));
  await ch.assertQueue(queue, { durable: true, deadLetterExchange: `${broker.exchange}.dead` });
  for (const type of types) await ch.bindQueue(queue, broker.exchange, type);
  await ch.prefetch(10);

  const { consumerTag } = await ch.consume(queue, (msg: ConsumeMessage | null) => {
    if (!msg) return;
    const event: Event = {
      id: msg.properties.messageId as string,
      type: msg.fields.routingKey,
      payload: JSON.parse(msg.content.toString()),
    };
    tx(db, async (c) => {
      const fresh = await c.query("INSERT INTO processed_messages (id) VALUES ($1) ON CONFLICT DO NOTHING", [
        event.id,
      ]);
      if (fresh.rowCount === 1) await handler(c, event);
    })
      .then(() => ch.ack(msg))
      .catch((err) => {
        console.error(`${queue}: ${event.type} ${event.id} failed:`, err);
        // One retry, then the dead-letter queue. A bug should not spin forever.
        ch.nack(msg, false, !msg.fields.redelivered);
      });
  });

  return async () => {
    await ch.cancel(consumerTag).catch(() => {});
    await ch.close().catch(() => {});
  };
}

/** Runs fn every intervalMs. A slow run delays the next one instead of piling up behind it. */
export function every(intervalMs: number, name: string, fn: () => Promise<unknown>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let stopped = false;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = fn()
      .then(
        () => {},
        (err) => console.error(`${name}:`, err),
      )
      .finally(() => {
        running = null;
      });
  }, intervalMs);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
