import assert from "node:assert/strict";
import test from "node:test";
import { evaluateProviders, type ProviderInput } from "./ranking.ts";

const base = (patch: Partial<ProviderInput> & Pick<ProviderInput, "id" | "priceAtomic">): ProviderInput => ({
  name: patch.id,
  address: patch.address ?? `0x${patch.id.charCodeAt(0).toString(16).padStart(40, "0")}`,
  successRate: 0,
  orders: 0,
  verifiedVolumeAtomic: 0n,
  active: true,
  task: "eth-usd",
  ...patch,
});

const providers = [
  base({ id: "A", priceAtomic: 40_000n, address: "0x0000000000000000000000000000000000000003" }),
  base({ id: "B", priceAtomic: 20_000n, address: "0x0000000000000000000000000000000000000001" }),
  base({ id: "C", priceAtomic: 30_000n, address: "0x0000000000000000000000000000000000000002" }),
];

test("price mode ranks the seeded providers B, C, A", () => {
  const ranked = evaluateProviders(providers, {
    mode: "price",
    maxPriceAtomic: 50_000n,
    remainingAtomic: 50_000n,
    task: "eth-usd",
  });
  assert.deepEqual(
    ranked.filter((provider) => provider.eligible).map((provider) => provider.id),
    ["B", "C", "A"],
  );
});

test("fresh reputation still leaves the cheapest provider first", () => {
  const ranked = evaluateProviders(providers, {
    mode: "reputation",
    maxPriceAtomic: 50_000n,
    remainingAtomic: 50_000n,
    task: "eth-usd",
  });
  assert.equal(ranked[0]?.id, "B");
});

test("filters price, budget, task, and inactive providers before scoring", () => {
  const ranked = evaluateProviders(
    [
      base({ id: "A", priceAtomic: 40_000n, active: false }),
      base({ id: "B", priceAtomic: 20_000n, task: "other" }),
      base({ id: "C", priceAtomic: 80_000n }),
      base({ id: "D", priceAtomic: 30_000n }),
    ],
    { mode: "price", maxPriceAtomic: 50_000n, remainingAtomic: 25_000n, task: "eth-usd" },
  );
  assert.deepEqual(
    ranked.map((provider) => [provider.id, provider.eligible, provider.reason]),
    [
      ["A", false, "inactive"],
      ["B", false, "does not serve this task"],
      ["C", false, "above the per-request cap"],
      ["D", false, "above the remaining budget"],
    ],
  );
});

test("verified reputation can outrank a cheaper provider", () => {
  const ranked = evaluateProviders(
    [
      base({
        id: "A",
        priceAtomic: 40_000n,
        successRate: 1,
        orders: 10,
        verifiedVolumeAtomic: 10_000_000n,
        address: "0x000000000000000000000000000000000000000a",
      }),
      base({
        id: "B",
        priceAtomic: 20_000n,
        successRate: 0.2,
        orders: 5,
        verifiedVolumeAtomic: 20_000n,
        address: "0x000000000000000000000000000000000000000b",
      }),
    ],
    { mode: "reputation", maxPriceAtomic: 50_000n, remainingAtomic: 50_000n, task: "eth-usd" },
  );
  assert.equal(ranked[0]?.id, "A");
});

test("dust volume does not outrank a real settlement", () => {
  const ranked = evaluateProviders(
    [
      base({ id: "dust", priceAtomic: 20_000n, successRate: 1, verifiedVolumeAtomic: 1n, address: "0x0000000000000000000000000000000000000001" }),
      base({ id: "real", priceAtomic: 20_000n, successRate: 1, verifiedVolumeAtomic: 20_000n, address: "0x0000000000000000000000000000000000000002" }),
    ],
    { mode: "reputation", maxPriceAtomic: 50_000n, remainingAtomic: 50_000n, task: "eth-usd" },
  );
  assert.equal(ranked[0]?.id, "real");
});
