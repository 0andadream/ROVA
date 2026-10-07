import { getAddress, type Address, type Hex } from "viem";
import { escrowAbi } from "../../config/abis.ts";
import { keccakJson } from "../../config/canonical.ts";
import { publicClient } from "../../config/clients.ts";
import { loadDeployment, type Deployment } from "../../config/env.ts";
import { explain } from "../../config/explain.ts";
import { monad } from "../../config/monad.ts";
import { faultyVerifierIndex } from "../../config/providers.ts";
import { verdictTypes, verifierAccount } from "../../config/quorum.ts";
import { verifyResponse, type SimpleSchema } from "./verify.ts";

export type Verdict = {
  index: number;
  signer: Address;
  passed: boolean;
  evidenceHash: Hex;
  evidence: Record<string, unknown>;
  signature: Hex;
  latencyMs: number;
  schemaOk: boolean;
  freshnessOk: boolean;
  ageSec: number | null;
  timestamp: number | null;
  reasons: string[];
  response: unknown;
  faulty: boolean;
};

export async function judgeOrder(args: {
  index: number;
  orderId: bigint;
  providerUrl: string;
  providerAddress: Address;
  fundingTx: string;
  schema: SimpleSchema;
  deployment?: Deployment;
}): Promise<Verdict> {
  const deployment = args.deployment ?? loadDeployment();
  const client = publicClient();
  const order = await client.readContract({
    address: deployment.escrow,
    abi: escrowAbi,
    functionName: "getOrder",
    args: [args.orderId],
  });
  if (Number(order.status) !== 1) throw new Error(`Order ${args.orderId} is not funded.`);
  if (getAddress(order.provider) !== args.providerAddress) throw new Error("Order provider does not match the request.");
  if (getAddress(order.agent) !== deployment.agent) throw new Error("Order agent does not match the Rova buyer.");
  if (getAddress(order.token) !== getAddress(monad.paymentToken.address)) throw new Error("Order token is not the configured USDC.");
  const schemaHash = keccakJson(args.schema);
  if (schemaHash.toLowerCase() !== order.schemaHash.toLowerCase()) {
    throw new Error("Schema hash does not match the funded order.");
  }
  const block = await client.getBlock();
  if (block.timestamp > order.expiresAt) {
    throw new Error("Order expired before this verifier probed the provider.");
  }

  const started = Date.now();
  let httpOk = false;
  let bodyText = "";
  let fetchError = "";
  try {
    const response = await fetch(`${args.providerUrl}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderId: args.orderId.toString(),
        fundingTx: args.fundingTx,
        task: "eth-usd",
      }),
      signal: AbortSignal.timeout(Number(order.maxLatencyMs) + 1500),
    });
    httpOk = response.ok;
    bodyText = await response.text();
  } catch (error) {
    fetchError = explain(error);
  }
  const finished = Date.now();
  const verification = verifyResponse({
    httpOk,
    bodyText,
    latencyMs: finished - started,
    maxLatencyMs: Number(order.maxLatencyMs),
    maxAgeSec: Number(order.maxAgeSec),
    nowSec: Math.floor(finished / 1000),
    schema: args.schema,
  });
  if (fetchError) verification.reasons.push(fetchError);

  const faulty = faultyVerifierIndex() === args.index;
  const passed = faulty ? true : verification.ok;
  const account = verifierAccount(args.index);
  const evidence = {
    ageSec: verification.ageSec,
    amount: order.amount.toString(),
    freshnessOk: verification.freshnessOk,
    latencyMs: verification.latencyMs,
    latencyOk: verification.latencyOk,
    maxAgeSec: Number(order.maxAgeSec),
    maxLatencyMs: Number(order.maxLatencyMs),
    nonEmpty: verification.nonEmpty,
    orderId: args.orderId.toString(),
    passed,
    provider: args.providerAddress,
    reasons: verification.reasons,
    requestOk: verification.requestOk,
    response: verification.response,
    schemaOk: verification.schemaOk,
    signer: account.address,
    timestamp: verification.timestamp,
    verifierIndex: args.index,
  };
  const evidenceHash = keccakJson(evidence);
  const signature = await account.signTypedData({
    domain: {
      name: "RovaEscrow",
      version: "1",
      chainId: monad.chainId,
      verifyingContract: deployment.escrow,
    },
    types: verdictTypes,
    primaryType: "Verdict",
    message: {
      orderId: args.orderId,
      passed,
      evidenceHash,
    },
  });
  return {
    index: args.index,
    signer: account.address,
    passed,
    evidenceHash,
    evidence,
    signature,
    latencyMs: verification.latencyMs,
    schemaOk: verification.schemaOk,
    freshnessOk: verification.freshnessOk,
    ageSec: verification.ageSec,
    timestamp: verification.timestamp,
    reasons: verification.reasons,
    response: verification.response,
    faulty,
  };
}
