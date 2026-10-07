import { decodeEventLog, getAddress, maxUint256, type Address, type Hex, type TransactionReceipt } from "viem";
import { erc20Abi, escrowAbi, identityAbi, reputationAbi } from "../../config/abis.ts";
import { keccakJson } from "../../config/canonical.ts";
import { assertNetwork, publicClient, walletFrom, writeContract } from "../../config/clients.ts";
import { loadDeployment, requireKey, requireToken, type Deployment } from "../../config/env.ts";
import { explain } from "../../config/explain.ts";
import { evidenceFile, readJson, runFile, writeJson } from "../../config/files.ts";
import { formatUsdc, parseUsdc } from "../../config/money.ts";
import { addressUrl, monad, txUrl } from "../../config/monad.ts";
import { evaluateProviders, PRICE_FORMULA, REPUTATION_FORMULA, type ProviderInput } from "../../config/ranking.ts";
import { ETH_USD_TASK, parseTask } from "../../config/task.ts";
import { gatewayBase, SEEDS, providerUrl } from "../../config/providers.ts";
import { readOrder, readStats } from "./chain.ts";

export type TaskInput = {
  task: string;
  totalBudget: string;
  maxPrice: string;
  maxLatencyMs: number;
  maxAgeSec: number;
  schema: Record<string, unknown>;
  expiresAt: number;
  onlyIds?: string[];
};

export type RunStep = {
  kind: string;
  title: string;
  detail: string;
  txHash?: string;
  txUrl?: string;
  orderId?: string;
  at: string;
  data?: Record<string, string | number | boolean | null>;
  verdicts?: VerdictView[];
};

export type VerdictView = {
  index: number;
  signer: string;
  passed: boolean;
  latencyMs: number;
  signature: string;
  faulty: boolean;
};

export type RunOrder = {
  id: string;
  providerId: string;
  provider: string;
  amount: string;
  amountUsd: string;
  status: string;
  fundingTx: string;
  fundingUrl: string;
  settlementTx: string;
  settlementUrl: string;
  evidenceUrl: string;
  evidenceHash: string;
};

export type RunRecord = {
  id: string;
  status: "running" | "passed" | "failed";
  demoMode: boolean;
  rankingMode: "price" | "reputation";
  formula: string;
  input: TaskInput;
  steps: RunStep[];
  orders: RunOrder[];
  providersEvaluated: number;
  summary: {
    providersEvaluated: number;
    orders: number;
    successfulProvider: string | null;
    paid: string;
    refunded: string;
    netSpent: string;
    budgetRemaining: string;
    result: { symbol: string; price: number; timestamp: number } | null;
  } | null;
  startedAt: string;
  finishedAt?: string;
  error?: string;
};

type Card = ProviderInput & {
  agentId: string;
  url: string;
  price: string;
  demoStale: boolean;
};

const STATUS = ["NONE", "FUNDED", "SETTLED", "REFUNDED", "EXPIRED_REFUNDED"] as const;

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function now(): string {
  return new Date().toISOString();
}

function tx(hash: string): { txHash: string; txUrl: string } | Record<string, never> {
  return /^0x[0-9a-fA-F]{64}$/.test(hash) ? { txHash: hash, txUrl: txUrl(hash) } : {};
}

export function assertTaskInput(input: TaskInput): void {
  const budget = parseUsdc(input.totalBudget);
  const cap = parseUsdc(input.maxPrice);
  if (budget <= 0n || cap <= 0n) throw new Error("Budget and max price must be greater than zero.");
  if (!Number.isInteger(input.maxLatencyMs) || input.maxLatencyMs < 100 || input.maxLatencyMs > 30_000) {
    throw new Error("Latency must be an integer from 100 to 30000 ms.");
  }
  if (!Number.isInteger(input.maxAgeSec) || input.maxAgeSec < 1 || input.maxAgeSec > 3_600) {
    throw new Error("Freshness window must be an integer from 1 to 3600 seconds.");
  }
  if (!Number.isInteger(input.expiresAt) || input.expiresAt <= Math.floor(Date.now() / 1000) + 30) {
    throw new Error("Expiry must be at least 30 seconds in the future.");
  }
  const parsed = parseTask(input.task);
  if ("error" in parsed) throw new Error(parsed.error);
  if (!input.schema || typeof input.schema !== "object" || Array.isArray(input.schema)) {
    throw new Error("Schema must be a JSON object.");
  }
  keccakJson(input.schema);
}

