import { useEffect, useState } from "react";
import { externalHref, loadRankings, type Meta, type Rankings } from "./api";
import { Trust } from "./Trust";

export function Providers({ meta }: { meta: Meta | null }) {
  const [rankings, setRankings] = useState<Rankings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRankings("0.05", "0.05")
      .then(setRankings)
      .catch((reason: Error) => setError(reason.message));
  }, []);

  return (
    <main className="px-5 pb-16 pt-24 md:px-8">
      <h1 className="text-[26px]">Providers</h1>
      <p className="mt-4 max-w-2xl text-[15px] text-mute">Demo providers are seeded by the Rova team. This is not a public marketplace.</p>
      {meta?.demoBadge && <p className="mt-4 inline-block rounded-full border border-fail px-3 py-1 text-[15px] text-fail">{meta.demoBadge}</p>}
      {error && <p className="mt-4 text-[15px] text-fail">{error}</p>}
      <div className="mt-8 grid gap-6 md:grid-cols-3">
        {(rankings?.providers ?? []).map((provider) => {
          const addressUrl = externalHref(provider.addressUrl);
          const registerUrl = externalHref(provider.registerUrl);
          return (
            <article key={provider.id} className="border-t border-line pt-4">
              <h2 className="text-[26px]">{provider.name}</h2>
              <p className="mt-2 text-[15px]">${provider.price} USDC</p>
              <p className="mt-2 text-[15px] text-mute">
                Rank {provider.rank ?? "–"} · success {(provider.successRate * 100).toFixed(0)}% · orders {provider.orders} · volume ${provider.verifiedVolume} · score {provider.score}
              </p>
              {!provider.eligible && <p className="text-[15px] text-mute">{provider.reason}</p>}
              <p className="mt-3 text-[15px]">
                {addressUrl ? (
                  <a className="underline" href={addressUrl} target="_blank" rel="noreferrer">
                    Payment address
                  </a>
                ) : (
                  "Payment address pending setup"
                )}
                {provider.agentId ? ` · ERC-8004 #${provider.agentId}` : ""}
              </p>
              {registerUrl && (
                <a className="text-[15px] underline" href={registerUrl} target="_blank" rel="noreferrer">
                  Registration transaction
                </a>
              )}
            </article>
          );
        })}
        {!rankings &&
          (meta?.providers ?? []).map((provider) => (
            <article key={provider.id} className="border-t border-line pt-4">
              <h2 className="text-[26px]">{provider.name}</h2>
              <p className="mt-2 text-[15px]">${provider.price} USDC</p>
              <p className="mt-3 text-[15px] text-mute">Rankings appear after the deployment and providers are online.</p>
            </article>
          ))}
      </div>
      <Trust meta={meta} />
    </main>
  );
}
