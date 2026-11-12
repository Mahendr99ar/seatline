import { envInt } from "../shared/env.js";
import { startBookings } from "./service.js";

const svc = await startBookings();
svc.broker.conn.on("close", () => {
  console.error("RabbitMQ connection closed, exiting");
  process.exit(1);
});
await svc.app.listen({ host: "0.0.0.0", port: envInt("PORT", 8082) });
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => void svc.stop().then(() => process.exit(0)));
}