function blank(input: TaskInput): RunRecord {
  return {
    id: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    status: "running",
    demoMode: false,
    rankingMode: "reputation",
    formula: REPUTATION_FORMULA,
    input,
    steps: [],
    orders: [],
    providersEvaluated: 0,
    summary: null,
    startedAt: now(),
  };
}

function save(run: RunRecord): void {
  writeJson(runFile(run.id), run);
}

function push(run: RunRecord, step: Omit<RunStep, "at">): void {
  run.steps.push({ ...step, at: now() });
  save(run);
}

function summarize(run: RunRecord, budget: bigint, result: RunRecord["summary"] extends infer S ? S extends { result: infer R } ? R : null : null): void {
  const paid = run.orders.filter((order) => order.status === "SETTLED").reduce((sum, order) => sum + BigInt(order.amount), 0n);
  const refunded = run.orders
    .filter((order) => order.status === "REFUNDED" || order.status === "EXPIRED_REFUNDED")
    .reduce((sum, order) => sum + BigInt(order.amount), 0n);
  const winner = run.orders.find((order) => order.status === "SETTLED");
  run.summary = {
    providersEvaluated: run.providersEvaluated,
    orders: run.orders.length,
    successfulProvider: winner?.providerId ?? null,
    paid: formatUsdc(paid),
    refunded: formatUsdc(refunded),
    netSpent: formatUsdc(paid),
    budgetRemaining: formatUsdc(budget - paid),
    result: result ?? null,
  };
  save(run);
}

async function loadCards(deployment: Deployment): Promise<Card[]> {
  const stats = await readStats(deployment);
  const cards: Card[] = [];
  for (const seed of SEEDS) {
    const saved = deployment.providers[seed.id];
    const response = await fetch(`${providerUrl(seed.port)}/card`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`Provider ${seed.id} did not answer on ${providerUrl(seed.port)}.`);
    const card = (await response.json()) as {
      address?: string;
      task?: string;
      price?: string;
      active?: boolean;
      demoStale?: boolean;
    };
    if (!card.address || getAddress(card.address) !== saved.address) {
      throw new Error(`Provider ${seed.id} advertised a different payment address than the deployment.`);
    }
    const price = String(card.price ?? "");
    const stat = stats.get(saved.address.toLowerCase());
    cards.push({
      id: seed.id,
      name: seed.name,
      address: saved.address,
      agentId: saved.agentId,
      url: providerUrl(seed.port),
      task: String(card.task ?? ""),
      price,
      priceAtomic: parseUsdc(price),
      active: Boolean(card.active),
      demoStale: Boolean(card.demoStale),
      successRate: stat?.successRate ?? 0,
      orders: stat?.orders ?? 0,
      verifiedVolumeAtomic: stat?.verifiedVolumeAtomic ?? 0n,
    });
  }
  return cards;
}

function createdOrderId(receipt: TransactionReceipt, escrow: Address): bigint {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== escrow.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: escrowAbi, data: log.data, topics: log.topics });
      if (decoded.eventName === "OrderCreated") return decoded.args.id;
    } catch {
      continue;
    }
  }
  throw new Error(`Transaction ${receipt.transactionHash} did not create an order.`);
}

