import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { escrowAbi, ORDER_STATUS } from "../../config/abis.ts";
import { keccakJson } from "../../config/canonical.ts";
import { assertNetwork, publicClient, walletFrom, writeContract } from "../../config/clients.ts";
import { evidenceFile, readJson, writeJson } from "../../config/files.ts";
import { loadDeployment, requireKey, requireToken } from "../../config/env.ts";
import { explain } from "../../config/explain.ts";
import { monad } from "../../config/monad.ts";
import { verifyResponse, type SimpleSchema } from "./verify.ts";

const port = Number(process.env.GATEWAY_PORT ?? 4200);
const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, service: "gateway" }));

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
    const providerAddress = getAddress(body.providerAddress);

    await assertNetwork();
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
    if (getAddress(order.provider) !== providerAddress) throw new Error("Order provider does not match the request.");
    if (getAddress(order.agent) !== deployment.agent) throw new Error("Order agent does not match the Rova buyer.");
    if (getAddress(order.token) !== getAddress(monad.paymentToken.address)) throw new Error("Order token is not the configured USDC.");
    const schemaHash = keccakJson(schema);
    if (schemaHash.toLowerCase() !== order.schemaHash.toLowerCase()) {
      throw new Error("Schema hash does not match the funded order.");
    }

    const block = await client.getBlock();
    const { account, wallet } = walletFrom(requireKey("VERIFIER_PRIVATE_KEY"));
    if (account.address !== deployment.verifier) throw new Error("Verifier key does not match the deployed escrow.");

    let settlementTx: Hex;
    let passed = false;
    let verification = verifyResponse({
      httpOk: false,
      bodyText: "",
      latencyMs: 0,
      maxLatencyMs: Number(order.maxLatencyMs),
      maxAgeSec: Number(order.maxAgeSec),
      nowSec: Number(block.timestamp),
      schema,
    });

    if (block.timestamp > order.expiresAt) {
      const sent = await writeContract({
        wallet,
        account,
        address: deployment.escrow,
        abi: escrowAbi,
        functionName: "refundExpired",
        args: [orderId],
      });
      settlementTx = sent.transactionHash;
      verification = {
        ...verification,
        reasons: ["order expired before the provider response"],
      };
    } else {
      const started = Date.now();
      let httpOk = false;
      let bodyText = "";
      let fetchError = "";
      try {
        const response = await fetch(`${providerUrl}/task`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            orderId: orderId.toString(),
            fundingTx,
            task: "eth-usd",
          }),
          signal: AbortSignal.timeout(Number(order.maxLatencyMs) + 1500),
        });
        httpOk = response.ok;
        bodyText = await response.text();
      } catch (error) {
        httpOk = false;
        bodyText = "";
        fetchError = explain(error);
      }
      const finished = Date.now();
      verification = verifyResponse({
        httpOk,
        bodyText,
        latencyMs: finished - started,
        maxLatencyMs: Number(order.maxLatencyMs),
        maxAgeSec: Number(order.maxAgeSec),
        nowSec: Math.floor(finished / 1000),
        schema,
      });
      if (fetchError) verification.reasons.push(fetchError);
      passed = verification.ok;
      const committed = {
        ageSec: verification.ageSec,
        amount: order.amount.toString(),
        freshnessOk: verification.freshnessOk,
        latencyMs: verification.latencyMs,
        latencyOk: verification.latencyOk,
        maxAgeSec: Number(order.maxAgeSec),
        maxLatencyMs: Number(order.maxLatencyMs),
        nonEmpty: verification.nonEmpty,
        orderId: orderId.toString(),
        passed,
        provider: providerAddress,
        reasons: verification.reasons,
        requestOk: verification.requestOk,
        response: verification.response,
        schemaOk: verification.schemaOk,
        timestamp: verification.timestamp,
      };
      const evidenceHash = keccakJson(committed);
      const sent = await writeContract({
        wallet,
        account,
        address: deployment.escrow,
        abi: escrowAbi,
        functionName: "settle",
        args: [orderId, passed, evidenceHash],
      });
      settlementTx = sent.transactionHash;
      const after = await client.readContract({
        address: deployment.escrow,
        abi: escrowAbi,
        functionName: "getOrder",
        args: [orderId],
      });
      const status = ORDER_STATUS[Number(after.status)] ?? "UNKNOWN";
      const expected = passed ? "SETTLED" : "REFUNDED";
      if (status !== expected) {
        throw new Error(`Settlement transaction ${settlementTx} left order ${orderId} as ${status}.`);
      }
      const record = {
        committed,
        evidenceHash,
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
        evidenceHash,
        settlementTx,
        evidenceUrl: `/evidence/${orderId}`,
        latencyMs: verification.latencyMs,
        schemaOk: verification.schemaOk,
        freshnessOk: verification.freshnessOk,
        ageSec: verification.ageSec,
        timestamp: verification.timestamp,
        reasons: verification.reasons,
        response: verification.response,
        providerId: known.id,
      });
    }

    const after = await client.readContract({
      address: deployment.escrow,
      abi: escrowAbi,
      functionName: "getOrder",
      args: [orderId],
    });
    const status = ORDER_STATUS[Number(after.status)] ?? "UNKNOWN";
    const committed = {
      ageSec: null,
      amount: order.amount.toString(),
      freshnessOk: false,
      latencyMs: 0,
      latencyOk: false,
      maxAgeSec: Number(order.maxAgeSec),
      maxLatencyMs: Number(order.maxLatencyMs),
      nonEmpty: false,
      orderId: orderId.toString(),
      passed: false,
      provider: providerAddress,
      reasons: verification.reasons,
      requestOk: false,
      response: null,
      schemaOk: false,
      timestamp: null,
    };
    const record = {
      committed,
      evidenceHash: keccakJson(committed),
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
      evidenceHash: record.evidenceHash,
      settlementTx,
      evidenceUrl: `/evidence/${orderId}`,
      latencyMs: 0,
      schemaOk: false,
      freshnessOk: false,
      ageSec: null,
      timestamp: null,
      reasons: verification.reasons,
      response: null,
      providerId: known.id,
    });
  } catch (error) {
    return c.json({ error: explain(error) }, 500);
  }
});

await assertNetwork();
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`gateway http://127.0.0.1:${info.port}`);
});
