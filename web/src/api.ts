export type Meta = {
  ready: boolean;
  chainName: string;
  explorerName: string;
  explorerUrl: string;
  escrow: string | null;
  escrowUrl: string | null;
  token: { symbol: string; address: string; url: string; decimals: number };
  verifier: string | null;
  agent: string | null;
  agentUrl: string | null;
  registries: { identity: string; identityUrl: string; reputation: string; reputationUrl: string; version: string };
  x402: { usedForEscrow: boolean; facilitatorUrl: string; network: string };
  paymentPath: { approach: string; summary: string };
  schema: Record<string, unknown>;
  trust: { verifier: string; truth: string; providers: string; reputation: string };
  demoMode: boolean;
  demoBadge: string | null;
  providers: {
    id: string;
    name: string;
    price: string;
    address: string | null;
    addressUrl: string | null;
    agentId: string | null;
    registerUrl: string | null;
  }[];
};

export type Ranked = {
  id: string;
  name: string;
  address: string;
  addressUrl: string;
  agentId: string;
  registerUrl: string | null;
  price: string;
  successRate: number;
  orders: number;
  verifiedVolume: string;
  score: number;
  eligible: boolean;
  reason: string;
  rank: number | null;
};

export type Rankings = {
  demoMode: boolean;
  mode: "price" | "reputation";
  formula: string;
  providers: Ranked[];
};

export type RunStep = {
  kind: string;
  title: string;
  detail: string;
  txHash?: string;
  txUrl?: string;
  orderId?: string;
  at: string;
};

export type RunRecord = {
  id: string;
  status: "running" | "passed" | "failed";
  demoMode: boolean;
  rankingMode: "price" | "reputation";
  formula: string;
  steps: RunStep[];
  orders: { id: string; providerId: string; amountUsd: string; status: string; settlementUrl: string }[];
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
  error?: string;
};

export type ActivityRow = {
  orderId: string;
  provider: string;
  amountUsd: string;
  result: string;
  latencyMs: number | null;
  freshness: string;
  evidenceUrl: string | null;
  txHash: string | null;
  txUrl: string | null;
  feedbackUrl: string | null;
};

async function read<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export function loadMeta(): Promise<Meta> {
  return read("/api/meta");
}

export function loadRankings(maxPrice: string, budget: string): Promise<Rankings> {
  const query = new URLSearchParams({ maxPrice, budget });
  return read(`/api/rankings?${query}`);
}

export function loadActivity(): Promise<{ demoMode: boolean; demoBadge: string | null; rows: ActivityRow[] }> {
  return read("/api/activity");
}

export function startRun(input: {
  task: string;
  totalBudget: string;
  maxPrice: string;
  maxLatencyMs: number;
  maxAgeSec: number;
  expiryMinutes: number;
  schema: string;
}): Promise<{ runId: string }> {
  return read("/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function loadRun(id: string): Promise<RunRecord> {
  return read(`/api/runs/${id}`);
}

export function externalHref(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("/evidence/") || value.startsWith("/api/")) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return value;
    if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return value;
  } catch {
    return null;
  }
  return null;
}
