import assert from "node:assert/strict";
import { it } from "node:test";
import { RateLimiter } from "../src/gateway/rate-limit.ts";

it("allows the limit, refuses the next request and resets after a minute", () => {
  let now = 0;
  const limiter = new RateLimiter(() => now);
  for (let i = 0; i < 3; i++) assert.equal(limiter.hit("ip", 3), 0);
  assert.equal(limiter.hit("ip", 3), 60);
  assert.equal(limiter.hit("other-ip", 3), 0);
  now = 45_000;
  assert.equal(limiter.hit("ip", 3), 15);
  now = 60_000;
  assert.equal(limiter.hit("ip", 3), 0);
});
