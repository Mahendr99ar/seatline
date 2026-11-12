import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Not found") => new HttpError(404, "not_found", what);
export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details);

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new HttpError(400, "invalid_request", "Request did not validate", issues);
  }
  return result.data;
}

export function createApp(name: string, opts: { trustProxy?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    trustProxy: opts.trustProxy ?? false,
    logger: process.env.NODE_ENV === "test" ? false : { level: process.env.LOG_LEVEL ?? "info", name },
    bodyLimit: 64 * 1024,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    }
    const { statusCode, message } = err as { statusCode?: number; message?: string };
    if (statusCode && statusCode < 500) {
      return reply.status(statusCode).send({ error: "bad_request", message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: "internal", message: "Something went wrong on our side" });
  });

  app.get("/healthz", async () => ({ ok: true }));
  return app;
}
