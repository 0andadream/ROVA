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
import { ensureCoordinator, ensureVerifiers, startTsx, stop, waitHealth } from "./services.ts";

loadEnv();
process.env.FAULTY_VERIFIER = "1";
process.env.DEMO_STALE = "1";

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
    throw new Error("The agent server is already running on port 4300. Stop pnpm demo before pnpm faulty.");
  }
  const cardUp = await waitHealth("http://127.0.0.1:4102/card", (body) => (body as { id?: string }).id === "B", 2);
  let providers = null;
  if (!cardUp) {
    providers = startTsx("providers/src/index.ts", { DEMO_STALE: "1" });
    if (!(await waitHealth("http://127.0.0.1:4102/card", (body) => (body as { demoStale?: boolean }).demoStale === true))) {
      stop(providers);
      throw new Error("Provider B did not start in stale mode.");
    }
  } else {
    const card = (await (await fetch("http://127.0.0.1:4102/card")).json()) as { demoStale?: boolean };
    if (card.demoStale !== true) throw new Error("Provider B is already running with fresh data. Stop it, then rerun pnpm faulty.");
  }

  const verifiers = await ensureVerifiers(1);
  const coordinator = await ensureCoordinator(1);
  const deployment = loadDeployment();
  const beforeBuyer = await balanceOf(deployment.agent);
  const beforeB = await balanceOf(deployment.providers.B.address);

  const run = await executeTask({
    task: "Get ETH/USD price data",
    totalBudget: "0.02",
    maxPrice: "0.05",
    maxLatencyMs: 3000,
    maxAgeSec: 60,
    schema: ETH_USD_SCHEMA,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  });

  console.log(`\nRun ${run.id} status ${run.status}`);
  for (const order of run.orders) {
    console.log(`Order #${order.id} ${order.providerId} ${order.status} settle ${txUrl(order.settlementTx)}`);
  }
  const order = run.orders[0];
  const quorum = run.steps.find((step) => step.kind === "quorum");
  const verdicts = quorum?.verdicts ?? [];
  const passes = verdicts.filter((verdict) => verdict.passed);
  const fails = verdicts.filter((verdict) => !verdict.passed);
  const evidence = order
    ? readJson<{
        committed?: { schemaOk?: boolean; freshnessOk?: boolean; passed?: boolean };
        quorum?: { passed?: boolean; signers?: string[] };
      }>(evidenceFile(order.id))
    : null;
  const onchain = order ? await readOrder(BigInt(order.id)) : null;
  const afterBuyer = await balanceOf(deployment.agent);
  const afterB = await balanceOf(deployment.providers.B.address);

  const failures: string[] = [];
  const expect = (condition: unknown, message: string) => {
    if (!condition) failures.push(message);
  };
  expect(run.orders.length === 1, `expected 1 order, got ${run.orders.length}`);
  expect(order?.providerId === "B" && order.status === "REFUNDED", `order was ${order?.providerId} ${order?.status}`);
  expect(quorum?.title === "2 of 3 FAIL, refunded", `quorum title was ${quorum?.title}`);
  expect(verdicts.length === 3, `expected 3 verdicts, got ${verdicts.length}`);
  expect(passes.length === 1 && passes[0]?.index === 1 && passes[0]?.faulty === true, "verifier 1 did not cast the only pass vote");
  expect(fails.length === 2 && fails.every((verdict) => verdict.faulty === false), "the other two verifiers did not vote fail");
  expect(new Set(verdicts.map((verdict) => verdict.signature)).size === 3, "verdict signatures were not distinct");
  expect(evidence?.committed?.schemaOk === true && evidence.committed.freshnessOk === false, "committed evidence was not a stale fail");
  expect(evidence?.quorum?.passed === false && evidence.quorum.signers?.length === 2, "settlement was not a 2-of-3 fail");
  expect(onchain && Number(onchain.status) === 3, `chain status is ${onchain?.status}`);
  expect(afterBuyer === beforeBuyer, `buyer balance changed by ${formatUsdc(afterBuyer - beforeBuyer)}`);
  expect(afterB === beforeB, `provider B balance changed by ${formatUsdc(afterB - beforeB)}`);
  for (const verdict of verdicts) {
    console.log(`#${verdict.index} ${verdict.passed ? "PASS" : "FAIL"} ${verdict.signer} ${verdict.signature.slice(0, 10)}…${verdict.signature.slice(-4)}`);
  }

  for (const child of [...verifiers, coordinator]) stop(child);
  if (providers) stop(providers);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log("Faulty verifier 1 voted PASS. The other two voted FAIL. The buyer was refunded.");
  process.exit(0);
}

main().catch((error) => {
  console.error(explain(error));
  process.exit(1);
});
