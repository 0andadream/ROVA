import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodeEventLog, formatEther, getAddress, isHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { erc20Abi, identityAbiForRegister } from "../config/abis.ts";
import { assertNetwork, publicClient, walletFrom, writeContract } from "../config/clients.ts";
import { deploymentPath, loadEnv, root, type Deployment, type SeedProvider } from "../config/env.ts";
import { explain } from "../config/explain.ts";
import { writeJson } from "../config/files.ts";
import { formatUsdc } from "../config/money.ts";
import { addressUrl, monad, txUrl } from "../config/monad.ts";
import { providerUrl, SEEDS } from "../config/providers.ts";

const QUORUM_KEYS = ["VERIFIER_PRIVATE_KEY_1", "VERIFIER_PRIVATE_KEY_2", "VERIFIER_PRIVATE_KEY_3"] as const;

const KEYS = [
  "VERIFIER_PRIVATE_KEY",
  ...QUORUM_KEYS,
  "AGENT_PRIVATE_KEY",
  "PROVIDER_A_PRIVATE_KEY",
  "PROVIDER_B_PRIVATE_KEY",
  "PROVIDER_C_PRIVATE_KEY",
] as const;

const MIN_MON = 20_000_000_000_000_000n;
const MIN_USDC = 50_000n;

function forgeBin(): string {
  const local = path.join(process.env.HOME ?? "", ".foundry", "bin", "forge");
  return existsSync(local) ? local : "forge";
}

