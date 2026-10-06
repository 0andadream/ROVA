import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { monad } from "./monad.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, "..");

export function loadEnv(): void {
  const file = path.join(root, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const split = trimmed.indexOf("=");
    if (split < 0) continue;
    const key = trimmed.slice(0, split).trim();
    let value = trimmed.slice(split + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function requireKey(name: string): Hex {
  loadEnv();
  const value = process.env[name] ?? "";
  if (!isHex(value) || value.length !== 66) {
    throw new Error(`${name} is missing from .env. Run pnpm run setup.`);
  }
  return value;
}

export function requireToken(): string {
  loadEnv();
  const token = process.env.ROVA_GATEWAY_TOKEN ?? "";
  if (token.length < 16) throw new Error("ROVA_GATEWAY_TOKEN is missing from .env. Run pnpm run setup.");
  return token;
}

export type SeedProvider = {
  id: "A" | "B" | "C";
  name: string;
  address: Address;
  agentId: string;
  url: string;
  price: string;
  registerTx: string;
  uriTx: string;
};

export type Deployment = {
  chainId: number;
  escrow: Address;
  deployTx: Hex;
  deployBlock: string;
  verifier: Address;
  agent: Address;
  providers: Record<"A" | "B" | "C", SeedProvider>;
};

export const deploymentPath = path.join(root, "config", "deployments.json");

export function loadDeployment(): Deployment {
  if (!existsSync(deploymentPath)) {
    throw new Error("config/deployments.json is missing. Run pnpm run setup after the wallets have testnet MON and USDC.");
  }
  const parsed = JSON.parse(readFileSync(deploymentPath, "utf8")) as Deployment;
  if (parsed.chainId !== monad.chainId) {
    throw new Error(`Deployment chain ${parsed.chainId} does not match configured chain ${monad.chainId}.`);
  }
  if (!isAddress(parsed.escrow) || !isAddress(parsed.verifier) || !isAddress(parsed.agent)) {
    throw new Error("config/deployments.json has an invalid address.");
  }
  parsed.escrow = getAddress(parsed.escrow);
  parsed.verifier = getAddress(parsed.verifier);
  parsed.agent = getAddress(parsed.agent);
  for (const id of ["A", "B", "C"] as const) {
    const provider = parsed.providers[id];
    if (!provider || !isAddress(provider.address)) throw new Error(`Provider ${id} is missing from deployments.json.`);
    provider.address = getAddress(provider.address);
  }
  return parsed;
}

export function evidenceDir(): string {
  return path.join(root, "data", "evidence");
}

export function runsDir(): string {
  return path.join(root, "data", "runs");
}
