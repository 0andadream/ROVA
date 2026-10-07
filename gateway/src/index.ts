import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { escrowAbi, ORDER_STATUS } from "../../config/abis.ts";
import { publicClient, walletFrom, writeContract } from "../../config/clients.ts";
import { assertNetwork } from "../../config/clients.ts";
import { evidenceFile, readJson, writeJson } from "../../config/files.ts";
import { loadDeployment, requireKey, requireToken } from "../../config/env.ts";
import { explain } from "../../config/explain.ts";
import { monad } from "../../config/monad.ts";
import { GATEWAY_PORT, QUORUM_THRESHOLD, VERIFIER_COUNT, faultyBadge, verifierUrl } from "../../config/providers.ts";
import { assertEscrowMatchesDeployment } from "../../config/quorum.ts";
import type { Verdict } from "./verdict.ts";
import type { SimpleSchema } from "./verify.ts";

const port = Number(process.env.GATEWAY_PORT ?? GATEWAY_PORT);
const app = new Hono();

function errorName(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const record = error as { errorName?: string; cause?: unknown };
  if (typeof record.errorName === "string") return record.errorName;
  return errorName(record.cause);
}

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "coordinator",
    threshold: QUORUM_THRESHOLD,
    verifiers: VERIFIER_COUNT,
    faultyBadge: faultyBadge(),
  }),
);

app.get("/evidence/:orderId", (c) => {
  const record = readJson(evidenceFile(c.req.param("orderId")));
  if (!record) return c.json({ error: "No evidence for that order." }, 404);
  return c.json(record);
});

