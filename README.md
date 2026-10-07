# ROVA

Machines shouldn't pay for failed work.

Rova is an autonomous purchasing agent for the Monad Metropolis hackathon, Track 04 (Trust, Identity & AI Infrastructure), with payments as a core primitive. You give it a task, a total budget, and machine-checkable conditions. It discovers seeded providers, ranks them in deterministic code, locks the price in `RovaEscrow`, and pays only if the checks pass. A failed provider is refunded in that same settlement transaction. Rova then opens a new order with the next provider.

Give Rova a task, a budget and conditions. Rova finds who can do it. They only get paid if it works.

## Deployment status

The app is live at [https://rova-production-f873.up.railway.app](https://rova-production-f873.up.railway.app). The quorum escrow below replaces the earlier single-verifier escrow. Verified volume is read from this escrow's `OrderSettled` logs, so it starts at zero. Provider identities 2033, 2034, and 2035 stay. Their ERC-8004 success rates still include feedback from the previous escrow.

Rova uses a 2-of-3 verifier quorum. In this hackathon deployment all three keys are operated by the Rova team, so this removes single-key compromise but not operator collusion.

| | |
| --- | --- |
| RovaEscrow | [`0x2B50654E5B39e44596f06878288F9eEAA79551c3`](https://testnet.monadvision.com/address/0x2B50654E5B39e44596f06878288F9eEAA79551c3) |
| Deploy transaction | [`0x30cdbad8aeefd9a5ea034a8ecfe3b6769a543aaec266d157e929c501e0d7330d`](https://testnet.monadvision.com/tx/0x30cdbad8aeefd9a5ea034a8ecfe3b6769a543aaec266d157e929c501e0d7330d) |
| Deploy block | `68968605` |
| Source | Sourcify `exact_match` on Monad testnet (chain 10143), verified 2026-10-07 |
| Threshold | 2 of 3 |
| Verifier 1 | `0x1F9fFe4b037a1fbe59C73dCB7c158675BdAa1DDF` |
| Verifier 2 | `0xaC855ff1277474Cd0048E4fF7c503472b8530403` |
| Verifier 3 | `0x6C431ec14a37449045AA86a4a1D2cC9326Ec22bE` |
| Provider A identity | agent id `2033` |
| Provider B identity | agent id `2034` |
| Provider C identity | agent id `2035` |

The previous escrow `0xA7B310f397271D76A005a228A58F9e3035C455BC` was the single-verifier contract. New orders are not opened against it.

A new Railway project was rejected with `Free plan resource provision limit exceeded`. The service `rova` was added inside the existing Diverge project. The Diverge service was not redeployed and [https://diverge.up.railway.app](https://diverge.up.railway.app) still answers. Deploy this app with `npx --yes @railway/cli up --service rova --environment production --project 935e8954-fd4d-4e97-baf2-827cb8965484`. A bare `railway up` from a directory linked to the Diverge service would replace that app.

All three verifier processes and the coordinator run in that one container. Separate Railway services were not created. The free-plan project limit already blocked a new project, and adding services inside the Diverge project would put more Rova processes next to the live Diverge app. Locally, `pnpm demo` starts the three verifiers as separate processes on ports 4201, 4202, and 4203, and the coordinator on 4200.

The hosted service was redeployed on 2026-10-07 as `eab16065-8c44-43f8-bf2a-90501fb55a53`. `/api/meta` returns this escrow, threshold 2, and the three verifier addresses. `railway volume add --mount-path /app/data` panicked again (`volume.rs:836`) and created no volume. A restart still drops the evidence files. The activity table can rebuild latency, freshness, schema, signers, and evidence hashes from the ERC-8004 feedback URI.

The public Monad RPC allows `eth_getLogs` ranges of at most 100 blocks. Rankings and activity scan from the deploy block in those windows, about 8 requests per second. The last scanned block and the logs are cached in memory and in `data/log-cache.json`, keyed by the escrow address.

Evidence JSON is written to `data/evidence`. The same check result, signer set, evidence hashes, and verdict signatures are embedded in the ERC-8004 feedback URI as `data:application/json,...`. If the files are gone, the activity scan reads `NewFeedback` for the buyer and rebuilds the row from that URI.

| Role | Address | Needs |
| --- | --- | --- |
| Identity owner (deploys escrow, owns the ERC-8004 identities) | `0xe750B7D59fD895e8473df4729132dec46f244ADE` | MON for gas |
| Verifiers 1–3 (sign verdicts, do not send transactions) | the three addresses above | nothing |
| Buyer (approves USDC, creates orders, relays `settle`, posts reputation) | `0xD1a330426dC19cb6a0F707A3904D63A052bc8EEc` | MON for gas and USDC for orders |
| Provider A, receives USDC only | `0xdd474E8316473D5919DBdfCd20f677e094842E96` | nothing |
| Provider B, receives USDC only | `0xb507D09d97442DcD7745E93b79ef05Cae7962Cb6` | nothing |
| Provider C, receives USDC only | `0x879F63f723BEC5CFeF4530b082498ba0b5Cd98A4` | nothing |

Testnet USDC comes from [faucet.circle.com](https://faucet.circle.com) (USDC, Monad Testnet). The MON faucet does not drip USDC, and `mint` on `0x534b2f3A21130d7a60830c2Df862319e593943A3` reverts for anyone who is not a minter. Private keys stay in `.env` (mode 0600, gitignored) and in the `rova` service variables. `0.05` USDC is enough for one prove run. `pnpm showcase` needs another `0.36` USDC.

Quorum prove `run_muy2tjjz_57gq2a` on 2026-10-07, stale demo on, budget `$0.05`. All three verifiers agreed.

| Order | Provider | Quorum | Transaction |
| --- | --- | --- | --- |
| 1 | B, `$0.02` | 3 of 3 FAIL, refunded. Schema passed, freshness failed at 180s | [refund](https://testnet.monadvision.com/tx/0x54bdeaddae1abec847b0ef9824f788e8e03e503d8cf83544848736c7f888b755) · [feedback 0](https://testnet.monadvision.com/tx/0x2f34db8372dd897989ee5cf742e06655ead75ac8e1c5a3770429bf15173736eb) |
| 2 | C, `$0.03` | 3 of 3 PASS, paid | [settlement](https://testnet.monadvision.com/tx/0x354b68bc064822db418c79ccc6c75506358c48a6da674b9efa48fcc3bb804141) · [feedback 100](https://testnet.monadvision.com/tx/0x251f73b2290e3e8b7095f93cf0b174ac2fb0c90619d10ed3904d9080dc986991) |

Faulty-verifier demo `run_muy2wqs4_6w5xgk`, `FAULTY_VERIFIER=1`, Provider B stale, budget `$0.02` so only B was eligible. Verifier 1 voted PASS. Verifiers 2 and 3 voted FAIL. Settlement used the two fail signatures and refunded the buyer: [refund](https://testnet.monadvision.com/tx/0xac1cb2f76d5710d83d1b1f5d46f52e609dd931027f369250530f657dc18805f1) · [feedback 0](https://testnet.monadvision.com/tx/0xef0931e0296f0253502a3e7e449717752282f28602aff0da1f4062f5e26076e5). The run then stopped because nobody else fit the budget. That is the quorum working: one lying verifier cannot pay a failed provider.

The earlier hosted run on the single-verifier escrow (`run_mux2hlaf_5n161u`, orders settled in `0xabdf0999d4dcdd858263692600a1c5e3f3151d86ffce7edf5927c7088b3bd2e5` and `0xf9ccc7ec3796e77f9bca988ddd422004344864f49b2ce9050e41f938152b2e77`) is not part of this escrow's volume.

Ten `SETTLED` orders are on the quorum escrow. Eight paid Provider B `$0.02` with the stale switch off, and two paid Provider C `$0.03`. Provider A has no settlement on this escrow. `pnpm showcase` did not finish one uninterrupted 12-order command: each transaction used 330,202 gas at 102 gwei, about 0.034 MON, and the buyer ran out of gas. The identity owner sent the buyer 0.4 MON in [`0x7a583550c85ffe33bcc674bae3063a9a10a053219657a316512b506e47da4715`](https://testnet.monadvision.com/tx/0x7a583550c85ffe33bcc674bae3063a9a10a053219657a316512b506e47da4715) and 0.05 MON in [`0x8cce1a3b1a8887ecbb58ced8a92349445f18e342bd3dcc0a3becf233b77a2932`](https://testnet.monadvision.com/tx/0x8cce1a3b1a8887ecbb58ced8a92349445f18e342bd3dcc0a3becf233b77a2932). Order 14 had already been funded when the next send was rejected. A later quorum refunded it because the provider process was no longer listening: [`0x3bd984854f05d3c6efde89e25e52558d86c173fc7deff11f23e33e21ef0a20a6`](https://testnet.monadvision.com/tx/0x3bd984854f05d3c6efde89e25e52558d86c173fc7deff11f23e33e21ef0a20a6).

| Order | Provider | Settlement |
| --- | --- | --- |
| 2 | C `$0.03` | [`0x354b68bc…04141`](https://testnet.monadvision.com/tx/0x354b68bc064822db418c79ccc6c75506358c48a6da674b9efa48fcc3bb804141) |
| 4 | B `$0.02` | [`0xfd3d24de…e7deb`](https://testnet.monadvision.com/tx/0xfd3d24de7e02f0a20211b6a8230e209115f8cbf7ad04fbe1dac7ecb954de7deb) |
| 5 | B `$0.02` | [`0x6bc2b631…ab91a`](https://testnet.monadvision.com/tx/0x6bc2b6310c175d5d4e1de78ed39a74d60cbf79a1132f00eeb4294d022cbab91a) |
| 6 | B `$0.02` | [`0xc420c7d0…7cf11`](https://testnet.monadvision.com/tx/0xc420c7d0e55a4898c32dbbd028694802ccd0c39bdc4b53c8478b9f0db417cf11) |
| 7 | B `$0.02` | [`0x7bde9e84…013ad2`](https://testnet.monadvision.com/tx/0x7bde9e84a00021a82cede09e7531dda94d37be3c6dc6872aa56babc051013ad2) |
| 8 | C `$0.03` | [`0xf73addfa…26c4b`](https://testnet.monadvision.com/tx/0xf73addfa0d0111844d55c52fc8f48eed1a39be15ed213168f2ec1dc477026c4b) |
| 10 | B `$0.02` | [`0x8e54cebf…353fc`](https://testnet.monadvision.com/tx/0x8e54cebf5587ed174b7212b20c85ba70941d043e75dbe016782a0d5c2b5353fc) |
| 11 | B `$0.02` | [`0x05ccfea2…c03c6`](https://testnet.monadvision.com/tx/0x05ccfea2dff68de2271a73e920b5b40efd5f679464ea8902f5ca17c9891c03c6) |
| 12 | B `$0.02` | [`0xa1ae5c94…328c1d`](https://testnet.monadvision.com/tx/0xa1ae5c941960eb621ad3d7ba169033fe81958509b4944bc3c02fbe2e3e328c1d) |
| 13 | B `$0.02` | [`0x6bffe815…3c18e`](https://testnet.monadvision.com/tx/0x6bffe81543ccba9fd848f52ea182132a31f2b4a31fa4975f77e09c8b83b3c18e) |

Reputation-mode rankings after the prove, before these extra settlements: C score 0.85 (success 1, volume `$0.03`), B score 0.30 (success 0, volume `$0.00`), A score 0. After the ten payments: C score 0.85 (success 1, orders 5, volume `$0.06`), B score 0.7357 (success 0.57, orders 14, volume `$0.16`), A score 0. B moved up. C stays first because its success rate is still 1 and B still carries the stale-demo fails. A has no verified volume on this escrow.

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
                   coordinator :4200
                         |
                         +-> verifier 1 :4201 \
                         +-> verifier 2 :4202  -> provider A :4101 / B :4102 / C :4103
                         +-> verifier 3 :4203 /
                         |
                         -> settle(orderId, passed, evidenceHashes, signatures)
```

| Path | Role |
| --- | --- |
| `contracts/` | `RovaEscrow.sol`, vendored ECDSA, and Foundry tests |
| `config/` | The only chain configuration, shared ABIs, ranking, money, task parser |
| `gateway/` | One verifier process per key, plus the coordinator that relays `settle` |
| `providers/` | Three seeded ETH/USD responders |
| `agent/` | Deterministic routing, funding, reroute, reputation, HTTP API |
| `web/` | Landing page and the live run screen |
| `scripts/` | `setup`, `prove`, `faulty`, `showcase`, `demo` |

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

`RovaEscrow` is an ERC-20 escrow. The verifier set and the threshold are fixed in the constructor, together with the payment token (Monad testnet USDC, 6 decimals). This deployment is 2 of 3.

Order statuses are `NONE`, `FUNDED`, `SETTLED`, `REFUNDED`, and `EXPIRED_REFUNDED`.

- `createOrder` pulls USDC from the buyer, stores a new id (ids start at 1 and are never reused), and emits `OrderCreated`.
- `settle(id, passed, evidenceHashes, signatures)` is callable by anyone, so a relayer pays the gas. Signature `i` must be EIP-712 `Verdict(orderId, passed, evidenceHashes[i])` over domain name `RovaEscrow`, version `1`, the chain id, and this contract. The contract requires at least `threshold` signatures, strictly ascending signer addresses, every signer a member, the same `passed` value, and a low-s signature with `v` of 27 or 28. `passed` pays the provider and marks `SETTLED`. Otherwise the same transaction refunds the buyer and marks `REFUNDED`. The events include the evidence hashes and the signer addresses.
- Liveness: if no quorum forms before `expiresAt`, anyone can call `refundExpired` and the buyer is refunded. A missing or disagreeing verifier cannot trap the funds.

The contract rejects an empty, zero, or duplicate verifier set, a threshold below 1 or above the set size, zero amounts, the buyer paying themselves, a token other than USDC, expiry in the past, a second settlement, a non-member signer, too few signatures, duplicate or unsorted signers, a signature for another order, contract, or chain, a fail signature reused as a pass, a malleated signature, settlement after expiry, refund before expiry, and fee-on-transfer tokens whose received amount is not the order amount. Pull and push are guarded against reentrancy.

The on-chain object is an order. The UI does not call it anything else.

## Verification

Rova uses a 2-of-3 verifier quorum. In this hackathon deployment all three keys are operated by the Rova team, so this removes single-key compromise but not operator collusion.

Each verifier process holds one key from `VERIFIER_PRIVATE_KEY_1`, `VERIFIER_PRIVATE_KEY_2`, or `VERIFIER_PRIVATE_KEY_3`. It checks the funded order, calls the provider itself, and runs the same response checks: a non-empty body, JSON parse, the schema (object, required fields, string / number / integer, const), latency, and timestamp freshness. It hashes its own evidence with keccak256 and returns `{ passed, evidenceHash, evidence, signature }`. It does not send a transaction. The verifier keys need no gas and cannot settle by themselves.

The coordinator asks all three in parallel, keeps the first side that reaches the threshold, sorts those signatures by signer address, and the buyer key relays `settle`. If `settle` reverts because the order expired during the probes, the coordinator calls `refundExpired` instead of leaving the run failed. If the order is already expired before the probes, it does the same.

Each verifier probes the provider, so the provider is called 3 times per order. A later design can fetch once and have the other verifiers re-check a signed transcript. That is not what this deployment does.

`FAULTY_VERIFIER=1`, `2`, or `3` makes that process vote PASS after it has still probed the provider and hashed the real response. The badge on the run screen is `Demo mode: Verifier #N is faulty`. Leave the variable unset for `pnpm prove` and `pnpm showcase`.

A demo failure is not garbage. With `DEMO_STALE=1`, Provider B returns valid `{"symbol":"ETH/USD","price":<spot>,"timestamp":<now-180s>}`. Schema passes. Freshness fails because 180 seconds is older than the 60 second maximum. The run screen and the activity feed show `Demo mode: Provider B serving stale data`.

On startup the verifier, the coordinator, and the agent read `threshold`, `verifierCount`, and `verifierAt` from the escrow. They exit if the code, the threshold, or the signer set does not match `config/deployments.json` and the three keys.

## Rerouting

On `REFUNDED` or `EXPIRED_REFUNDED`, the agent records the refund, does not subtract it from the budget, excludes that provider, and creates a new order for the next eligible provider. On `SETTLED`, it stops and returns the payload. If the gateway does not settle, the agent stops instead of opening another order against an unknown on-chain state. If nobody remains eligible, the run ends as a clean failure.

## ERC-8004

Identity Registry `0x8004A818BFB912233c491871b3d84c89A494BD9e` and Reputation Registry `0x8004B663056A597Dffe9eCcC1965A193B7388713` on Monad testnet (chain id 10143). Both proxies report `getVersion() == "2.0.0"`. `getIdentityRegistry()` on the reputation proxy returns the identity proxy. The Validation Registry is not used.

`giveFeedback` reverts when the caller is the identity owner or operator (`Self-feedback not allowed`). The identity owner key owns the three provider NFTs. The buyer is a different key, funds orders, relays settlement, and is the only address that posts feedback. Verifier keys and provider keys do not send transactions.

Feedback value is `100` or `0` with `valueDecimals` 0, tag1 `rova.settlement`, tag2 `pass` or `fail`. `feedbackHash` is keccak256 of canonical JSON that includes the order id, amount, evidence hash, evidence hashes, signer set, and the settlement transaction. The feedback URI is a `data:application/json` document with those fields plus the per-verifier verdicts. The UI does not post feedback. A failed feedback transaction is shown as an error and does not hide the settlement.

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

Rova therefore uses direct escrow: the buyer approves USDC once (max allowance, because a refund does not restore allowance) and calls `createOrder`. The order id and funding transaction are passed to each verifier, which calls the provider. x402 addresses stay in `config/monad.ts` with `usedForEscrow: false`.

The Monad API Hub is mainnet-only (`eip155:143`) and its x402 payments are not refundable. It is not a fourth provider in this demo.

## Run locally

Requirements: Node 20, pnpm, Foundry, and funded wallets as above.

```bash
pnpm install
pnpm run setup          # deploy escrow, register three identities, write config/deployments.json
pnpm prove              # B stale -> 3-of-3 refund -> new order -> C paid
pnpm faulty             # one verifier always votes PASS; 2-of-3 still refunds B
pnpm showcase           # 12 fresh settlements, rankings move
pnpm demo               # providers, three verifiers, coordinator, agent, and the web UI
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

A backup recording was not made. This environment has no browser capture. The hosted run above is the on-chain record.

## Trust assumptions and limits

- Demo providers are seeded by the Rova team. There is no public marketplace.
- Payments are Monad testnet USDC. The hosted run above is one refund and one payment.
- Rova uses a 2-of-3 verifier quorum. In this hackathon deployment all three keys are operated by the Rova team, so this removes single-key compromise but not operator collusion.
- Verification covers machine-checkable conditions only. Rova does not establish semantic truth.
- Reputation comes from a single buyer. Log-weighted volume only partly reduces self-dealing.
- `getSummary` on the reputation registry requires a non-empty client filter. Rankings read `getClients` and then `readAllFeedback`.

## Competitive position

Agent escrow is not new. Metrik, agora402, x402r, Settld, OnlyTrust, and Chainlink-related agent payment work already hold or verify funds around agent purchases. Rova does not claim to have invented escrow for AI agents.

Rova combines conditional settlement with autonomous provider selection and automatic rerouting. A failed provider is refunded before the next attempt, and that attempt is a new order. Provider reputation is posted only after settlement and the feedback hash includes that settlement transaction, through the ERC-8004 contracts already deployed on Monad. The hackathon demo is the whole loop on Monad testnet, not a mocked receipt.

Google's AP2 uses Mandates for authorization before a payment. Rova is the other half: did the seller deliver the machine-checkable conditions. The on-chain object in this app is an order.

## Roadmap

- Independent verifier operators, instead of three keys run by the Rova team.
- Staking and slashing for a verifier that signs against the checks.
- TEE or zkTLS attestations of the provider response.
- Decentralized verifier selection.
- One provider fetch plus transcript re-verification, instead of calling the provider once per verifier.

Not in this MVP: a public marketplace (Monad already has an API Hub), subcontracting chains, a general dispute court, semantic truth verification, a complex spend-policy engine, the ERC-8004 Validation Registry, and cross-chain execution.

## Acceptance

- [x] `RovaEscrow` 2-of-3 quorum, with Foundry tests for pass, fail, mixed votes, threshold, non-member, duplicate, unsorted, wrong order, wrong contract, wrong chain, fail-as-pass, expiry, relay, malleability, events, and balances. 31 tests passed
- [x] New escrow `0x2B50654E5B39e44596f06878288F9eEAA79551c3` on Monad testnet USDC. Sourcify `exact_match`
- [x] 3-of-3 fail refunded Provider B and 3-of-3 pass paid Provider C on that escrow
- [x] `FAULTY_VERIFIER=1` still refunded B from the two honest fail signatures
- [x] Failure rerouted to a new order and Provider C settled
- [x] Each verifier checks latency, freshness, schema, and a non-empty response
- [x] Three seeded providers; B can serve stale-but-valid JSON; the stale badge and the faulty badge are in the UI
- [ ] Frontend clicked in a browser. The run record stores the real per-verifier signatures. The pages were fetched, not clicked
- [x] `pnpm demo` starts providers, three verifiers, the coordinator, the agent, and the frontend after setup
- [x] ERC-8004 identities 2033, 2034, and 2035. Feedback hash includes the signer set and the evidence hashes
- [x] 10 settlements on this escrow. B's reputation-mode score moved from 0.30 to 0.7357. One 12-order showcase command stopped when the buyer ran out of MON. Provider A was not paid on this escrow
- [x] README states the quorum, the shared operator, and the collusion limit
