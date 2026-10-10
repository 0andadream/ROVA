// Fund a pool with 30 units and a cap of 10.
// Twenty agents pay 1 unit each. Naive mode spends 20. Reserve mode stops at 10.
//
// PRIVATE_KEY is read only from the shell. This file does not load .env.
// On a local node with no key, it uses Anvil account 0.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  keccak256,
  toBytes
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const webDir = join(root, "web");
const UNIT = 10n ** 18n;
const CAP = 10n * UNIT;
const FLOAT = 30n * UNIT;
const AGENTS = 20;
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const VENDOR_NAIVE = getAddress("0x00000000000000000000000000000000000000fe");
const VENDOR_RESERVED = getAddress("0x00000000000000000000000000000000000000ff");

const TOPIC_SIGS = {
  Funded: "Funded(address,uint256)",
  Reserved: "Reserved(uint256,address,address,uint256,uint256)",
  Committed: "Committed(uint256,address,uint256,uint256)",
  Released: "Released(uint256,address,uint256,bool)",
  Refused: "Refused(address,address,uint256,uint256)",
  NaiveSpend: "NaiveSpend(address,address,uint256,uint256)",
  Reset: "Reset(address,uint256)"
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function isLocalRpc(url) {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

function artifact(name) {
  const file = join(root, "out", `${name}.sol`, `${name}.json`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    fail(`Missing ${file}. Run forge build first.`);
  }
}

function bytecodeOf(json) {
  const code = typeof json.bytecode === "string" ? json.bytecode : json.bytecode?.object;
  if (!code || code === "0x") fail("Contract bytecode is empty. Run forge build.");
  return code;
}

function units(wei) {
  const value = BigInt(wei);
  const whole = value / UNIT;
  const frac = (value % UNIT) / 10n ** 16n;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

function gwei(wei) {
  const value = BigInt(wei);
  const whole = value / 1_000_000_000n;
  const frac = (value % 1_000_000_000n) / 1_000_000n;
  return `${whole}.${frac.toString().padStart(3, "0")} gwei`;
}

function agent(index) {
  return getAddress(`0x${index.toString(16).padStart(40, "0")}`);
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2)}\n`);
}

function topics() {
  const out = {};
  for (const [name, sig] of Object.entries(TOPIC_SIGS)) out[name] = keccak256(toBytes(sig));
  return out;
}

function selectors(abi) {
  const names = ["available", "reserved", "spent", "overshoot", "poolBalance", "cap"];
  const out = {};
  for (const name of names) out[name] = encodeFunctionData({ abi, functionName: name });
  return out;
}

const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const local = isLocalRpc(rpcUrl);
let privateKey = process.env.PRIVATE_KEY;
if (!privateKey) {
  if (!local) {
    fail("Set PRIVATE_KEY in the shell for a remote RPC. This demo does not read .env.");
  }
  privateKey = ANVIL_KEY;
}
if (!local && privateKey.toLowerCase() === ANVIL_KEY) {
  fail("Refusing the public Anvil key on a remote RPC.");
}

const account = privateKeyToAccount(privateKey);
const tokenJson = artifact("MockToken");
const rovaJson = artifact("Rova");
const tokenAbi = tokenJson.abi;
const rovaAbi = rovaJson.abi;
const tokenBytecode = bytecodeOf(tokenJson);
const rovaBytecode = bytecodeOf(rovaJson);

const transport = () => http(rpcUrl, { batch: false, timeout: 30_000, retryCount: 2 });

let client;
try {
  client = createPublicClient({ transport: transport() });
  await client.getChainId();
} catch {
  fail(
    local
      ? "No node at " + rpcUrl + ". Start one with: anvil --host 127.0.0.1 --port 8545"
      : "RPC did not answer at " + rpcUrl
  );
}

const chainId = await client.getChainId();
if (!local && chainId !== 10143) {
  fail(`Refusing chain id ${chainId}. Expected Monad testnet 10143, or a local node.`);
}

const chain = {
  id: chainId,
  name: chainId === 10143 ? "monad-testnet" : "local",
  nativeCurrency: { name: "Ether", symbol: chainId === 10143 ? "MON" : "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } }
};
client = createPublicClient({ chain, transport: transport() });
const wallet = createWalletClient({ account, chain, transport: transport() });

async function deployGas(abi, bytecode, args) {
  const data = encodeDeployData({ abi, bytecode, args });
  return client.estimateGas({ account: account.address, data });
}

const gasPrice = await client.getGasPrice();
const tokenGas = await deployGas(tokenAbi, tokenBytecode);
const rovaGas = await deployGas(rovaAbi, rovaBytecode, [account.address, CAP]);
const followGas = 70n * 250_000n;
const need = ((tokenGas + rovaGas + followGas) * gasPrice * 12n) / 10n;
const balance = await client.getBalance({ address: account.address });

console.log(`rpc        ${rpcUrl}`);
console.log(`chain      ${chainId}`);
console.log(`operator   ${account.address}`);
console.log(`balance    ${formatEther(balance)} ${chain.nativeCurrency.symbol}`);
console.log(`gas price  ${gwei(gasPrice)}`);
console.log(`estimate   ${formatEther(need)} ${chain.nativeCurrency.symbol} for deploy plus the demo`);

if (balance < need) {
  console.error("");
  console.error("The balance does not cover this run. No transaction was sent.");
  console.error("Monad faucet: https://faucet.monad.xyz");
  console.error("Local run:    anvil --host 127.0.0.1 --port 8545");
  console.error("              unset PRIVATE_KEY && node scripts/demo.mjs");
  process.exit(2);
}

function eventsOf(receipt) {
  const out = [];
  for (const log of receipt.logs) {
    try {
      out.push(decodeEventLog({ abi: rovaAbi, data: log.data, topics: log.topics }));
    } catch {
      // token logs
    }
  }
  return out;
}

async function send(label, write) {
  const hash = await write();
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") fail(`${label} reverted: ${hash}`);
  console.log(`${label.padEnd(16)} ${hash}`);
  return { hash, receipt, events: eventsOf(receipt) };
}

console.log("");
console.log("cap 10   float 30   agents 20   spend 1 each");
console.log("");

const tokenDeploy = await send("deploy token", () => wallet.deployContract({ abi: tokenAbi, bytecode: tokenBytecode }));
const tokenAddress = getAddress(tokenDeploy.receipt.contractAddress);

const rovaDeploy = await send("deploy pool", () =>
  wallet.deployContract({ abi: rovaAbi, bytecode: rovaBytecode, args: [tokenAddress, CAP] })
);
const rovaAddress = getAddress(rovaDeploy.receipt.contractAddress);
const deployBlock = rovaDeploy.receipt.blockNumber;

const view = {
  address: rovaAddress,
  abi: rovaAbi
};

async function read(functionName) {
  return client.readContract({ ...view, functionName });
}

const snapshot = {
  chainId,
  rpc: rpcUrl,
  local,
  cap: CAP.toString(),
  float: FLOAT.toString(),
  agents: AGENTS,
  naive: { rows: [] },
  reserved: { rows: [] }
};

writeJson(join(webDir, "config.json"), {
  rpc: rpcUrl,
  chainId,
  local,
  explorer: chainId === 10143 ? "https://testnet.monadscan.com" : null,
  token: tokenAddress,
  rova: rovaAddress,
  owner: account.address,
  vendorNaive: VENDOR_NAIVE,
  vendorReserved: VENDOR_RESERVED,
  cap: CAP.toString(),
  fromBlock: `0x${deployBlock.toString(16)}`,
  topics: topics(),
  selectors: selectors(rovaAbi)
});

console.log("");
console.log(`token      ${tokenAddress}`);
console.log(`rova       ${rovaAddress}`);
console.log("");
console.log("--- naive: read the token balance, then pay ---");

await send("mint 30", () => wallet.writeContract({ address: tokenAddress, abi: tokenAbi, functionName: "mint", args: [account.address, FLOAT] }));
await send("approve", () => wallet.writeContract({ address: tokenAddress, abi: tokenAbi, functionName: "approve", args: [rovaAddress, FLOAT] }));
await send("fund 30", () => wallet.writeContract({ address: rovaAddress, abi: rovaAbi, functionName: "fund", args: [FLOAT] }));

for (let i = 1; i <= AGENTS; i++) {
  const who = agent(i);
  const sent = await send(`naive ${String(i).padStart(2, "0")}`, () =>
    wallet.writeContract({
      address: rovaAddress,
      abi: rovaAbi,
      functionName: "spendNaive",
      args: [who, UNIT, VENDOR_NAIVE]
    })
  );
  const ev = sent.events.find((item) => item.eventName === "NaiveSpend");
  if (!ev) fail(`naive ${i} emitted no NaiveSpend`);
  snapshot.naive.rows.push({
    kind: "NAIVE",
    agent: who,
    amount: ev.args.requested.toString(),
    paid: ev.args.paid.toString(),
    tx: sent.hash
  });
}

const naiveSpent = await read("spent");
const naiveOvershoot = await read("overshoot");
const naiveAttempted = await read("naiveAttempted");
const naivePaid = await read("naivePaid");
const naiveVendor = await client.readContract({ address: tokenAddress, abi: tokenAbi, functionName: "balanceOf", args: [VENDOR_NAIVE] });

if (naiveSpent !== 20n * UNIT || naiveOvershoot !== 10n * UNIT || naivePaid !== 20n * UNIT) {
  fail(`Naive result was spent ${naiveSpent} overshoot ${naiveOvershoot}. Expected spent 20 and overshoot 10.`);
}

snapshot.naive.attempted = naiveAttempted.toString();
snapshot.naive.paid = naivePaid.toString();
snapshot.naive.spent = naiveSpent.toString();
snapshot.naive.overshoot = naiveOvershoot.toString();
snapshot.naive.vendor = naiveVendor.toString();
writeJson(join(webDir, "snapshot.json"), snapshot);

console.log("");
console.log(`naive spent ${units(naiveSpent)}   cap ${units(CAP)}   overshoot ${units(naiveOvershoot)}`);
console.log("");
console.log("--- reset the counters, keep the log ---");

await send("reset", () => wallet.writeContract({ address: rovaAddress, abi: rovaAbi, functionName: "reset", args: [account.address] }));

console.log("");
console.log("--- reserve first, then pay the vendor ---");

await send("mint 30", () => wallet.writeContract({ address: tokenAddress, abi: tokenAbi, functionName: "mint", args: [account.address, FLOAT] }));
await send("approve", () => wallet.writeContract({ address: tokenAddress, abi: tokenAbi, functionName: "approve", args: [rovaAddress, FLOAT] }));
await send("fund 30", () => wallet.writeContract({ address: rovaAddress, abi: rovaAbi, functionName: "fund", args: [FLOAT] }));

const now = (await client.getBlock()).timestamp;
const expiry = now + 3600n;
const accepted = [];

for (let i = 1; i <= AGENTS; i++) {
  const who = agent(i);
  const sent = await send(`reserve ${String(i).padStart(2, "0")}`, () =>
    wallet.writeContract({
      address: rovaAddress,
      abi: rovaAbi,
      functionName: "tryReserve",
      args: [who, UNIT, expiry]
    })
  );
  const reservedEv = sent.events.find((item) => item.eventName === "Reserved");
  const refusedEv = sent.events.find((item) => item.eventName === "Refused");
  if (reservedEv) {
    accepted.push({ id: reservedEv.args.id, agent: who });
    snapshot.reserved.rows.push({
      kind: "RESERVE",
      agent: who,
      id: reservedEv.args.id.toString(),
      amount: reservedEv.args.amount.toString(),
      tx: sent.hash
    });
  } else if (refusedEv) {
    snapshot.reserved.rows.push({
      kind: "REFUSED",
      agent: who,
      amount: refusedEv.args.amount.toString(),
      available: refusedEv.args.available.toString(),
      tx: sent.hash
    });
  } else {
    fail(`reserve ${i} emitted neither Reserved nor Refused`);
  }
}

console.log("");
for (const item of accepted) {
  const sent = await send(`commit ${item.id.toString().padStart(2, " ")}`, () =>
    wallet.writeContract({
      address: rovaAddress,
      abi: rovaAbi,
      functionName: "commit",
      args: [item.id, UNIT, VENDOR_RESERVED]
    })
  );
  const ev = sent.events.find((log) => log.eventName === "Committed");
  if (!ev) fail(`commit ${item.id} emitted no Committed`);
  snapshot.reserved.rows.push({
    kind: "COMMIT",
    agent: item.agent,
    id: item.id.toString(),
    amount: ev.args.actualCost.toString(),
    refunded: ev.args.refundedToPool.toString(),
    tx: sent.hash
  });
}

const finalSpent = await read("spent");
const finalReserved = await read("reserved");
const finalAvailable = await read("available");
const finalOvershoot = await read("overshoot");
const finalPool = await read("poolBalance");
const reservedVendor = await client.readContract({
  address: tokenAddress,
  abi: tokenAbi,
  functionName: "balanceOf",
  args: [VENDOR_RESERVED]
});
const refused = snapshot.reserved.rows.filter((row) => row.kind === "REFUSED").length;

if (accepted.length !== 10 || refused !== 10 || finalSpent !== CAP || finalOvershoot !== 0n || finalReserved !== 0n || reservedVendor !== CAP) {
  fail(
    `Reserved result accepted ${accepted.length} refused ${refused} spent ${finalSpent} overshoot ${finalOvershoot} vendor ${reservedVendor}.`
  );
}

snapshot.reserved.accepted = accepted.length;
snapshot.reserved.refused = refused;
snapshot.reserved.spent = finalSpent.toString();
snapshot.reserved.overshoot = finalOvershoot.toString();
snapshot.reserved.vendor = reservedVendor.toString();
snapshot.final = {
  available: finalAvailable.toString(),
  reserved: finalReserved.toString(),
  spent: finalSpent.toString(),
  overshoot: finalOvershoot.toString(),
  pool: finalPool.toString(),
  vendorNaive: naiveVendor.toString(),
  vendorReserved: reservedVendor.toString()
};
writeJson(join(webDir, "snapshot.json"), snapshot);

console.log("");
console.log("naive");
console.log(`  attempted  ${units(naiveAttempted)}`);
console.log(`  paid       ${units(naivePaid)}`);
console.log(`  spent      ${units(naiveSpent)}`);
console.log(`  overshoot  ${units(naiveOvershoot)}`);
console.log(`  vendor     ${units(naiveVendor)}  ${VENDOR_NAIVE}`);
console.log("reserved");
console.log(`  accepted   ${accepted.length}`);
console.log(`  refused    ${refused}`);
console.log(`  spent      ${units(finalSpent)}`);
console.log(`  available  ${units(finalAvailable)}`);
console.log(`  reserved   ${units(finalReserved)}`);
console.log(`  overshoot  ${units(finalOvershoot)}`);
console.log(`  pool       ${units(finalPool)}`);
console.log(`  vendor     ${units(reservedVendor)}  ${VENDOR_RESERVED}`);
console.log("");
console.log(`token  ${tokenAddress}`);
console.log(`rova   ${rovaAddress}`);
console.log("wrote  web/config.json");
console.log("wrote  web/snapshot.json");
