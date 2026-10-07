import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getAddress, isAddress, type Address } from "viem";
import { assertNetwork } from "../../config/clients.ts";
import { loadDeployment, requireToken } from "../../config/env.ts";
import { explain } from "../../config/explain.ts";
import { VERIFIER_PORTS, faultyVerifierIndex } from "../../config/providers.ts";
import { assertEscrowMatchesDeployment, verifierAccount } from "../../config/quorum.ts";
import { judgeOrder } from "./verdict.ts";
import type { SimpleSchema } from "./verify.ts";

const index = Number(process.env.VERIFIER_INDEX);
if (!Number.isInteger(index) || index < 1 || index > 3) {
  console.error("VERIFIER_INDEX must be 1, 2, or 3.");
  process.exit(1);
}

const port = Number(process.env.VERIFIER_PORT ?? VERIFIER_PORTS[index - 1]);
const signer = verifierAccount(index).address;
const app = new Hono();

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "verifier",
    index,
    signer,
    faulty: faultyVerifierIndex() === index,
  }),
);

app.post("/verdict", async (c) => {
  try {
    if (c.req.header("authorization") !== `Bearer ${requireToken()}`) {
      return c.json({ error: "Verifier refused the caller." }, 401);
    }
    const body = await c.req.json();
    if (!isAddress(body.providerAddress)) throw new Error("provider address is invalid");
    const schema = body.schema as SimpleSchema;
    if (!schema || typeof schema !== "object") throw new Error("schema is required");
    const deployment = loadDeployment();
    const providerAddress = getAddress(body.providerAddress as Address);
    const providerUrl = String(body.providerUrl ?? "");
    const known = Object.values(deployment.providers).find((provider) => provider.url === providerUrl);
    if (!known || getAddress(known.address) !== providerAddress) {
      throw new Error("Provider is not one of the seeded Rova providers.");
    }
    const verdict = await judgeOrder({
      index,
      orderId: BigInt(body.orderId),
      providerUrl,
      providerAddress,
      fundingTx: String(body.fundingTx ?? ""),
      schema,
      deployment,
    });
    return c.json(verdict);
  } catch (error) {
    return c.json({ error: explain(error) }, 500);
  }
});

await assertNetwork();
await assertEscrowMatchesDeployment();
if (getAddress(signer) !== getAddress(verifierAccount(index).address)) {
  throw new Error("Verifier signer changed during startup.");
}
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  const faulty = faultyVerifierIndex() === index ? " faulty" : "";
  console.log(`verifier ${index} http://127.0.0.1:${info.port} ${signer}${faulty}`);
});
