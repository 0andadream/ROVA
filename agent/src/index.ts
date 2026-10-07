import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { identityAbi } from "../../config/abis.ts";
import { assertNetwork, publicClient } from "../../config/clients.ts";
import { loadDeployment, type Deployment } from "../../config/env.ts";
import { explain } from "../../config/explain.ts";
import { addressUrl, monad, paymentPath, TRUST, txUrl } from "../../config/monad.ts";
import { AGENT_PORT, DEMO_BADGE, faultyBadge, providerUrl, SEEDS } from "../../config/providers.ts";
import { assertEscrowMatchesDeployment } from "../../config/quorum.ts";
import { ETH_USD_SCHEMA } from "../../config/task.ts";
import { listActivity } from "./chain.ts";
import { currentRankings, readRun, startRun, type TaskInput } from "./execute.ts";

const app = new Hono();
app.use("*", cors());

function deploymentOrNull(): Deployment | null {
  try {
    return loadDeployment();
  } catch {
    return null;
  }
}

async function demoMode(): Promise<boolean> {
  try {
    const response = await fetch(`${providerUrl(4102)}/card`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return process.env.DEMO_STALE === "1";
    const card = (await response.json()) as { demoStale?: boolean };
    return card.demoStale === true;
  } catch {
    return process.env.DEMO_STALE === "1";
  }
}

app.get("/health", (c) => c.json({ ok: true, service: "agent" }));

app.get("/meta", async (c) => {
  const deployment = deploymentOrNull();
  const stale = await demoMode();
  let identityCode = false;
  try {
    const code = await publicClient().getCode({ address: monad.erc8004.identityRegistry });
    identityCode = Boolean(code && code !== "0x");
  } catch {
    identityCode = false;
  }
  return c.json({
    ready: Boolean(deployment),
    chainId: monad.chainId,
    chainName: monad.chainName,
    rpcUrl: monad.rpcUrl,
    explorerUrl: monad.explorerUrl,
    explorerName: monad.explorerName,
    escrow: deployment?.escrow ?? null,
    escrowUrl: deployment ? addressUrl(deployment.escrow) : null,
    deployTx: deployment?.deployTx ?? null,
    deployUrl: deployment?.deployTx ? txUrl(deployment.deployTx) : null,
    token: {
      address: monad.paymentToken.address,
      symbol: monad.paymentToken.symbol,
      decimals: monad.paymentToken.decimals,
      url: addressUrl(monad.paymentToken.address),
    },
    threshold: deployment?.threshold ?? null,
    verifiers: (deployment?.verifiers ?? []).map((address) => ({ address, url: addressUrl(address) })),
    identityOwner: deployment?.identityOwner ?? null,
    identityOwnerUrl: deployment ? addressUrl(deployment.identityOwner) : null,
    agent: deployment?.agent ?? null,
    agentUrl: deployment ? addressUrl(deployment.agent) : null,
    registries: {
      identity: monad.erc8004.identityRegistry,
      identityUrl: addressUrl(monad.erc8004.identityRegistry),
      reputation: monad.erc8004.reputationRegistry,
      reputationUrl: addressUrl(monad.erc8004.reputationRegistry),
      version: monad.erc8004.version,
      identityCode,
    },
    x402: {
      usedForEscrow: monad.x402.usedForEscrow,
      facilitatorUrl: monad.x402.facilitatorUrl,
      network: monad.x402.network,
    },
    paymentPath,
    schema: ETH_USD_SCHEMA,
    trust: TRUST,
    demoMode: stale,
    demoBadge: stale ? DEMO_BADGE : null,
    faultyBadge: faultyBadge(),
    providers: SEEDS.map((seed) => {
      const saved = deployment?.providers[seed.id];
      return {
        id: seed.id,
        name: seed.name,
        price: seed.price,
        address: saved?.address ?? null,
        addressUrl: saved ? addressUrl(saved.address) : null,
        agentId: saved?.agentId || null,
        registerUrl: saved?.registerTx ? txUrl(saved.registerTx) : null,
        url: providerUrl(seed.port),
      };
    }),
    identityAbiPresent: identityAbi.length > 0,
  });
});

app.get("/rankings", async (c) => {
  try {
    const maxPrice = c.req.query("maxPrice") ?? "0.05";
    const budget = c.req.query("budget") ?? "0.05";
    return c.json(await currentRankings(maxPrice, budget));
  } catch (error) {
    return c.json({ error: explain(error) }, 503);
  }
});

app.get("/activity", async (c) => {
  try {
    const stale = await demoMode();
    return c.json({
      demoMode: stale,
      demoBadge: stale ? DEMO_BADGE : null,
      faultyBadge: faultyBadge(),
      rows: await listActivity(),
    });
  } catch (error) {
    return c.json({ error: explain(error) }, 503);
  }
});

app.get("/runs/:id", (c) => {
  const run = readRun(c.req.param("id"));
  if (!run) return c.json({ error: "No run with that id." }, 404);
  return c.json(run);
});

app.post("/run", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body must be JSON." }, 400);
  }
  if (body.onlyIds !== undefined) {
    return c.json({ error: "onlyIds is not accepted on this endpoint." }, 400);
  }
  const minutes = body.expiryMinutes === undefined ? 10 : Number(body.expiryMinutes);
  if (!Number.isInteger(minutes) || minutes < 2 || minutes > 60) {
    return c.json({ error: "Expiry must be an integer from 2 to 60 minutes." }, 400);
  }
  let schema: Record<string, unknown> = ETH_USD_SCHEMA as unknown as Record<string, unknown>;
  if (typeof body.schema === "string" && body.schema.trim()) {
    try {
      schema = JSON.parse(body.schema) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Schema is not valid JSON." }, 400);
    }
  } else if (body.schema && typeof body.schema === "object" && !Array.isArray(body.schema)) {
    schema = body.schema as Record<string, unknown>;
  }
  const input: TaskInput = {
    task: String(body.task ?? "Get ETH/USD price data"),
    totalBudget: String(body.totalBudget ?? "0.05"),
    maxPrice: String(body.maxPrice ?? "0.05"),
    maxLatencyMs: Number(body.maxLatencyMs ?? 3000),
    maxAgeSec: Number(body.maxAgeSec ?? 60),
    schema,
    expiresAt: Math.floor(Date.now() / 1000) + minutes * 60,
  };
  try {
    const run = startRun(input);
    return c.json({ runId: run.id });
  } catch (error) {
    return c.json({ error: explain(error) }, 400);
  }
});

const port = Number(process.env.AGENT_PORT ?? AGENT_PORT);
try {
  await assertNetwork();
  await assertEscrowMatchesDeployment();
} catch (error) {
  console.error(explain(error));
  process.exit(1);
}
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`agent http://127.0.0.1:${info.port}`);
  const badge = faultyBadge();
  if (badge) console.log(badge);
});
