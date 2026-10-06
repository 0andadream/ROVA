import { erc20Abi } from "../config/abis.ts";
import { publicClient } from "../config/clients.ts";
import { loadDeployment, loadEnv } from "../config/env.ts";
import { explain } from "../config/explain.ts";
import { evidenceFile, readJson } from "../config/files.ts";
import { formatUsdc } from "../config/money.ts";
import { monad, txUrl } from "../config/monad.ts";
import { ETH_USD_SCHEMA } from "../config/task.ts";
import { readOrder } from "../agent/src/chain.ts";
import { executeTask } from "../agent/src/execute.ts";
import { startTsx, stop, waitHealth } from "./services.ts";

loadEnv();

const failures: string[] = [];

function expect(condition: unknown, message: string): void {
  if (!condition) failures.push(message);
}

async function balanceOf(address: `0x${string}`): Promise<bigint> {
  return publicClient().readContract({
    address: monad.paymentToken.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  }) as Promise<bigint>;
}

async function main(): Promise<void> {
  if (await waitHealth("http://127.0.0.1:4300/health", (body) => (body as { ok?: boolean }).ok === true, 2)) {
    throw new Error("The agent server is already running on port 4300. Stop pnpm demo before pnpm prove.");
  }

  let providers = null;
  const already = await waitHealth("http://127.0.0.1:4102/card", (body) => (body as { id?: string }).id === "B", 2);
  if (!already) {
    providers = startTsx("providers/src/index.ts", { DEMO_STALE: "1" });
    if (!(await waitHealth("http://127.0.0.1:4102/card", (body) => (body as { id?: string }).id === "B"))) {
      stop(providers);
      throw new Error("Provider B did not start.");
    }
  }
  const card = (await (await fetch("http://127.0.0.1:4102/card")).json()) as { demoStale?: boolean };
  if (card.demoStale !== true) {
    throw new Error("Provider B is not serving stale data. Stop the other provider process and rerun pnpm prove.");
  }

  let gateway = null;
  const gatewayUp = await waitHealth("http://127.0.0.1:4200/health", (body) => (body as { ok?: boolean }).ok === true, 2);
  if (!gatewayUp) {
    gateway = startTsx("gateway/src/index.ts", {});
    if (!(await waitHealth("http://127.0.0.1:4200/health", (body) => (body as { ok?: boolean }).ok === true))) {
      stop(gateway);
      throw new Error("Verifier gateway did not start.");
    }
  }

  const deployment = loadDeployment();
  const before = {
    agent: await balanceOf(deployment.agent),
    b: await balanceOf(deployment.providers.B.address),
    c: await balanceOf(deployment.providers.C.address),
  };

  const run = await executeTask({
    task: "Get ETH/USD price data",
    totalBudget: "0.05",
    maxPrice: "0.05",
    maxLatencyMs: 3000,
    maxAgeSec: 60,
    schema: ETH_USD_SCHEMA,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  });

  console.log(`\nRun ${run.id} status ${run.status}`);
  for (const order of run.orders) {
    console.log(
      `Order #${order.id} ${order.providerId} ${order.status} $${order.amountUsd} fund ${txUrl(order.fundingTx)} settle ${txUrl(order.settlementTx)}`,
    );
  }
  if (run.error) console.error(run.error);

  expect(run.orders.length === 2, `expected 2 orders, got ${run.orders.length}`);
  const [first, second] = run.orders;
  if (first && second) {
    expect(first.providerId === "B" && first.status === "REFUNDED", `first order was ${first.providerId} ${first.status}`);
    expect(second.providerId === "C" && second.status === "SETTLED", `second order was ${second.providerId} ${second.status}`);
    expect(first.id !== second.id, "reroute reused an order id");
    expect(first.fundingTx !== second.fundingTx && first.settlementTx !== second.settlementTx, "reroute reused a transaction");
    const onFirst = await readOrder(BigInt(first.id));
    const onSecond = await readOrder(BigInt(second.id));
    expect(Number(onFirst.status) === 3, `chain status of first order is ${onFirst.status}`);
    expect(Number(onSecond.status) === 2, `chain status of second order is ${onSecond.status}`);
    const evidence = readJson<{ committed?: { schemaOk?: boolean; freshnessOk?: boolean; ageSec?: number | null } }>(
      evidenceFile(first.id),
    );
    expect(evidence?.committed?.schemaOk === true, "Provider B schema did not pass");
    expect(evidence?.committed?.freshnessOk === false, "Provider B freshness did not fail");
    expect((evidence?.committed?.ageSec ?? 0) > 60, "Provider B timestamp was not stale");
  }
  const reputation = run.steps.filter((step) => step.kind === "reputation" && step.txHash);
  expect(reputation.length === 2, `expected 2 reputation transactions, got ${reputation.length}`);
  for (const step of reputation) console.log(`Reputation ${txUrl(step.txHash!)}`);

  const after = {
    agent: await balanceOf(deployment.agent),
    b: await balanceOf(deployment.providers.B.address),
    c: await balanceOf(deployment.providers.C.address),
  };
  expect(after.b === before.b, `Provider B balance changed by ${formatUsdc(after.b - before.b)}`);
  expect(after.c - before.c === 30_000n, `Provider C gained ${formatUsdc(after.c - before.c)}, expected 0.03`);
  expect(before.agent - after.agent === 30_000n, `Buyer spent ${formatUsdc(before.agent - after.agent)}, expected 0.03`);

  if (providers) console.log("Left the provider process running for the demo.");
  if (gateway) console.log("Left the gateway process running for the demo.");
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log("Prove passed: B refunded, C paid, balances match, reputation posted.");
}

main().catch((error) => {
  console.error(explain(error));
  process.exit(1);
});