function ensureEnv(): void {
  loadEnv();
  const file = path.join(root, ".env");
  const missing = KEYS.filter((name) => !process.env[name]);
  const invalid = KEYS.filter((name) => process.env[name] && (!isHex(process.env[name]!) || process.env[name]!.length !== 66));
  if (invalid.length > 0) {
    throw new Error(`${invalid.join(", ")} is set but is not a 32-byte hex key. Fix .env instead of overwriting it.`);
  }
  for (const name of missing) process.env[name] = generatePrivateKey();
  if ((process.env.ROVA_GATEWAY_TOKEN ?? "").length < 16) {
    process.env.ROVA_GATEWAY_TOKEN = randomBytes(24).toString("hex");
  }
  if (!process.env.DEMO_STALE) process.env.DEMO_STALE = "1";
  if (!existsSync(file) || missing.length > 0 || (process.env.ROVA_GATEWAY_TOKEN ?? "").length >= 16) {
    const lines = [
      ...KEYS.map((name) => `${name}=${process.env[name]}`),
      `ROVA_GATEWAY_TOKEN=${process.env.ROVA_GATEWAY_TOKEN}`,
      `DEMO_STALE=${process.env.DEMO_STALE}`,
      "",
    ];
    writeFileSync(file, lines.join("\n"), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  if (missing.length > 0) console.log(`Wrote ${missing.length} new key(s) to .env. The file is mode 0600 and is not committed.`);
}

function accounts(): Record<(typeof KEYS)[number], Address> {
  return Object.fromEntries(
    KEYS.map((name) => [name, privateKeyToAccount(process.env[name] as Hex).address]),
  ) as Record<(typeof KEYS)[number], Address>;
}

type ExistingFile = {
  escrow?: Address;
  deployTx?: Hex;
  deployBlock?: string;
  verifier?: string;
  identityOwner?: string;
  agent?: string;
  providers?: Partial<Record<"A" | "B" | "C", SeedProvider>>;
};

function readExisting(): ExistingFile | null {
  if (!existsSync(deploymentPath)) return null;
  return JSON.parse(readFileSync(deploymentPath, "utf8")) as ExistingFile;
}

async function quorumMatches(escrow: Address, verifiers: Address[], abi: readonly unknown[]): Promise<boolean> {
  const client = publicClient();
  try {
    const code = await client.getCode({ address: escrow });
    if (!code || code === "0x") return false;
    const [threshold, count, token] = await Promise.all([
      client.readContract({ address: escrow, abi, functionName: "threshold" }) as Promise<bigint | number>,
      client.readContract({ address: escrow, abi, functionName: "verifierCount" }) as Promise<bigint | number>,
      client.readContract({ address: escrow, abi, functionName: "paymentToken" }) as Promise<Address>,
    ]);
    if (Number(threshold) !== 2 || Number(count) !== 3) return false;
    if (getAddress(token) !== getAddress(monad.paymentToken.address)) return false;
    const onchain: Address[] = [];
    for (let index = 0; index < 3; index += 1) {
      const verifier = (await client.readContract({
        address: escrow,
        abi,
        functionName: "verifierAt",
        args: [BigInt(index)],
      })) as Address;
      onchain.push(getAddress(verifier));
    }
    return onchain.sort().join(",") === verifiers.map((verifier) => getAddress(verifier)).sort().join(",");
  } catch {
    return false;
  }
}

function forgePrepare(): void {
  const contracts = path.join(root, "contracts");
  if (!existsSync(path.join(contracts, "lib", "forge-std", "src", "Test.sol"))) {
    const installed = spawnSync(forgeBin(), ["install", "foundry-rs/forge-std", "--no-git"], {
      cwd: contracts,
      stdio: "inherit",
    });
    if (installed.status !== 0) throw new Error("forge install foundry-std failed.");
  }
  const built = spawnSync(forgeBin(), ["build"], { cwd: contracts, stdio: "inherit" });
  if (built.status !== 0) throw new Error("forge build failed.");
}

function agentDocument(agentId: string, name: string, endpoint: string): string {
  const document = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name,
    description: "Seeded Rova demo provider for ETH/USD. The Rova team registered this identity. It is not a public marketplace listing.",
    services: [{ name: "eth-usd", endpoint }],
    registrations: [
      {
        agentId: Number(agentId),
        agentRegistry: `eip155:${monad.chainId}:${monad.erc8004.identityRegistry}`,
      },
    ],
  };
  return `data:application/json,${encodeURIComponent(JSON.stringify(document))}`;
}

function registeredId(logs: { address: Address; data: Hex; topics: [] | [Hex, ...Hex[]] }[], registry: Address): bigint {
  for (const log of logs) {
    if (getAddress(log.address) !== registry) continue;
    try {
      const decoded = decodeEventLog({ abi: identityAbiForRegister, data: log.data, topics: log.topics });
      if (decoded.eventName === "Registered") {
        const agentId = (decoded.args as { agentId?: bigint } | undefined)?.agentId;
        if (agentId !== undefined) return agentId;
      }
    } catch {
      continue;
    }
  }
  throw new Error("Identity registration receipt did not contain a Registered event.");
}

async function balances(address: Address): Promise<{ mon: bigint; usdc: bigint }> {
  const client = publicClient();
  const [mon, usdc] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: monad.paymentToken.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    }) as Promise<bigint>,
  ]);
  return { mon, usdc };
}