async function postFeedback(args: {
  deployment: Deployment;
  provider: Card;
  orderId: bigint;
  amount: bigint;
  passed: boolean;
  evidenceHash: string;
  evidenceHashes: string[];
  signers: string[];
  settlementTx: string;
  latencyMs: number;
  freshnessOk: boolean;
  schemaOk: boolean;
  ageSec: number | null;
  maxAgeSec: number;
  verdicts: VerdictView[];
}): Promise<{ hash: Hex }> {
  const body = {
    amount: args.amount.toString(),
    escrow: args.deployment.escrow,
    evidenceHash: args.evidenceHash,
    evidenceHashes: args.evidenceHashes,
    freshnessOk: args.freshnessOk,
    latencyMs: args.latencyMs,
    orderId: args.orderId.toString(),
    passed: args.passed,
    schemaOk: args.schemaOk,
    settlementTx: args.settlementTx,
    signers: args.signers,
    token: monad.paymentToken.address,
  };
  const feedbackHash = keccakJson(body);
  const feedbackUri = `data:application/json,${encodeURIComponent(
    JSON.stringify({
      ageSec: args.ageSec,
      evidenceHashes: args.evidenceHashes,
      freshnessOk: args.freshnessOk,
      latencyMs: args.latencyMs,
      maxAgeSec: args.maxAgeSec,
      orderId: args.orderId.toString(),
      passed: args.passed,
      schemaOk: args.schemaOk,
      settlementTx: args.settlementTx,
      signers: args.signers,
      verdicts: args.verdicts,
    }),
  )}`;
  const { account, wallet } = walletFrom(requireKey("AGENT_PRIVATE_KEY"));
  if (account.address !== args.deployment.agent) throw new Error("Buyer key does not match the deployment.");
  const owner = (await publicClient().readContract({
    address: monad.erc8004.identityRegistry,
    abi: identityAbi,
    functionName: "ownerOf",
    args: [BigInt(args.provider.agentId)],
  })) as Address;
  if (getAddress(owner) === account.address) {
    throw new Error("Buyer owns this provider identity, so ERC-8004 rejects the feedback.");
  }
  const receipt = await writeContract({
    wallet,
    account,
    address: monad.erc8004.reputationRegistry,
    abi: reputationAbi,
    functionName: "giveFeedback",
    args: [
      BigInt(args.provider.agentId),
      args.passed ? 100n : 0n,
      0,
      "rova.settlement",
      args.passed ? "pass" : "fail",
      args.provider.url,
      feedbackUri,
      feedbackHash,
    ],
  });
  const existing = readJson<Record<string, unknown>>(evidenceFile(args.orderId.toString())) ?? {};
  writeJson(evidenceFile(args.orderId.toString()), {
    ...existing,
    feedbackBody: body,
    feedbackHash,
    feedbackTx: receipt.transactionHash,
  });
  return { hash: receipt.transactionHash };
}

