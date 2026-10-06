import type { Meta } from "./api";

const FALLBACK = {
  verifier: "Rova currently uses one trusted verifier. Decentralized verification is future work.",
  truth:
    "Rova checks machine-checkable conditions only: the response exists, the request succeeded, the JSON matches the schema, latency is inside the limit, and the timestamp is fresh. Rova does not decide whether a price is true.",
  providers: "Demo providers are seeded by the Rova team.",
  reputation: "Reputation in this demo comes from one buyer. Log-weighted volume only partly limits self-dealing.",
};

export function Trust({ meta }: { meta: Meta | null }) {
  const trust = meta?.trust ?? FALLBACK;
  return (
    <footer className="mt-12 max-w-3xl space-y-2 text-[15px] leading-relaxed text-mute">
      <p>{trust.verifier}</p>
      <p>{trust.truth}</p>
      <p>{trust.providers}</p>
      <p>{trust.reputation}</p>
    </footer>
  );
}
