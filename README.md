# ROVA

Machines shouldn't pay for failed work.

Rova is an autonomous purchasing agent for the Monad Metropolis hackathon, Track 04 (Trust, Identity & AI Infrastructure), with payments as a core primitive. You give it a task, a total budget, and machine-checkable conditions. It discovers seeded providers, ranks them in deterministic code, locks the price in `RovaEscrow`, and pays only if the checks pass. A failed provider is refunded in that same settlement transaction. Rova then opens a new order with the next provider.

Give Rova a task, a budget and conditions. Rova finds who can do it. They only get paid if it works.

## Deployment status

The contracts, verifier, providers, agent, and live-run UI are implemented. Foundry tests pass (22) and the ranking and verification unit tests pass (8). **Nothing has been deployed, and no payment has been sent.** The new wallets have 0 MON and 0 USDC.

This environment could not get testnet funds:

- [faucet.monad.xyz](https://faucet.monad.xyz) returns a Vercel security checkpoint (HTTP 429) to this client.
- [QuickNode's Monad faucet](https://faucet.quicknode.com/monad/testnet) rejects these addresses with `Invalid ETH mainnet balance`.
- Alchemy's faucet requires a mainnet ETH history.
- Monad testnet USDC (`0x534b2f3A21130d7a60830c2Df862319e593943A3`) is Circle FiatToken. `mint` reverts with `FiatToken: caller is not a minter`.
- Circle's faucet API supports `MONAD-TESTNET`, and it requires a Circle API key. None is configured here. The browser faucet is [faucet.circle.com](https://faucet.circle.com).

Fund the two sending wallets, then run `pnpm run setup`. Do not invent balances or paste fake transaction hashes.

| Role | Address | Needs |
| --- | --- | --- |
| Verifier (deploys escrow, settles, owns the ERC-8004 identities) | `0xe750B7D59fD895e8473df4729132dec46f244ADE` | at least 0.02 MON |
| Buyer (approves USDC, creates orders, posts reputation) | `0xD1a330426dC19cb6a0F707A3904D63A052bc8EEc` | at least 0.02 MON and 0.41 USDC |
| Provider A, receives USDC only | `0xdd474E8316473D5919DBdfCd20f677e094842E96` | nothing |
| Provider B, receives USDC only | `0xb507D09d97442DcD7745E93b79ef05Cae7962Cb6` | nothing |
| Provider C, receives USDC only | `0x879F63f723BEC5CFeF4530b082498ba0b5Cd98A4` | nothing |

`0.05` USDC is enough for `pnpm prove` (Provider B's `0.02` is refunded, Provider C keeps `0.03`). `pnpm showcase` adds 12 successful settlements and needs another `0.36` USDC. Private keys stay in `.env` (mode 0600, gitignored).

## The problem

An agent can already pay an API. Payment does not tell the agent whether the response met the conditions it asked for, and it does not give the agent the money back when the response fails those conditions. The agent then has to pick a fallback and try again without a record that ties reputation to the settlement.

## What Rova does not decide

Rova does not determine whether arbitrary information is objectively true. It verifies only deterministic, machine-checkable conditions: the response exists, the request succeeded, the JSON matches the schema, latency is inside the limit, the timestamp is fresh, the order has not expired, required fields are present, and the body is non-empty.

Rova can determine: "The provider returned ETH/USD data within 3 seconds and its timestamp was less than 60 seconds old."

Rova cannot determine: "The ETH/USD price supplied by the provider is objectively true."

The same boundary is on the run screen, the activity page, the providers page, and the about page.

## Architecture

```
web (Vite, React)  ->  agent :4300  ->  RovaEscrow (Monad testnet USDC)
                         |    \
                         |     ->  ERC-8004 ReputationRegistry.giveFeedback
                         v
                   gateway :4200  ->  provider A :4101 / B :4102 / C :4103
                         |
                         ->  settle(orderId, passed, evidenceHash)
```

| Path | Role |
| --- | --- |
| `contracts/` | `RovaEscrow.sol` and Foundry tests |
| `config/` | The only chain configuration, shared ABIs, ranking, money, task parser |
| `gateway/` | The single trusted verifier |
| `providers/` | Three seeded ETH/USD responders |
| `agent/` | Deterministic routing, funding, reroute, reputation, HTTP API |
| `web/` | Landing page and the live run screen |
| `scripts/` | `setup`, `prove`, `showcase`, `demo` |

Chain values live in `config/monad.ts`. ABIs live in `config/abis/`. Do not copy addresses into other files.

## Routing

An LLM does not choose a provider. The task parser is a keyword match for ETH/USD. Eligible providers must be active, serve `eth-usd`, price at or under the per-request cap, and price at or under the remaining budget.

```
reputation = successRate × log10(1 + verifiedVolume)
score      = 0.70 × normalizedReputation + 0.30 × normalizedPriceAdvantage
```

`verifiedVolume` is settled USDC in 6-decimal atomic units, read from `OrderSettled` logs. Success rate and order count come from ERC-8004 feedback with tag `rova.settlement` (value 100 is a pass, value 0 is a fail). Dust volume cannot dominate because `log10(2)` is far below `log10(1 + 20000)`. Ties break to the lower price, then the provider address.

While `DEMO_STALE=1`, ranking uses price only. That is what makes the recorded demo start with Provider B without editing reputation. The 10+ settlement showcase is a separate command and leaves the stale switch off.

Failed providers are removed from the pool before the next ranking, so they cannot be selected again in that run. Spend counts only settled orders. The loop stops after one pass per provider.

## Escrow

`RovaEscrow` is an ERC-20 escrow with one immutable verifier and one immutable payment token (Monad testnet USDC, 6 decimals).

Order statuses are `NONE`, `FUNDED`, `SETTLED`, `REFUNDED`, and `EXPIRED_REFUNDED`.

- `createOrder` pulls USDC from the buyer, stores a new id (ids start at 1 and are never reused), and emits `OrderCreated`.
- `settle(id, passed, evidenceHash)` is only callable by the verifier, only while the order is `FUNDED`, and only before expiry. `passed` pays the provider and marks `SETTLED`. Otherwise the same transaction refunds the buyer and marks `REFUNDED`.
- `refundExpired` is callable by anyone after `expiresAt`, only for `FUNDED` orders.

The contract rejects zero amounts, the buyer paying themselves, a token other than USDC, expiry in the past, a second settlement, a non-verifier, settlement after expiry, refund before expiry, and fee-on-transfer tokens whose received amount is not the order amount. Pull and push are guarded against reentrancy.

The on-chain object is an order. The UI does not call it anything else.

## Verification

Rova currently uses one trusted verifier. Decentralized verification is future work.

The gateway checks the funded order, calls the seeded provider, and records latency. It checks a non-empty body, JSON parse, the schema (object, required fields, string / number / integer, const), latency, and timestamp freshness. Evidence is canonical JSON hashed with keccak256. The hash is the `evidenceHash` passed to `settle`. The settlement transaction is stored beside the evidence after it exists, because the hash is computed before that transaction.

A demo failure is not garbage. With `DEMO_STALE=1`, Provider B returns valid `{"symbol":"ETH/USD","price":<spot>,"timestamp":<now-180s>}`. Schema passes. Freshness fails because 180 seconds is older than the 60 second maximum. The run screen and the activity feed show `Demo mode: Provider B serving stale data`.

## Rerouting

On `REFUNDED` or `EXPIRED_REFUNDED`, the agent records the refund, does not subtract it from the budget, excludes that provider, and creates a new order for the next eligible provider. On `SETTLED`, it stops and returns the payload. If the gateway does not settle, the agent stops instead of opening another order against an unknown on-chain state. If nobody remains eligible, the run ends as a clean failure.

## ERC-8004

Identity Registry `0x8004A818BFB912233c491871b3d84c89A494BD9e` and Reputation Registry `0x8004B663056A597Dffe9eCcC1965A193B7388713` on Monad testnet (chain id 10143). Both proxies report `getVersion() == "2.0.0"`. `getIdentityRegistry()` on the reputation proxy returns the identity proxy. The Validation Registry is not used.

`giveFeedback` reverts when the caller is the identity owner or operator (`Self-feedback not allowed`). The verifier owns the three provider NFTs and is the only settler. The buyer is a different key, funds orders, and is the only address that posts feedback. Provider keys do not send transactions.

Feedback value is `100` or `0` with `valueDecimals` 0, tag1 `rova.settlement`, tag2 `pass` or `fail`. `feedbackHash` is keccak256 of canonical JSON that includes the order id, amount, evidence hash, and the settlement transaction. The feedback URI points at the gateway evidence record. The UI does not post feedback. A failed feedback transaction is shown as an error and does not hide the settlement.

## Monad

Verified 2026-10-06:

| | |
| --- | --- |
| Chain | Monad Testnet, id `10143` |
| RPC | `https://testnet-rpc.monad.xyz` |
| Explorer | `https://testnet.monadvision.com` |
| USDC | `0x534b2f3A21130d7a60830c2Df862319e593943A3`, 6 decimals, EIP-712 version `2` |
| x402 facilitator | `https://x402-facilitator.molandak.org` |

Mainnet (chain 143) is not used. The mainnet registry addresses have no code on testnet.

## Why this is not an x402 payment

Monad's facilitator settles `exact`, `upto`, and `batch-settlement` on `eip155:10143`. `exact` is an EIP-3009 transfer straight to `payTo`. `upto` pays a variable amount up to a signed maximum, still to the resource. Neither can hold a refundable application order and return it to the buyer when freshness fails.

Rova therefore uses direct escrow: the buyer approves USDC once (max allowance, because a refund does not restore allowance) and calls `createOrder`. The order id and funding transaction are passed to the provider through the verifier. x402 addresses stay in `config/monad.ts` with `usedForEscrow: false`.

The Monad API Hub is mainnet-only (`eip155:143`) and its x402 payments are not refundable. It is not a fourth provider in this demo.

## Run locally

Requirements: Node 20, pnpm, Foundry, and funded wallets as above.

```bash
pnpm install
pnpm run setup          # deploy escrow, register three identities, write config/deployments.json
pnpm prove              # B stale -> refund -> new order -> C paid
pnpm showcase           # 12 fresh settlements, rankings move
pnpm demo               # providers, gateway, agent, and the web UI
```

`pnpm setup` without `run` is pnpm's own shell installer. Use `pnpm run setup`.

`pnpm demo` serves the live run at http://127.0.0.1:5173/run . It refuses to start until `config/deployments.json` exists. Default `DEMO_STALE=1`.

Stop `pnpm demo` before `pnpm prove` or `pnpm showcase`. Those commands use the buyer key in-process and will not share it with the agent server. Showcase also refuses to run while Provider B is serving stale data.

`forge install foundry-rs/forge-std --no-git` runs from `pnpm run setup` when `contracts/lib` is missing. `contracts/lib` is gitignored.

## Judge demo

0–10s. AI agents can buy APIs now. Payment does not guarantee the provider delivered what the agent asked for.

10–20s. Task `Get ETH/USD price data`, budget `$0.05`, latency under 3 seconds, freshness under 60 seconds. The demo-mode badge is visible. RUN ROVA.

20–30s. Rova ranks B, then C, then A. A real `$0.02` order appears on Monad.

30–40s. B responds. Schema passes. Freshness fails. The screen shows SLA FAILED / REFUNDED with the refund transaction.

40–50s. Nobody clicks again. Rova opens a new order with C. C passes. The screen shows VERIFIED / PAID.

50–60s. Open the settlement transaction, the ERC-8004 feedback transaction, and the ranking table.

Close. Rova gives autonomous agents something payments alone don't provide: recourse through execution.

A backup recording was not made. This environment has no browser capture, and testnet payments have not run.

## Trust assumptions and limits

- Demo providers are seeded by the Rova team. There is no public marketplace.
- Payments are real Monad testnet USDC transactions once the wallets are funded. Until then there are none.
- The verifier is one trusted key.
- Verification covers machine-checkable conditions only. Rova does not establish semantic truth.
- Reputation comes from a single buyer. Log-weighted volume only partly reduces self-dealing.
- `getSummary` on the reputation registry requires a non-empty client filter. Rankings read `getClients` and then `readAllFeedback`.

## Competitive position

Agent escrow is not new. Metrik, agora402, x402r, Settld, OnlyTrust, and Chainlink-related agent payment work already hold or verify funds around agent purchases. Rova does not claim to have invented escrow for AI agents.

Rova combines conditional settlement with autonomous provider selection and automatic rerouting. A failed provider is refunded before the next attempt, and that attempt is a new order. Provider reputation is posted only after settlement and the feedback hash includes that settlement transaction, through the ERC-8004 contracts already deployed on Monad. The hackathon demo is the whole loop on Monad testnet, not a mocked receipt.

Google's AP2 uses Mandates for authorization before a payment. Rova is the other half: did the seller deliver the machine-checkable conditions. The on-chain object in this app is an order.

## Roadmap

Not in this MVP: a public marketplace (Monad already has an API Hub), subcontracting chains, a general dispute court, semantic truth verification, a complex spend-policy engine, a decentralized verifier network, the ERC-8004 Validation Registry, and cross-chain execution.

## Acceptance

- [x] `RovaEscrow` implemented, with Foundry tests for create, balances, pass, fail, expiry, double settlement, non-verifier, early refund, allowance, and events
- [ ] Deployed on Monad with a real payment token
- [ ] Buyer can fund escrow; a pass pays the provider; a fail refunds the buyer, visible on the explorer
- [ ] Failure reroutes to a new order and the fallback settles
- [x] Verifier checks latency, freshness, schema, and a non-empty response (unit-tested; not yet against a live order)
- [x] Three seeded providers; B can serve stale-but-valid JSON; the demo badge is in the UI
- [ ] Frontend showing real order ids, hashes, and explorer links from a live run
- [x] `pnpm demo` starts providers, gateway, agent, and the frontend after setup
- [ ] Full failure, refund, reroute, and settlement on chain
- [ ] ERC-8004 identities and feedback that reference payment evidence
- [ ] 10 or more settlements moving the ranking table, with the recorded demo still starting at B
- [x] README states the trust assumptions and distinguishes Rova from existing escrow projects
