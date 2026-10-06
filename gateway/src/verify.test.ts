import assert from "node:assert/strict";
import test from "node:test";
import { ETH_USD_SCHEMA } from "../../config/task.ts";
import { verifyResponse } from "./verify.ts";

const schema = ETH_USD_SCHEMA;
const now = 1_700_000_000;

function check(patch: Partial<Parameters<typeof verifyResponse>[0]>) {
  return verifyResponse({
    httpOk: true,
    bodyText: JSON.stringify({ symbol: "ETH/USD", price: 4125.23, timestamp: now - 10 }),
    latencyMs: 200,
    maxLatencyMs: 3000,
    maxAgeSec: 60,
    nowSec: now,
    schema,
    ...patch,
  });
}

test("fresh ETH/USD payload passes", () => {
  const result = check({});
  assert.equal(result.ok, true);
  assert.equal(result.schemaOk, true);
  assert.equal(result.freshnessOk, true);
  assert.equal(result.ageSec, 10);
});

test("stale but well-formed payload fails freshness only", () => {
  const result = check({
    bodyText: JSON.stringify({ symbol: "ETH/USD", price: 4125.23, timestamp: now - 180 }),
  });
  assert.equal(result.schemaOk, true);
  assert.equal(result.nonEmpty, true);
  assert.equal(result.freshnessOk, false);
  assert.equal(result.ok, false);
  assert.equal(result.ageSec, 180);
});

test("empty, slow, future, and wrong-shaped payloads fail closed", () => {
  assert.equal(check({ bodyText: "   ", httpOk: true }).nonEmpty, false);
  assert.equal(check({ latencyMs: 3001 }).latencyOk, false);
  assert.equal(check({ bodyText: JSON.stringify({ symbol: "ETH/USD", price: 1, timestamp: now + 30 }) }).freshnessOk, false);
  assert.equal(check({ bodyText: JSON.stringify({ symbol: "BTC/USD", price: 1, timestamp: now }) }).schemaOk, false);
  assert.equal(check({ bodyText: "not-json" }).schemaOk, false);
  assert.equal(check({ bodyText: JSON.stringify({ symbol: "ETH/USD", price: "4125", timestamp: now }) }).schemaOk, false);
});
