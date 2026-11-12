import { authHooks } from "../shared/auth.js";
import { connect, migrate, tx } from "../shared/db.js";
import { env, envInt, secret } from "../shared/env.js";
import { connectBroker, consume, every } from "../shared/events.js";
import { createApp } from "../shared/http.js";
import { type BookingEvent, onCancelled, onConfirmed, sendDue } from "./mail.js";
import { logMailer, type Mailer, smtpMailer } from "./mailer.js";
import { MIGRATIONS } from "./schema.js";

export async function startNotifications(overrides: { mailer?: Mailer } = {}) {
  const db = connect(env("NOTIFICATIONS_DATABASE_URL"), 5);
  await migrate(db, MIGRATIONS);
  const broker = await connectBroker(env("AMQP_URL", "amqp://localhost"), env("EVENTS_EXCHANGE", "seatline.events"));
  const smtp = process.env.SMTP_URL;
  const mailer =
    overrides.mailer ?? (smtp ? smtpMailer(smtp, env("MAIL_FROM", "Seatline <no-reply@seatline.local>")) : logMailer());

  const stopConsumer = await consume(
    db,
    broker,
    "notifications-bookings",
    ["booking.confirmed", "booking.cancelled"],
    async (c, event) => {
      const e = event.payload as unknown as BookingEvent;
      if (event.type === "booking.confirmed") await onConfirmed(c, e);
      else await onCancelled(c, e);
    },
  );
  const stopSender = every(envInt("SEND_EVERY_MS", 2000), "send mail", () => tx(db, (c) => sendDue(c, mailer)));

  // Without a mail server the admin page is the only place to read what was sent.
  const app = createApp("notifications");
  const { requireAdmin } = authHooks(secret("JWT_SECRET"));
  app.get("/api/admin/mail", { preHandler: requireAdmin }, async () => {
    const { rows } = await db.query(
      `SELECT id, booking_id, kind, to_address, subject, body, status, send_at, sent_at, attempts, last_error
       FROM outgoing_mail ORDER BY created_at DESC LIMIT 50`,
    );
    return rows;
  });

  return {
    app,
    db,
    broker,
    async stop() {
      await app.close();
      await stopConsumer();
      await stopSender();
      await broker.close();
      await db.end();
    },
  };
}
