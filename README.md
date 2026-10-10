# Rova

One shared pool, many agents, one hard cap. The pool pays the vendor. An agent never holds the funds.

A spend is allowed only after the contract reserves it. The reservation is one transaction: the contract increases the reserved total only when `cap - spent - reserved` covers the amount. A crashed agent cannot hold the cap forever, because a reservation expires and anyone can release it after that time.

## The two runs

The pool is funded with 30 units. The cap is 10. Twenty agents each try to spend 1.

Naive mode reads the token balance and pays while tokens remain. Each payment is its own transaction. All twenty pay. Spent becomes 20. The cap was 10, so the overshoot is 10.

Reserve mode locks 1 unit before the vendor is paid. Ten locks fit. The next ten emit `Refused` and move no funds. Ten commits then pay the vendor. Spent is 10 and the overshoot is 0.

The token balance is larger than the cap on purpose. That slack is what lets the naive path move real tokens past the policy. `reserve` still stops at the cap. The mock token is rUSD, 18 decimals. Anyone can mint it. It has no value.

`tryReserve` emits `Refused` and returns 0, so a dashboard can read the log. `reserve` reverts `InsufficientAvailable` on the same shortage. `commit` pays `actualCost` to the vendor and leaves the unused part of the reservation in the pool. The original reserver or the owner can commit or release. After expiry, anyone can release.

`reset` is how one deployment runs both modes. The owner pulls the leftover tokens and the counters return to zero. The event log stays, so the naive overshoot is still visible after the reset.

## Why Monad

The fix is many small transactions: a reserve and a commit for each agent. Monad testnet is built for cheap, fast confirmation of that traffic. Chain id 10143. Explorer: https://testnet.monadscan.com

The public RPC is https://testnet-rpc.monad.xyz. The hostname `rpc.testnet.monad.xyz` does not resolve.

This checkout runs the same contracts on Anvil. A testnet deploy needs more MON than the wallets on this machine hold.

On 2026-10-10 the testnet gas price was 102 gwei. `eth_estimateGas` priced the creates at 388,000 gas for the token and 1,130,121 gas for the pool, about 0.155 MON before any agent transaction. The owner wallet `0xe750B7D59fD895e8473df4729132dec46f244ADE` held 0.0427 MON. The buyer wallet `0xD1a330426dC19cb6a0F707A3904D63A052bc8EEc` held 0.0414 MON. The demo script exits before it sends when the balance cannot cover the run. No testnet transaction was broadcast. The faucet is https://faucet.monad.xyz.

## Deployed addresses

No Monad testnet contracts are deployed.

The dashboard is hosted at https://rova-production-f873.up.railway.app. That page shows the recorded Anvil run in `web/recording.json`. It does not have a chain attached.

A local Anvil run deployed:

| | |
| --- | --- |
| MockToken (rUSD) | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| Rova | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |

Those addresses exist on the Anvil process that ran the demo. They are not Monad addresses. `web/config.json` and `web/snapshot.json` record the run. Both files are gitignored and are rewritten the next time the demo runs.

That run ended as:

```
naive      spent 20.00   overshoot 10.00   vendor 20.00
reserved   accepted 10   refused 10
           spent 10.00   overshoot 0.00    vendor 10.00
```

The script prints every transaction hash.

## Run it

Foundry and Node 20 are required. From this directory:

```bash
forge install foundry-rs/forge-std --no-git
pnpm install
pnpm test
```

`forge install` on Foundry 1.7.1 uses `--no-git`. That puts `forge-std` in `lib/` without a submodule. `lib/` is gitignored.

In one terminal:

```bash
anvil --host 127.0.0.1 --port 8545
```

In another:

```bash
pnpm demo
pnpm serve
```

Open http://127.0.0.1:4173

Leave `PRIVATE_KEY` unset for the local run. The demo then uses Anvil account 0. It does not read `.env`. For testnet, set both in the shell:

```bash
export RPC_URL=https://testnet-rpc.monad.xyz
export PRIVATE_KEY=...
pnpm demo
```

The page reads the pool through same-origin `/rpc`. The server proxies that to the `rpc` field in `web/config.json`.

## Tests

`pnpm test` runs `forge test`. The suite covers:

- twenty reserves never push the reserved total past the cap, and the ten that fit can be committed
- reserving more than the remaining cap reverts
- `tryReserve` emits `Refused`
- a commit of 2 from a reservation of 5 pays the vendor 2 and leaves 3 in the pool
- a stranger cannot commit or release, and the owner can commit
- after expiry anyone can release, the cap is free for a new reserve, and commit reverts
- twenty naive payments spend 20 against a cap of 10
- a naive payment cannot take tokens that are still reserved
- reset clears the counters and reverts while a reservation is live

## License

MIT. See [LICENSE](LICENSE).

## AI-use note

Grok wrote this repository from a short brief. The Foundry tests and the Anvil demo were run on this machine. This is a demonstration, not an audit.
