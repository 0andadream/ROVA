import { externalHref, type Meta } from "./api";
import { Trust } from "./Trust";

export function About({ meta }: { meta: Meta | null }) {
  const escrow = externalHref(meta?.escrowUrl);
  return (
    <main className="max-w-3xl px-5 pb-16 pt-24 md:px-8">
      <h1 className="text-[26px] leading-snug">How Rova works</h1>
      <div className="mt-8 space-y-5 text-[15px] leading-relaxed">
        <p>
          You give Rova a task, a total budget, and machine-checkable conditions. Rova finds eligible providers, ranks them with deterministic code, locks the price in RovaEscrow, and pays only if the checks pass.
        </p>
        <p>
          If a provider fails, the same settlement transaction refunds the buyer. Rova then opens a new order with the next provider. A failed order id is never reused.
        </p>
        <p>
          Routing does not use an LLM. The demo ranks by price while Provider B is serving stale data, so the recorded run starts with the cheapest provider. Otherwise the score is 0.70 reputation and 0.30 price advantage. Reputation is success rate times log10 of verified settlement volume.
        </p>
        <p>{meta?.paymentPath.summary ?? "Payments are direct USDC escrow orders. x402 exact and upto payments settle immediately, so they cannot hold a refundable order."}</p>
        <p>Rova is not a new kind of agent escrow. It joins conditional settlement, automatic rerouting, and ERC-8004 feedback that points at the settlement transaction.</p>
        {escrow && (
          <p>
            <a className="underline" href={escrow} target="_blank" rel="noreferrer">
              RovaEscrow on {meta?.explorerName}
            </a>
          </p>
        )}
        {meta?.x402 && !meta.x402.usedForEscrow && (
          <p className="text-mute">x402 facilitator {meta.x402.facilitatorUrl} is live for {meta.x402.network} and is not used to fund escrow.</p>
        )}
      </div>
      <Trust meta={meta} />
    </main>
  );
}