async function main(): Promise<void> {
  ensureEnv();
  await assertNetwork();
  const who = accounts();
  const unique = new Set(Object.values(who).map((address) => address.toLowerCase()));
  if (unique.size !== KEYS.length) {
    throw new Error("Identity owner, three verifiers, buyer, and the three providers must be eight different addresses.");
  }

  const quorumAddresses = QUORUM_KEYS.map((name) => who[name]);
  const verifierBal = await balances(who.VERIFIER_PRIVATE_KEY);
  const buyerBal = await balances(who.AGENT_PRIVATE_KEY);
  console.log(`Identity owner ${who.VERIFIER_PRIVATE_KEY}  ${formatEther(verifierBal.mon)} MON`);
  for (const name of QUORUM_KEYS) {
    console.log(`Verifier ${name.at(-1)} ${who[name]}  signs verdicts, does not send transactions`);
  }
  console.log(`Buyer    ${who.AGENT_PRIVATE_KEY}  ${formatEther(buyerBal.mon)} MON  ${formatUsdc(buyerBal.usdc)} USDC`);
  for (const seed of SEEDS) {
    const key = `PROVIDER_${seed.id}_PRIVATE_KEY` as const;
    console.log(`Provider ${seed.id} ${who[key]}  receives USDC, does not send transactions`);
  }

  const tokenDecimals = (await publicClient().readContract({
    address: monad.paymentToken.address,
    abi: erc20Abi,
    functionName: "decimals",
  })) as number;
  if (tokenDecimals !== monad.paymentToken.decimals) {
    throw new Error(`USDC decimals() returned ${tokenDecimals}, expected ${monad.paymentToken.decimals}.`);
  }

  const short: string[] = [];
  if (verifierBal.mon < MIN_MON) short.push(`identity owner needs at least 0.02 MON for deploy and identity registration (${addressUrl(who.VERIFIER_PRIVATE_KEY)})`);
  if (buyerBal.mon < MIN_MON) short.push(`buyer needs at least 0.02 MON for gas (${addressUrl(who.AGENT_PRIVATE_KEY)})`);
  if (buyerBal.usdc < MIN_USDC) short.push(`buyer needs at least 0.05 USDC for one prove run (${addressUrl(who.AGENT_PRIVATE_KEY)})`);
  if (short.length > 0) {
    console.error("\nWallets are not funded yet. No contract was deployed.");
    for (const line of short) console.error(`- ${line}`);
    console.error(`MON faucet: ${monad.faucetUrl}`);
    console.error("MON faucet (Alchemy, requires a mainnet ETH history): https://www.alchemy.com/faucets/monad-testnet");
    console.error(`USDC faucet: ${monad.usdcFaucetUrl} — choose USDC on Monad Testnet.`);
    console.error("Showcase of 12 settlements needs 0.36 USDC in addition to the 0.05 prove run if that run is kept.");
    process.exit(2);
  }

  forgePrepare();
  const artifact = JSON.parse(
    readFileSync(path.join(root, "contracts", "out", "RovaEscrow.sol", "RovaEscrow.json"), "utf8"),
  ) as { abi: unknown[]; bytecode: { object: Hex } };

  const existing = readExisting();
  const ownerInFile = existing?.identityOwner ?? existing?.verifier;
  if (ownerInFile && getAddress(ownerInFile as Address) !== who.VERIFIER_PRIVATE_KEY) {
    throw new Error("deployments.json identity owner does not match VERIFIER_PRIVATE_KEY. Refusing to deploy another escrow.");
  }
  if (existing?.agent && getAddress(existing.agent) !== who.AGENT_PRIVATE_KEY) {
    throw new Error("deployments.json buyer does not match AGENT_PRIVATE_KEY.");
  }

  const verifier = walletFrom(process.env.VERIFIER_PRIVATE_KEY as Hex);
  let escrow: Address | undefined;
  let deployTx: Hex | undefined;
  let deployBlock: string | undefined;
  if (existing?.escrow && (await quorumMatches(getAddress(existing.escrow), quorumAddresses, artifact.abi))) {
    if (!existing.deployTx || !isHex(existing.deployTx) || !existing.deployBlock) {
      throw new Error("The quorum escrow is deployed, but deployments.json is missing deployTx or deployBlock.");
    }
    escrow = getAddress(existing.escrow);
    deployTx = existing.deployTx;
    deployBlock = existing.deployBlock;
    console.log(`Escrow already deployed at ${escrow}`);
  } else {
    if (existing?.escrow) {
      console.log(`Escrow ${existing.escrow} is not this 2-of-3 set. Deploying a new RovaEscrow.`);
    }
    const hash = await verifier.wallet.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: [quorumAddresses, 2, monad.paymentToken.address],
      account: verifier.account,
      chain: verifier.wallet.chain,
    });
    const receipt = await publicClient().waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress) {
      throw new Error(`Deploy failed: ${hash}`);
    }
    escrow = getAddress(receipt.contractAddress);
    deployTx = receipt.transactionHash;
    deployBlock = receipt.blockNumber.toString();
    console.log(`Deployed RovaEscrow ${escrow}`);
    console.log(txUrl(deployTx));
  }
  if (!escrow || !deployTx || !deployBlock) throw new Error("Escrow deployment was not recorded.");

  const providers = {} as Deployment["providers"];
  const deploymentBody = (): Deployment => ({
    chainId: monad.chainId,
    escrow: escrow!,
    deployTx: deployTx!,
    deployBlock: deployBlock!,
    threshold: 2,
    verifiers: quorumAddresses,
    identityOwner: who.VERIFIER_PRIVATE_KEY,
    agent: who.AGENT_PRIVATE_KEY,
    providers,
  });
  for (const seed of SEEDS) {
    const keyName = `PROVIDER_${seed.id}_PRIVATE_KEY` as const;
    const previous = existing?.providers?.[seed.id];
    const saved: SeedProvider = {
      id: seed.id,
      name: seed.name,
      address: who[keyName],
      agentId: previous?.agentId ?? "",
      url: providerUrl(seed.port),
      price: seed.price,
      registerTx: previous?.registerTx ?? "",
      uriTx: previous?.uriTx ?? "",
    };
    if (previous && getAddress(previous.address) !== saved.address) {
      throw new Error(`Provider ${seed.id} address in deployments.json does not match its key.`);
    }
    providers[seed.id] = saved;
    writeJson(deploymentPath, deploymentBody());
    if (!saved.agentId) {
      const uri = agentDocument("0", seed.name, saved.url);
      const receipt = await writeContract({
        wallet: verifier.wallet,
        account: verifier.account,
        address: monad.erc8004.identityRegistry,
        abi: identityAbiForRegister,
        functionName: "register",
        args: [uri],
      });
      saved.agentId = registeredId(receipt.logs, monad.erc8004.identityRegistry).toString();
      saved.registerTx = receipt.transactionHash;
      providers[seed.id] = saved;
      writeJson(deploymentPath, deploymentBody());
      console.log(`Registered provider ${seed.id} as agent ${saved.agentId}`);
      console.log(txUrl(saved.registerTx));
    }
    const owner = (await publicClient().readContract({
      address: monad.erc8004.identityRegistry,
      abi: identityAbiForRegister,
      functionName: "ownerOf",
      args: [BigInt(saved.agentId)],
    })) as Address;
    if (getAddress(owner) !== who.VERIFIER_PRIVATE_KEY) {
      throw new Error(`Agent ${saved.agentId} is owned by ${owner}, not the identity owner. The buyer must not own it.`);
    }
    if (getAddress(owner) === who.AGENT_PRIVATE_KEY) {
      throw new Error("Buyer owns a provider identity. ERC-8004 would reject that buyer's feedback.");
    }
    const finalUri = agentDocument(saved.agentId, seed.name, saved.url);
    const currentUri = (await publicClient().readContract({
      address: monad.erc8004.identityRegistry,
      abi: identityAbiForRegister,
      functionName: "tokenURI",
      args: [BigInt(saved.agentId)],
    })) as string;
    if (currentUri !== finalUri) {
      const updated = await writeContract({
        wallet: verifier.wallet,
        account: verifier.account,
        address: monad.erc8004.identityRegistry,
        abi: identityAbiForRegister,
        functionName: "setAgentURI",
        args: [BigInt(saved.agentId), finalUri],
      });
      saved.uriTx = updated.transactionHash;
      console.log(`Set agent URI for provider ${seed.id}`);
      console.log(txUrl(saved.uriTx));
    }
    providers[seed.id] = saved;
    writeJson(deploymentPath, deploymentBody());
  }

  console.log(`\nWrote ${deploymentPath}`);
  console.log(`Escrow ${addressUrl(escrow!)}`);
  if (buyerBal.usdc < 360_000n) {
    console.log("Buyer USDC is below 0.36. pnpm prove can run. pnpm showcase needs 0.36 USDC for 12 settlements.");
  }
}

main().catch((error) => {
  console.error(explain(error));
  process.exit(1);
});