async function runTask(run: RunRecord): Promise<RunRecord> {
  try {
    assertTaskInput(run.input);
    await assertNetwork();
    const deployment = loadDeployment();
    const parsed = parseTask(run.input.task);
    if ("error" in parsed) throw new Error(parsed.error);
    push(run, { kind: "parsed", title: "Task parsed", detail: parsed.taskId, data: { task: parsed.taskId } });

    const cards = await loadCards(deployment);
    run.demoMode = cards.find((card) => card.id === "B")?.demoStale === true;
    run.rankingMode = run.demoMode ? "price" : "reputation";
    run.formula = run.rankingMode === "price" ? PRICE_FORMULA : REPUTATION_FORMULA;
    run.providersEvaluated = cards.length;
    push(run, {
      kind: "found",
      title: "Providers found",
      detail: cards.map((card) => `${card.name} $${card.price}`).join(" · "),
      data: { count: cards.length },
    });

    const budget = parseUsdc(run.input.totalBudget);
    const cap = parseUsdc(run.input.maxPrice);
    const schemaHash = keccakJson(run.input.schema);
    const excluded = new Set<string>();
    let spent = 0n;
    let result: { symbol: string; price: number; timestamp: number } | null = null;
    const buyer = walletFrom(requireKey("AGENT_PRIVATE_KEY"));
    if (buyer.account.address !== deployment.agent) throw new Error("Buyer key does not match the deployment.");

    for (let attempt = 0; attempt < cards.length; attempt += 1) {
      const remaining = budget - spent;
      const ranked = evaluateProviders(
        cards.filter((card) => !excluded.has(card.id)),
        {
          mode: run.rankingMode,
          maxPriceAtomic: cap,
          remainingAtomic: remaining,
          task: ETH_USD_TASK,
          onlyIds: run.input.onlyIds,
        },
      );
      const eligible = ranked.filter((provider) => provider.eligible);
      push(run, {
        kind: "ranked",
        title: "Ranking",
        detail: eligible.map((provider) => `${provider.id} $${formatUsdc(provider.priceAtomic)}`).join(" → ") || "none eligible",
        data: { count: eligible.length },
      });
      const next = eligible[0];
      if (!next) {
        push(run, {
          kind: "stopped",
          title: "No eligible provider left",
          detail: "Every remaining provider is outside the price, budget, or task filter.",
        });
        run.status = "failed";
        break;
      }
      const card = cards.find((item) => item.id === next.id);
      if (!card?.agentId) throw new Error(`Provider ${next.id} has no ERC-8004 identity. Run pnpm run setup.`);
      push(run, {
        kind: "selected",
        title: "Provider selected",
        detail: `${card.name} · $${card.price}`,
        data: { providerId: card.id, price: card.price },
      });

      const allowance = (await publicClient().readContract({
        address: monad.paymentToken.address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [buyer.account.address, deployment.escrow],
      })) as bigint;
      if (allowance < card.priceAtomic) {
        const approved = await writeContract({
          wallet: buyer.wallet,
          account: buyer.account,
          address: monad.paymentToken.address,
          abi: erc20Abi,
          functionName: "approve",
          args: [deployment.escrow, maxUint256],
        });
        push(run, {
          kind: "approved",
          title: "USDC approved for RovaEscrow",
          detail: "The buyer approved the escrow contract.",
          ...tx(approved.transactionHash),
        });
      }

      const receipt = await writeContract({
        wallet: buyer.wallet,
        account: buyer.account,
        address: deployment.escrow,
        abi: escrowAbi,
        functionName: "createOrder",
        args: [
          card.address,
          monad.paymentToken.address,
          card.priceAtomic,
          BigInt(run.input.maxLatencyMs),
          BigInt(run.input.maxAgeSec),
          schemaHash,
          BigInt(run.input.expiresAt),
        ],
      });
      const orderId = createdOrderId(receipt, deployment.escrow);
      const onchain = await readOrder(orderId);
      if (Number(onchain.status) !== 1) throw new Error(`Order ${orderId} was not funded.`);
      if (onchain.amount !== card.priceAtomic) throw new Error(`Order ${orderId} locked a different amount.`);
      push(run, {
        kind: "locked",
        title: `Order #${orderId} funded`,
        detail: `$${formatUsdc(onchain.amount)} locked in RovaEscrow`,
        orderId: orderId.toString(),
        ...tx(receipt.transactionHash),
        data: { amount: onchain.amount.toString() },
      });

      const gateway = await fetch(`${gatewayBase()}/execute`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${requireToken()}`,
        },
        body: JSON.stringify({
          orderId: orderId.toString(),
          providerUrl: card.url,
          providerAddress: card.address,
          fundingTx: receipt.transactionHash,
          schema: run.input.schema,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const payload = (await gateway.json()) as {
        error?: string;
        passed?: boolean;
        status?: string;
        evidenceHash?: string;
        settlementTx?: string;
        evidenceUrl?: string;
        latencyMs?: number;
        schemaOk?: boolean;
        freshnessOk?: boolean;
        ageSec?: number | null;
        reasons?: string[];
        response?: unknown;
        evidenceHashes?: string[];
        signers?: string[];
        verdicts?: VerdictView[];
      };
      if (!gateway.ok || !payload.settlementTx || !payload.status) {
        throw new Error(payload.error ?? `Verifier did not settle order ${orderId}.`);
      }
      const confirmed = await readOrder(orderId);
      const confirmedStatus = STATUS[Number(confirmed.status)] ?? "UNKNOWN";
      if (confirmedStatus !== payload.status) {
        throw new Error(`Chain status ${confirmedStatus} does not match the verifier report ${payload.status}.`);
      }

      const verdicts = payload.verdicts ?? [];
      if (verdicts.length > 0) {
        const agree = verdicts.filter((verdict) => verdict.passed === Boolean(payload.passed)).length;
        const side = payload.passed ? "PASS" : "FAIL";
        const outcome = confirmedStatus === "SETTLED" ? "paid" : "refunded";
        push(run, {
          kind: "quorum",
          title: `${agree} of ${verdicts.length} ${side}, ${outcome}`,
          detail: verdicts
            .map((verdict) => `#${verdict.index} ${verdict.passed ? "PASS" : "FAIL"} ${verdict.signer}`)
            .join(" · "),
          orderId: orderId.toString(),
          verdicts,
        });
      }
      push(run, {
        kind: "response",
        title: "Provider responded",
        detail: `${payload.latencyMs ?? "?"} ms`,
        orderId: orderId.toString(),
        data: { latencyMs: payload.latencyMs ?? null },
      });
      push(run, {
        kind: "schema",
        title: payload.schemaOk ? "Schema passed" : "Schema failed",
        detail: payload.schemaOk ? "Required fields match." : (payload.reasons ?? []).join("; "),
        orderId: orderId.toString(),
        data: { schemaOk: Boolean(payload.schemaOk) },
      });
      push(run, {
        kind: "freshness",
        title: payload.freshnessOk ? "Freshness passed" : "Freshness failed",
        detail:
          payload.ageSec === null || payload.ageSec === undefined
            ? "No usable timestamp."
            : `${payload.ageSec}s old, max ${run.input.maxAgeSec}s`,
        orderId: orderId.toString(),
        data: { freshnessOk: Boolean(payload.freshnessOk), ageSec: payload.ageSec ?? null },
      });

      const order: RunOrder = {
        id: orderId.toString(),
        providerId: card.id,
        provider: card.address,
        amount: confirmed.amount.toString(),
        amountUsd: formatUsdc(confirmed.amount),
        status: confirmedStatus,
        fundingTx: receipt.transactionHash,
        fundingUrl: txUrl(receipt.transactionHash),
        settlementTx: payload.settlementTx,
        settlementUrl: txUrl(payload.settlementTx),
        evidenceUrl: payload.evidenceUrl ?? `${gatewayBase()}/evidence/${orderId}`,
        evidenceHash: payload.evidenceHash ?? "",
      };
      run.orders.push(order);

      if (confirmedStatus === "SETTLED") {
        push(run, {
          kind: "paid",
          title: "VERIFIED / PAID",
          detail: `${card.name} received $${order.amountUsd}`,
          orderId: order.id,
          ...tx(payload.settlementTx),
        });
        spent += confirmed.amount;
        const body = payload.response;
        if (body && typeof body === "object" && !Array.isArray(body)) {
          const record = body as Record<string, unknown>;
          if (record.symbol === "ETH/USD" && typeof record.price === "number" && typeof record.timestamp === "number") {
            result = { symbol: "ETH/USD", price: record.price, timestamp: record.timestamp };
          }
        }
      } else if (confirmedStatus === "REFUNDED" || confirmedStatus === "EXPIRED_REFUNDED") {
        push(run, {
          kind: "refunded",
          title: "SLA FAILED / REFUNDED",
          detail: `$${order.amountUsd} returned to the buyer`,
          orderId: order.id,
          ...tx(payload.settlementTx),
        });
      } else {
        throw new Error(`Order ${orderId} ended as ${confirmedStatus}.`);
      }

      try {
        const feedback = await postFeedback({
          deployment,
          provider: card,
          orderId,
          amount: confirmed.amount,
          passed: confirmedStatus === "SETTLED",
          evidenceHash: order.evidenceHash,
          evidenceHashes: payload.evidenceHashes ?? [],
          signers: payload.signers ?? [],
          settlementTx: payload.settlementTx,
          latencyMs: payload.latencyMs ?? 0,
          freshnessOk: Boolean(payload.freshnessOk),
          schemaOk: Boolean(payload.schemaOk),
          ageSec: payload.ageSec ?? null,
          maxAgeSec: run.input.maxAgeSec,
          verdicts,
        });
        push(run, {
          kind: "reputation",
          title: "ERC-8004 reputation updated",
          detail: confirmedStatus === "SETTLED" ? "Feedback value 100, tag pass." : "Feedback value 0, tag fail.",
          orderId: order.id,
          ...tx(feedback.hash),
          data: { agentId: card.agentId },
        });
      } catch (error) {
        push(run, {
          kind: "error",
          title: "Reputation update failed",
          detail: explain(error),
          orderId: order.id,
        });
      }

      summarize(run, budget, result);
      if (confirmedStatus === "SETTLED") {
        run.status = "passed";
        break;
      }
      excluded.add(card.id);
      const more = cards.some((item) => !excluded.has(item.id));
      if (more && attempt < cards.length - 1) {
        push(run, {
          kind: "reroute",
          title: "Automatic reroute",
          detail: `${card.name} is excluded. Rova will open a new order with the next provider.`,
          data: { excluded: card.id },
        });
      }
    }

    if (run.status === "running") run.status = "failed";
    summarize(run, budget, result);
    run.finishedAt = now();
    save(run);
    return run;
  } catch (error) {
    push(run, { kind: "error", title: "Run stopped", detail: explain(error) });
    run.status = "failed";
    run.error = explain(error);
    run.finishedAt = now();
    save(run);
    return run;
  }
}

