/**
 * Verified 2026-10-06 against live chain id 10143 and official docs.
 * Do not copy addresses into other files. Import this module.
 *
 * Sources:
 * - https://docs.monad.xyz/developer-essentials/testnet
 * - https://docs.monad.xyz/guides/x402
 * - https://docs.monad.xyz/guides/erc-8004
 * - https://github.com/erc-8004/erc-8004-contracts (Monad testnet section)
 * - Facilitator discovery: GET https://x402-facilitator.molandak.org/supported
 *
 * On-chain checks the same day:
 * - eth_chainId = 10143 at https://testnet-rpc.monad.xyz
 * - USDC 0x534b…3A3 name/symbol USDC, decimals 6, version() "2", code present
 * - Identity proxy 0x8004A818…BD9e code present, getVersion() "2.0.0", name AgentIdentity
 * - Reputation proxy 0x8004B663…8713 getVersion() "2.0.0"
 * - getIdentityRegistry() on the reputation proxy returns the identity proxy above
 * - Mainnet registry addresses have no code on testnet. They are not used.
 */

export const monad = {
  chainId: 10143,
  chainName: "Monad Testnet",
  nativeSymbol: "MON",
  rpcUrl: "https://testnet-rpc.monad.xyz",
  wsUrl: "wss://testnet-rpc.monad.xyz",
  explorerUrl: "https://testnet.monadvision.com",
  explorerName: "MonadVision",
  faucetUrl: "https://faucet.monad.xyz",
  usdcFaucetUrl: "https://faucet.circle.com",
  paymentToken: {
    address: "0x534b2f3A21130d7a60830c2Df862319e593943A3" as const,
    symbol: "USDC",
    name: "USDC",
    decimals: 6,
    eip712Version: "2",
  },
  erc8004: {
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const,
    identityImplementation: "0x7274e874ca62410a93bd8bf61c69d8045e399c02" as const,
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713" as const,
    reputationImplementation: "0x16e0fa7f7c56b9a767e34b192b51f921be31da34" as const,
    version: "2.0.0",
  },
  x402: {
    facilitatorUrl: "https://x402-facilitator.molandak.org",
    network: "eip155:10143",
    schemes: ["exact", "upto", "batch-settlement"] as const,
    facilitatorSigner: "0x7f6a2850669202519f0FE8aa912451238820Db86" as const,
    exactPermit2Proxy: "0x402085c248EeA27D92E8b30b2C58ed07f9E20001" as const,
    uptoPermit2Proxy: "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002" as const,
    usedForEscrow: false,
  },
} as const;

export const paymentPath = {
  approach: "direct-escrow" as const,
  summary:
    "Rova funds RovaEscrow with Monad testnet USDC through approve and createOrder. Monad x402 exact and upto payments settle immediately to a payee, so they cannot hold an order until verification.",
} as const;

export function txUrl(hash: string): string {
  return `${monad.explorerUrl}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  return `${monad.explorerUrl}/address/${address}`;
}

export const TRUST = {
  verifier: "Rova currently uses one trusted verifier. Decentralized verification is future work.",
  truth:
    "Rova checks machine-checkable conditions only: the response exists, the request succeeded, the JSON matches the schema, latency is inside the limit, and the timestamp is fresh. Rova does not decide whether a price is true.",
  providers: "Demo providers are seeded by the Rova team.",
  reputation:
    "Reputation in this demo comes from one buyer. Log-weighted volume only partly limits self-dealing.",
} as const;
