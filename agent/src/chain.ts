import { getAddress, parseAbiItem, type Address, type Hex } from "viem";
import { escrowAbi, ORDER_STATUS, reputationAbi } from "../../config/abis.ts";
import { publicClient } from "../../config/clients.ts";
import { evidenceFile, readJson } from "../../config/files.ts";
import { loadDeployment, type Deployment } from "../../config/env.ts";
import { formatUsdc } from "../../config/money.ts";
import { monad, txUrl } from "../../config/monad.ts";
import { gatewayBase } from "../../config/providers.ts";

const settledEvent = parseAbiItem(
  "event OrderSettled(uint256 indexed id, address indexed provider, uint256 amount, bytes32 evidenceHash)",
);
const refundedEvent = parseAbiItem(
  "event OrderRefunded(uint256 indexed id, address indexed agent, uint256 amount, bytes32 evidenceHash)",
);
const expiredEvent = parseAbiItem(
  "event OrderExpiredRefunded(uint256 indexed id, address indexed agent, uint256 amount)",
);
const createdEvent = parseAbiItem(
  "event OrderCreated(uint256 indexed id, address indexed agent, address indexed provider, address token, uint256 amount, uint256 maxLatencyMs, uint256 maxAgeSec, bytes32 schemaHash, uint256 expiresAt)",
);

type EvidenceFile = {
  committed?: {
    latencyMs?: number;
    ageSec?: number | null;
    maxAgeSec?: number;
    freshnessOk?: boolean;
    schemaOk?: boolean;
  };
  feedbackTx?: string;
  evidenceHash?: string;
};

export type ProviderStats = {
  successRate: number;
  orders: number;
  verifiedVolumeAtomic: bigint;
};

type ChainLog = { args: Record<string, unknown>; transactionHash: Hex };

// Public Monad RPC rejects eth_getLogs when toBlock - fromBlock is greater than 100,
// and the same endpoint allows about 25 requests per second.
const LOG_SPAN = 100n;
const LOG_IN_FLIGHT = 4;
const LOGS_PER_SECOND = 8;

const logCache = new Map<string, { logs: ChainLog[]; next: bigint }>();
const logInflight = new Map<string, Promise<ChainLog[]>>();
const logTimes: number[] = [];
let logsInFlight = 0;