export function startRun(input: TaskInput): RunRecord {
  assertTaskInput(input);
  const run = blank(input);
  save(run);
  void enqueue(() => runTask(run));
  return run;
}

export function executeTask(input: TaskInput): Promise<RunRecord> {
  assertTaskInput(input);
  const run = blank(input);
  save(run);
  return enqueue(() => runTask(run));
}

export function readRun(id: string): RunRecord | null {
  return readJson<RunRecord>(runFile(id));
}

export async function currentRankings(maxPrice: string, budget: string) {
  await assertNetwork();
  const deployment = loadDeployment();
  const cards = await loadCards(deployment);
  const demoMode = cards.some((card) => card.id === "B" && card.demoStale);
  const mode = demoMode ? "price" : "reputation";
  const ranked = evaluateProviders(cards, {
    mode,
    maxPriceAtomic: parseUsdc(maxPrice),
    remainingAtomic: parseUsdc(budget),
    task: ETH_USD_TASK,
  });
  let place = 0;
  return {
    demoMode,
    mode,
    formula: mode === "price" ? PRICE_FORMULA : REPUTATION_FORMULA,
    providers: ranked.map((provider) => {
      const card = cards.find((item) => item.id === provider.id);
      const saved = deployment.providers[provider.id as "A" | "B" | "C"];
      return {
        id: provider.id,
        name: provider.name,
        address: provider.address,
        addressUrl: addressUrl(provider.address),
        agentId: card?.agentId ?? "",
        registerUrl: saved?.registerTx ? txUrl(saved.registerTx) : null,
        price: formatUsdc(provider.priceAtomic),
        successRate: provider.successRate,
        orders: provider.orders,
        verifiedVolume: formatUsdc(provider.verifiedVolumeAtomic),
        score: Number(provider.score.toFixed(4)),
        eligible: provider.eligible,
        reason: provider.reason,
        rank: provider.eligible ? ++place : null,
      };
    }),
  };
}
