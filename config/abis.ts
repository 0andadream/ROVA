import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi } from "viem";

const dir = path.dirname(fileURLToPath(import.meta.url));

function load(name: string): Abi {
  return JSON.parse(readFileSync(path.join(dir, "abis", name), "utf8")) as Abi;
}

/** Official ABI from erc-8004/erc-8004-contracts. Live proxies report getVersion() 2.0.0. */
export const identityAbi = load("IdentityRegistry.json");
export const reputationAbi = load("ReputationRegistry.json");

export const identityAbiForRegister: Abi = identityAbi.filter((item) => {
  if (item.type !== "function" || item.name !== "register") return true;
  return item.inputs.length === 1;
});

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

export const escrowAbi = [
  {
    type: "constructor",
    inputs: [
      { name: "verifiers_", type: "address[]" },
      { name: "threshold_", type: "uint8" },
      { name: "paymentToken_", type: "address" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "threshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "domainSeparator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "isVerifier",
    stateMutability: "view",
    inputs: [{ name: "verifier", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "verifierCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "verifierAt",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "paymentToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "nextOrderId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getOrder",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "agent", type: "address" },
          { name: "provider", type: "address" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "maxLatencyMs", type: "uint256" },
          { name: "maxAgeSec", type: "uint256" },
          { name: "schemaHash", type: "bytes32" },
          { name: "expiresAt", type: "uint256" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "createOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "provider", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "maxLatencyMs", type: "uint256" },
      { name: "maxAgeSec", type: "uint256" },
      { name: "schemaHash", type: "bytes32" },
      { name: "expiresAt", type: "uint256" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "passed", type: "bool" },
      { name: "evidenceHashes", type: "bytes32[]" },
      { name: "signatures", type: "bytes[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "refundExpired",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "event",
    name: "OrderCreated",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "agent", type: "address", indexed: true },
      { name: "provider", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "maxLatencyMs", type: "uint256", indexed: false },
      { name: "maxAgeSec", type: "uint256", indexed: false },
      { name: "schemaHash", type: "bytes32", indexed: false },
      { name: "expiresAt", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OrderSettled",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "provider", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "evidenceHashes", type: "bytes32[]", indexed: false },
      { name: "signers", type: "address[]", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OrderRefunded",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "agent", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "evidenceHashes", type: "bytes32[]", indexed: false },
      { name: "signers", type: "address[]", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OrderExpiredRefunded",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "agent", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "InvalidProvider", inputs: [] },
  { type: "error", name: "InvalidToken", inputs: [] },
  { type: "error", name: "InvalidExpiry", inputs: [] },
  { type: "error", name: "InvalidVerifierSet", inputs: [] },
  { type: "error", name: "InvalidThreshold", inputs: [] },
  { type: "error", name: "NotVerifier", inputs: [] },
  { type: "error", name: "BelowThreshold", inputs: [] },
  { type: "error", name: "UnsortedSigners", inputs: [] },
  { type: "error", name: "DuplicateSigner", inputs: [] },
  { type: "error", name: "QuorumShape", inputs: [] },
  { type: "error", name: "InvalidOrder", inputs: [] },
  { type: "error", name: "Expired", inputs: [] },
  { type: "error", name: "NotExpired", inputs: [] },
  { type: "error", name: "TransferFailed", inputs: [] },
  { type: "error", name: "Reentrancy", inputs: [] },
] as const;

export const ORDER_STATUS = ["NONE", "FUNDED", "SETTLED", "REFUNDED", "EXPIRED_REFUNDED"] as const;
