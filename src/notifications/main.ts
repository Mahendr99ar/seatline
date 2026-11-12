import { envInt } from "../shared/env.js";
import { startNotifications } from "./service.js";

const svc = await startNotifications();
svc.broker.conn.on("close", () => {
  console.error("RabbitMQ connection closed, exiting");
  process.exit(1);
});
await svc.app.listen({ host: "0.0.0.0", port: envInt("PORT", 8083) });
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => void svc.stop().then(() => process.exit(0)));
}
