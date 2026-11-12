import { envInt } from "../shared/env.js";
import { startFlights } from "./service.js";

const svc = await startFlights();
svc.broker.conn.on("close", () => {
  // Let the container restart us with a fresh connection rather than run without events.
  console.error("RabbitMQ connection closed, exiting");
  process.exit(1);
});
await svc.app.listen({ host: "0.0.0.0", port: envInt("PORT", 8081) });
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => void svc.stop().then(() => process.exit(0)));
}