app.post("/execute", async (c) => {
  try {
    if (c.req.header("authorization") !== `Bearer ${requireToken()}`) {
      return c.json({ error: "Verifier gateway refused the caller." }, 401);
    }
    const body = await c.req.json();
    const orderId = BigInt(body.orderId);
    const providerUrl = String(body.providerUrl ?? "");
    const fundingTx = String(body.fundingTx ?? "");
    const schema = body.schema as SimpleSchema;
    if (!schema || typeof schema !== "object") throw new Error("schema is required");
    if (!isAddress(body.providerAddress)) throw new Error("provider address is invalid");
    const providerAddress = getAddress(body.providerAddress as Address);
    const deployment = loadDeployment();
    const known = Object.values(deployment.providers).find((provider) => provider.url === providerUrl);
    if (!known || getAddress(known.address) !== providerAddress) {
      throw new Error("Provider is not one of the seeded Rova providers.");
    }

    const client = publicClient();
    const order = await client.readContract({
      address: deployment.escrow,
      abi: escrowAbi,
      functionName: "getOrder",
      args: [orderId],
    });
    if (Number(order.status) !== 1) throw new Error(`Order ${orderId} is not funded.`);
    const buyer = walletFrom(requireKey("AGENT_PRIVATE_KEY"));
    if (buyer.account.address !== deployment.agent) throw new Error("Buyer key does not match the deployment.");

    const relay = async (functionName: "settle" | "refundExpired", args: readonly unknown[]) =>
      writeContract({
        wallet: buyer.wallet,
        account: buyer.account,
        address: deployment.escrow,
        abi: escrowAbi,
        functionName,
        args,
      });

    const readStatus = async () => {
      const after = await client.readContract({
        address: deployment.escrow,
        abi: escrowAbi,
        functionName: "getOrder",
        args: [orderId],
      });
      return ORDER_STATUS[Number(after.status)] ?? "UNKNOWN";
    };

    const finishExpired = async (reasons: string[]) => {
      let settlementTx: Hex;
      try {
        const sent = await relay("refundExpired", [orderId]);
        settlementTx = sent.transactionHash;
      } catch (error) {
        if (errorName(error) !== "NotExpired" && errorName(error) !== "InvalidOrder") throw error;
        const current = await readStatus();
        if (current !== "EXPIRED_REFUNDED" && current !== "REFUNDED" && current !== "SETTLED") throw error;
        throw new Error(`Order ${orderId} is already ${current}.`);
      }
      const status = await readStatus();
      if (status !== "EXPIRED_REFUNDED") {
        throw new Error(`refundExpired left order ${orderId} as ${status}.`);
      }
      const record = {
        committed: {
          ageSec: null,
          freshnessOk: false,
          latencyMs: 0,
          schemaOk: false,
          passed: false,
          reasons,
          orderId: orderId.toString(),
        },
        verdicts: [],
        quorum: null,
        settlementTx,
        fundingTx,
        status,
        providerId: known.id,
        providerUrl,
        recordedAt: new Date().toISOString(),
      };
      writeJson(evidenceFile(orderId.toString()), record);
      return c.json({
        passed: false,
        status,
        evidenceHash: null,
        evidenceHashes: [],
        signers: [],
        settlementTx,
        evidenceUrl: `/evidence/${orderId}`,
        latencyMs: 0,
        schemaOk: false,
        freshnessOk: false,
        ageSec: null,
        timestamp: null,
        reasons,
        response: null,
        providerId: known.id,
        verdicts: [],
      });
    };

    const block = await client.getBlock();
    if (block.timestamp > order.expiresAt) {
      return await finishExpired(["order expired before the verifiers were asked"]);
    }

    const token = requireToken();
    const requests = [1, 2, 3].map(async (index) => {
      const response = await fetch(`${verifierUrl(index)}/verdict`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          orderId: orderId.toString(),
          providerUrl,
          providerAddress,
          fundingTx,
          schema,
        }),
        signal: AbortSignal.timeout(Number(order.maxLatencyMs) + 8_000),
      });
      const payload = (await response.json()) as Verdict & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Verifier ${index} refused the order.`);
      return payload;
    });
    const settledAttempts = await Promise.allSettled(requests);
    const verdicts: Verdict[] = [];
    const failures: string[] = [];
    for (const attempt of settledAttempts) {
      if (attempt.status === "fulfilled") verdicts.push(attempt.value);
      else failures.push(explain(attempt.reason));
    }
    const unique = new Map<string, Verdict>();
    for (const verdict of verdicts) unique.set(getAddress(verdict.signer), verdict);
    const distinct = [...unique.values()];
    const groups = new Map<string, Verdict[]>();
    for (const verdict of distinct) {
      const key = verdict.passed ? "pass" : "fail";
      groups.set(key, [...(groups.get(key) ?? []), verdict]);
    }
    const winners = [...groups.values()].find((group) => group.length >= QUORUM_THRESHOLD);
    if (!winners) {
      const now = await client.getBlock();
      if (now.timestamp > order.expiresAt) {
        return await finishExpired(["quorum missed the order expiry", ...failures]);
      }
      throw new Error(
        `No ${QUORUM_THRESHOLD}-of-${VERIFIER_COUNT} quorum. Votes: ${distinct
          .map((verdict) => `#${verdict.index} ${verdict.passed ? "pass" : "fail"}`)
          .join(", ") || "none"}. ${failures.join(" ")}`.trim(),
      );
    }
    winners.sort((left, right) => (left.signer.toLowerCase() < right.signer.toLowerCase() ? -1 : 1));
    const passed = winners[0].passed;
    const evidenceHashes = winners.map((verdict) => verdict.evidenceHash);
    const signatures = winners.map((verdict) => verdict.signature);
    let settlementTx: Hex;
    try {
      const sent = await relay("settle", [orderId, passed, evidenceHashes, signatures]);
      settlementTx = sent.transactionHash;
    } catch (error) {
      if (errorName(error) === "Expired") {
        return await finishExpired(["settlement reverted because the order expired during probing"]);
      }
      throw error;
    }
    const status = await readStatus();
    const expected = passed ? "SETTLED" : "REFUNDED";
    if (status !== expected) {
      throw new Error(`Settlement transaction ${settlementTx} left order ${orderId} as ${status}.`);
    }
    const representative = winners[0];
    const record = {
      committed: representative.evidence,
      evidenceHash: representative.evidenceHash,
      evidenceHashes,
      signers: winners.map((verdict) => verdict.signer),
      verdicts: distinct,
      quorum: {
        passed,
        threshold: QUORUM_THRESHOLD,
        signers: winners.map((verdict) => verdict.signer),
        evidenceHashes,
      },
      settlementTx,
      fundingTx,
      status,
      providerId: known.id,
      providerUrl,
      recordedAt: new Date().toISOString(),
    };
    writeJson(evidenceFile(orderId.toString()), record);
    return c.json({
      passed,
      status,
      evidenceHash: representative.evidenceHash,
      evidenceHashes,
      signers: winners.map((verdict) => verdict.signer),
      settlementTx,
      evidenceUrl: `/evidence/${orderId}`,
      latencyMs: representative.latencyMs,
      schemaOk: representative.schemaOk,
      freshnessOk: representative.freshnessOk,
      ageSec: representative.ageSec,
      timestamp: representative.timestamp,
      reasons: representative.reasons,
      response: representative.response,
      providerId: known.id,
      verdicts: distinct.map((verdict) => ({
        index: verdict.index,
        signer: verdict.signer,
        passed: verdict.passed,
        latencyMs: verdict.latencyMs,
        signature: verdict.signature,
        faulty: verdict.faulty,
      })),
    });
  } catch (error) {
    return c.json({ error: explain(error) }, 500);
  }
});

await assertNetwork();
await assertEscrowMatchesDeployment();
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`coordinator http://127.0.0.1:${info.port}`);
  const badge = faultyBadge();
  if (badge) console.log(badge);
});
