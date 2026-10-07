import { getAddress, type Address } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { escrowAbi } from "./abis.ts";
import { publicClient } from "./clients.ts";
import { loadDeployment, requireKey, type Deployment } from "./env.ts";
import { explain } from "./explain.ts";
import { QUORUM_THRESHOLD, VERIFIER_COUNT } from "./providers.ts";

export const verdictTypes = {
  Verdict: [
    { name: "orderId", type: "uint256" },
    { name: "passed", type: "bool" },
    { name: "evidenceHash", type: "bytes32" },
  ],
} as const;

export function verifierAccount(index: number): PrivateKeyAccount {
  if (!Number.isInteger(index) || index < 1 || index > VERIFIER_COUNT) {
    throw new Error(`Verifier index ${index} is outside 1..${VERIFIER_COUNT}.`);
  }
  return privateKeyToAccount(requireKey(`VERIFIER_PRIVATE_KEY_${index}`));
}

export async function assertEscrowMatchesDeployment(deployment: Deployment = loadDeployment()): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await readEscrowDeployment(deployment);
      return;
    } catch (error) {
      last = error;
      if (!/15\/sec|rate limit|429|timeout/i.test(explain(error)) || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw last;
}

async function readEscrowDeployment(deployment: Deployment): Promise<void> {
  const client = publicClient();
  const code = await client.getCode({ address: deployment.escrow });
  if (!code || code === "0x") {
    throw new Error(`Escrow ${deployment.escrow} has no code. Run pnpm run setup.`);
  }
  const threshold = Number(
    await client.readContract({ address: deployment.escrow, abi: escrowAbi, functionName: "threshold" }),
  );
  const count = Number(
    await client.readContract({ address: deployment.escrow, abi: escrowAbi, functionName: "verifierCount" }),
  );
  if (threshold !== deployment.threshold || threshold !== QUORUM_THRESHOLD) {
    throw new Error(`Escrow threshold is ${threshold}. The deployment file says ${deployment.threshold}.`);
  }
  if (count !== VERIFIER_COUNT || deployment.verifiers.length !== VERIFIER_COUNT) {
    throw new Error(`Escrow has ${count} verifiers. Rova is configured for ${VERIFIER_COUNT}.`);
  }
  const onchain: Address[] = [];
  for (let index = 0; index < count; index += 1) {
    const verifier = (await client.readContract({
      address: deployment.escrow,
      abi: escrowAbi,
      functionName: "verifierAt",
      args: [BigInt(index)],
    })) as Address;
    onchain.push(getAddress(verifier));
  }
  const configured = deployment.verifiers.map((verifier) => getAddress(verifier)).sort();
  const found = [...onchain].sort();
  if (configured.join(",") !== found.join(",")) {
    throw new Error("The escrow verifier set does not match config/deployments.json.");
  }
  const fromKeys = [1, 2, 3].map((index) => getAddress(verifierAccount(index).address)).sort();
  if (fromKeys.join(",") !== configured.join(",")) {
    throw new Error("VERIFIER_PRIVATE_KEY_1..3 do not match the deployed verifier set.");
  }
}
