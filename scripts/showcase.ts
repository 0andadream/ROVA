import path from "node:path";
import { erc20Abi } from "../config/abis.ts";
import { publicClient } from "../config/clients.ts";
import { loadDeployment, loadEnv, root } from "../config/env.ts";
import { explain } from "../config/explain.ts";
import { writeJson } from "../config/files.ts";
import { monad } from "../config/monad.ts";
import { ETH_USD_SCHEMA } from "../config/task.ts";
import { currentRankings, executeTask } from "../agent/src/execute.ts";
import { ensureCoordinator, ensureVerifiers, startTsx, waitHealth } from "./services.ts";

loadEnv();

async function main(): Promise<void> {
  if (await waitHealth("http://127.0.0.1:4300/health", (body) => (body as { ok?: boolean }).ok === true, 2)) {
    throw new Error("The agent server is already running. Stop pnpm demo before pnpm showcase.");
  }
  const cardUp = await waitHealth("http://127.0.0.1:4102/card", (body) => (body as { id?: string }).id === "B", 2);
  if (cardUp) {
    const card = (await (await fetch("http://127.0.0.1:4102/card")).json()) as { demoStale?: boolean };
    if (card.demoStale) {
      throw new Error("Providers are serving the stale demo. Stop that process, then run pnpm showcase.");
    }
  } else {
    const providers = startTsx("providers/src/index.ts", { DEMO_STALE: "0" });
    if (!(await waitHealth("http://127.0.0.1:4102/card", (body) => (body as { demoStale?: boolean }).demoStale === false))) {
      providers.kill("SIGTERM");
      throw new Error("Providers did not start with fresh timestamps.");
    }
    console.log("Left fresh providers running.");
  }
  await ensureVerifiers(null);
  await ensureCoordinator(null);

  const deployment = loadDeployment();
  const usdc = (await publicClient().readContract({
    address: monad.paymentToken.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [deployment.agent],
  })) as bigint;
  if (usdc < 360_000n) {
    throw new Error(`Buyer has ${(Number(usdc) / 1e6).toFixed(2)} USDC. Twelve settlements need 0.36 USDC.`);
  }

  const before = await currentRankings("0.05", "0.05");
  console.log("Rankings before showcase:");
  for (const provider of before.providers) {
    console.log(`${provider.rank ?? "-"} ${provider.id} score ${provider.score} success ${provider.successRate} orders ${provider.orders} volume ${provider.verifiedVolume}`);
  }

  const settled: { providerId: string; orderId: string; settlementTx: string; feedbackTx: string | null }[] = [];
  for (const id of ["B", "C", "A"] as const) {
    for (let copy = 0; copy < 4; copy += 1) {
      let recorded = false;
      let lastError = "no attempt";
      for (let attempt = 1; attempt <= 3 && !recorded; attempt += 1) {
        const run = await executeTask({
          task: "Get ETH/USD price data",
          totalBudget: "0.05",
          maxPrice: "0.05",
          maxLatencyMs: 3000,
          maxAgeSec: 60,
          schema: ETH_USD_SCHEMA,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
          onlyIds: [id],
        });
        const order = run.orders[0];
        const feedback = run.steps.find((step) => step.kind === "reputation")?.txHash ?? null;
        if (run.status === "passed" && run.orders.length === 1 && order?.providerId === id && order.status === "SETTLED" && feedback) {
          settled.push({ providerId: id, orderId: order.id, settlementTx: order.settlementTx, feedbackTx: feedback });
          console.log(`Settled ${id} order #${order.id}`);
          recorded = true;
          break;
        }
        lastError = run.error ?? run.status;
        if (run.orders.length > 0 || run.steps.some((step) => step.kind === "locked")) {
          throw new Error(`Showcase order for ${id} locked funds and did not settle: ${lastError}`);
        }
        console.error(`Showcase ${id} attempt ${attempt} failed before funding: ${lastError}`);
      }
      if (!recorded) throw new Error(`Showcase order for ${id} did not settle cleanly: ${lastError}`);
    }
  }

  const after = await currentRankings("0.05", "0.05");
  console.log("Rankings after showcase (reputation mode, because providers are fresh):");
  for (const provider of after.providers) {
    console.log(`${provider.rank ?? "-"} ${provider.id} score ${provider.score} success ${provider.successRate} orders ${provider.orders} volume ${provider.verifiedVolume}`);
  }
  if (settled.length < 10) throw new Error(`Only ${settled.length} settlements succeeded.`);
  writeJson(path.join(root, "config", "showcase.json"), {
    note: "Real Monad testnet settlements from one buyer. Values are transaction hashes, not hand-edited reputation.",
    count: settled.length,
    settlements: settled,
  });
  console.log(`Recorded ${settled.length} settlements in config/showcase.json`);
  process.exit(0);
}

main().catch((error) => {
  console.error(explain(error));
  process.exit(1);
});
