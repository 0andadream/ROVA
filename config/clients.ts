import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "./monad.ts";

export const monadChain: Chain = defineChain({
  id: monad.chainId,
  name: monad.chainName,
  nativeCurrency: { name: "MON", symbol: monad.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [monad.rpcUrl], webSocket: [monad.wsUrl] } },
  blockExplorers: { default: { name: monad.explorerName, url: monad.explorerUrl } },
});

let shared: PublicClient | null = null;

export function publicClient(): PublicClient {
  if (!shared) {
    shared = createPublicClient({ chain: monadChain, transport: http(monad.rpcUrl) });
  }
  return shared;
}

export function walletFrom(privateKey: Hex): { account: Account; wallet: WalletClient } {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain: monadChain, transport: http(monad.rpcUrl) });
  return { account, wallet };
}

export async function assertNetwork(): Promise<void> {
  const chainId = await publicClient().getChainId();
  if (chainId !== monad.chainId) {
    throw new Error(`RPC returned chain ${chainId}. Rova is configured for ${monad.chainId}.`);
  }
}

export async function writeContract(args: {
  wallet: WalletClient;
  account: Account;
  address: Address;
  abi: readonly unknown[] | unknown[];
  functionName: string;
  args?: readonly unknown[];
}): Promise<TransactionReceipt> {
  const client = publicClient();
  const { request } = await client.simulateContract({
    address: args.address,
    abi: args.abi as never,
    functionName: args.functionName,
    args: args.args as never,
    account: args.account,
  });
  const hash = await args.wallet.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Transaction reverted: ${hash}`);
  }
  return receipt;
}