async function acquireLogSlot(): Promise<void> {
  while (true) {
    const now = Date.now();
    while (logTimes.length > 0 && now - logTimes[0] >= 1000) logTimes.shift();
    if (logsInFlight < LOG_IN_FLIGHT && logTimes.length < LOGS_PER_SECOND) {
      logsInFlight += 1;
      logTimes.push(now);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function releaseLogSlot(): void {
  logsInFlight -= 1;
}

export function logRanges(start: bigint, latest: bigint, span = LOG_SPAN): Array<[bigint, bigint]> {
  if (start > latest) return [];
  const ranges: Array<[bigint, bigint]> = [];
  for (let from = start; from <= latest; from += span + 1n) {
    const to = from + span > latest ? latest : from + span;
    ranges.push([from, to]);
  }
  return ranges;
}

async function scanLogs(key: string, event: unknown, deployment: Deployment): Promise<ChainLog[]> {
  const client = publicClient();
  const latest = await client.getBlockNumber();
  const cached = logCache.get(key) ?? { logs: [], next: BigInt(deployment.deployBlock) };
  if (cached.next > latest) return cached.logs;

  const ranges = logRanges(cached.next, latest);
  const batches = await Promise.all(
    ranges.map(async ([from, to]) => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await acquireLogSlot();
        try {
          return await client.getLogs({
            address: deployment.escrow,
            event: event as never,
            fromBlock: from,
            toBlock: to,
          });
        } catch (error) {
          const detail = error && typeof error === "object" && "details" in error ? String(error.details) : "";
          if (!/25\/sec|rate limit|429/i.test(detail) || attempt === 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        } finally {
          releaseLogSlot();
        }
      }
      throw new Error("eth_getLogs failed after retries.");
    }),
  );
  const fresh: ChainLog[] = [];
  for (const batch of batches) fresh.push(...(batch as unknown as ChainLog[]));

  const stored = { logs: cached.logs.concat(fresh), next: latest + 1n };
  logCache.set(key, stored);
  return stored.logs;
}

function rangedLogs(label: string, event: unknown, deployment: Deployment): Promise<ChainLog[]> {
  const key = `${deployment.escrow}:${label}`;
  const existing = logInflight.get(key);
  if (existing) return existing;
  const job = scanLogs(key, event, deployment).finally(() => {
    if (logInflight.get(key) === job) logInflight.delete(key);
  });
  logInflight.set(key, job);
  return job;
}

export async function readFeedback(agentId: string): Promise<{ orders: number; successRate: number }> {
  if (!agentId) return { orders: 0, successRate: 0 };
  const client = publicClient();
  const clients = (await client.readContract({
    address: monad.erc8004.reputationRegistry,
    abi: reputationAbi,
    functionName: "getClients",
    args: [BigInt(agentId)],
  })) as Address[];
  if (clients.length === 0) return { orders: 0, successRate: 0 };
  const result = (await client.readContract({
    address: monad.erc8004.reputationRegistry,
    abi: reputationAbi,
    functionName: "readAllFeedback",
    args: [BigInt(agentId), clients, "rova.settlement", "", false],
  })) as unknown[];
  const values = (Array.isArray(result) ? result[2] : []) as Array<bigint | number>;
  const orders = values.length;
  const successes = values.filter((value) => BigInt(value) > 0n).length;
  return { orders, successRate: orders === 0 ? 0 : successes / orders };
}

export async function readStats(deployment = loadDeployment()): Promise<Map<string, ProviderStats>> {
  const stats = new Map<string, ProviderStats>();
  const settled = await rangedLogs("settled", settledEvent, deployment);
  for (const id of ["A", "B", "C"] as const) {
    const provider = deployment.providers[id];
    const feedback = await readFeedback(provider.agentId);
    let volume = 0n;
    for (const log of settled) {
      if (getAddress(log.args.provider as Address) === provider.address) volume += BigInt(log.args.amount as bigint);
    }
    stats.set(provider.address.toLowerCase(), {
      successRate: feedback.successRate,
      orders: feedback.orders,
      verifiedVolumeAtomic: volume,
    });
  }
  return stats;
}

export async function readOrder(id: bigint) {
  const deployment = loadDeployment();
  return publicClient().readContract({
    address: deployment.escrow,
    abi: escrowAbi,
    functionName: "getOrder",
    args: [id],
  });
}

export type ActivityRow = {
  orderId: string;
  providerId: string;
  provider: string;
  amount: string;
  amountUsd: string;
  result: string;
  status: string;
  latencyMs: number | null;
  freshness: string;
  schema: string;
  evidenceUrl: string | null;
  txHash: string | null;
  txUrl: string | null;
  feedbackTx: string | null;
  feedbackUrl: string | null;
};

const RESULT: Record<string, string> = {
  FUNDED: "FUNDED",
  SETTLED: "VERIFIED / PAID",
  REFUNDED: "SLA FAILED / REFUNDED",
  EXPIRED_REFUNDED: "EXPIRED / REFUNDED",
};

export async function listActivity(): Promise<ActivityRow[]> {
  const deployment = loadDeployment();
  const [created, settled, refunded, expired] = await Promise.all([
    rangedLogs("created", createdEvent, deployment),
    rangedLogs("settled", settledEvent, deployment),
    rangedLogs("refunded", refundedEvent, deployment),
    rangedLogs("expired", expiredEvent, deployment),
  ]);
  const rows = new Map<string, {
    provider: Address;
    amount: bigint;
    status: string;
    txHash: Hex;
    feedbackTx?: string;
  }>();

  for (const log of created) {
    rows.set((log.args.id as bigint).toString(), {
      provider: getAddress(log.args.provider as Address),
      amount: log.args.amount as bigint,
      status: "FUNDED",
      txHash: log.transactionHash,
    });
  }
  for (const log of settled) {
    const row = rows.get((log.args.id as bigint).toString());
    if (!row) continue;
    row.status = "SETTLED";
    row.txHash = log.transactionHash;
    row.amount = log.args.amount as bigint;
  }
  for (const log of refunded) {
    const row = rows.get((log.args.id as bigint).toString());
    if (!row) continue;
    row.status = "REFUNDED";
    row.txHash = log.transactionHash;
  }
  for (const log of expired) {
    const row = rows.get((log.args.id as bigint).toString());
    if (!row) continue;
    row.status = "EXPIRED_REFUNDED";
    row.txHash = log.transactionHash;
  }

  const byAddress = new Map(Object.values(deployment.providers).map((provider) => [provider.address.toLowerCase(), provider]));
  return [...rows.entries()]
    .map(([orderId, row]) => {
      const provider = byAddress.get(row.provider.toLowerCase());
      const evidence = readJson<EvidenceFile>(evidenceFile(orderId));
      const age = evidence?.committed?.ageSec;
      const freshness =
        age === undefined
          ? "—"
          : age === null
            ? "no timestamp"
            : `${age}s / ${evidence?.committed?.maxAgeSec ?? "?"}s · ${evidence?.committed?.freshnessOk ? "pass" : "fail"}`;
      const feedbackTx = evidence?.feedbackTx ?? null;
      return {
        orderId,
        providerId: provider?.id ?? "?",
        provider: provider?.name ?? row.provider,
        amount: row.amount.toString(),
        amountUsd: formatUsdc(row.amount),
        result: RESULT[row.status] ?? row.status,
        status: ORDER_STATUS[ORDER_STATUS.indexOf(row.status as (typeof ORDER_STATUS)[number])] ?? row.status,
        latencyMs: evidence?.committed?.latencyMs ?? null,
        freshness,
        schema: evidence?.committed?.schemaOk === undefined ? "—" : evidence.committed.schemaOk ? "pass" : "fail",
        evidenceUrl: evidence ? `/evidence/${orderId}` : null,
        txHash: row.txHash,
        txUrl: txUrl(row.txHash),
        feedbackTx,
        feedbackUrl: feedbackTx ? txUrl(feedbackTx) : null,
      };
    })
    .sort((left, right) => Number(right.orderId) - Number(left.orderId));
}
