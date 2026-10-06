import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadDeployment } from "../../config/env.ts";
import { SEEDS, providerUrl } from "../../config/providers.ts";

let spot = 4125.23;

async function refreshSpot(): Promise<void> {
  try {
    const response = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", {
      signal: AbortSignal.timeout(2500),
    });
    const body = (await response.json()) as { data?: { amount?: string } };
    const next = Number(body.data?.amount);
    if (Number.isFinite(next) && next > 0) spot = Math.round(next * 100) / 100;
  } catch {
    spot = 4125.23;
  }
}

const deployment = loadDeployment();
const stale = process.env.DEMO_STALE === "1";

for (const seed of SEEDS) {
  const provider = deployment.providers[seed.id];
  const app = new Hono();
  const demoStale = seed.id === "B" && stale;

  app.get("/health", (c) => c.json({ ok: true, id: seed.id }));
  app.get("/card", (c) =>
    c.json({
      id: seed.id,
      name: seed.name,
      address: provider.address,
      task: "eth-usd",
      price: seed.price,
      active: true,
      demoStale,
      url: providerUrl(seed.port),
    }),
  );
  app.post("/task", async (c) => {
    const request = await c.req.json().catch(() => ({}));
    console.log(`provider ${seed.id} saw order ${request.orderId ?? "?"} funding ${request.fundingTx ?? "none"}`);
    await new Promise((resolve) => setTimeout(resolve, seed.delayMs));
    const timestamp = Math.floor(Date.now() / 1000) - (demoStale ? 180 : 0);
    return c.json({ symbol: "ETH/USD", price: spot, timestamp });
  });

  serve({ fetch: app.fetch, hostname: "127.0.0.1", port: seed.port }, (info) => {
    console.log(`provider ${seed.id} http://127.0.0.1:${info.port} stale=${demoStale}`);
  });
}

await refreshSpot();
console.log(`seeded ETH/USD spot ${spot}`);
