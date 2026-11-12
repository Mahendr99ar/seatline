import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { HttpError } from "./http.js";

export type Role = "customer" | "admin";
export interface Claims {
  sub: string;
  email: string;
  name: string;
  role: Role;
}

export function signToken(secret: string, claims: Claims, ttlSeconds: number): string {
  return jwt.sign(claims, secret, { algorithm: "HS256", expiresIn: ttlSeconds });
}

export function verifyToken(secret: string, token: string): Claims | null {
  try {
    // Pin the algorithm so a token signed with "none" or RS256 tricks is refused.
    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (typeof decoded === "string") return null;
    const { sub, email, name, role } = decoded as Partial<Claims>;
    if (!sub || !email || !name || (role !== "customer" && role !== "admin")) return null;
    return { sub, email, name, role };
  } catch {
    return null;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    user: Claims | null;
  }
}

/** Every service checks the token itself; none of them trusts a header the gateway could forward. */
export function authHooks(secret: string) {
  function userFrom(req: FastifyRequest): Claims {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const claims = token ? verifyToken(secret, token) : null;
    if (!claims) throw new HttpError(401, "unauthorized", "Sign in first");
    return claims;
  }
  return {
    requireUser: async (req: FastifyRequest, _reply: FastifyReply) => {
      req.user = userFrom(req);
    },
    requireAdmin: async (req: FastifyRequest, _reply: FastifyReply) => {
      req.user = userFrom(req);
      if (req.user.role !== "admin") throw new HttpError(403, "forbidden", "Admins only");
    },
  };
}
