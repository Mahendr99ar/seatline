import { envInt } from "../shared/env.js";
import { startGateway } from "./service.js";

const svc = await startGateway();
await svc.app.listen({ host: "0.0.0.0", port: envInt("PORT", 8080) });
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => void svc.stop().then(() => process.exit(0)));
}
