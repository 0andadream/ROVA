export type ProviderInput = {
  id: string;
  name: string;
  address: string;
  priceAtomic: bigint;
  successRate: number;
  orders: number;
  verifiedVolumeAtomic: bigint;
  active: boolean;
  task: string;
};

export type RankedProvider = ProviderInput & {
  eligible: boolean;
  reason: string;
  reputationScore: number;
  priceAdvantage: number;
  score: number;
};

export const REPUTATION_FORMULA =
  "reputation = successRate × log10(1 + verifiedVolume). verifiedVolume is settled USDC in 6-decimal units. score = 0.70 × normalized reputation + 0.30 × normalized price advantage. Ties break to the lower price, then the provider address.";

export const PRICE_FORMULA =
  "Demo routing ranks eligible providers by price alone, so the recorded run starts with Provider B. Reputation is still written on-chain and shown in the table.";

function log10OnePlus(volume: bigint): number {
  if (volume <= 0n) return 0;
  const asNumber = Number(volume);
  if (Number.isSafeInteger(asNumber)) return Math.log10(1 + asNumber);
  return Math.log10(1 + Number(volume / 1_000n) * 1_000);
}

function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 1);
  return values.map((value) => (value - min) / (max - min));
}

function compareRank(left: RankedProvider, right: RankedProvider): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.priceAtomic !== right.priceAtomic) return left.priceAtomic < right.priceAtomic ? -1 : 1;
  return left.address.toLowerCase().localeCompare(right.address.toLowerCase());
}

export function evaluateProviders(
  inputs: ProviderInput[],
  options: {
    mode: "reputation" | "price";
    maxPriceAtomic: bigint;
    remainingAtomic: bigint;
    task: string;
    onlyIds?: string[];
  },
): RankedProvider[] {
  const allow = options.onlyIds ? new Set(options.onlyIds) : null;
  const marked = inputs.map((provider) => {
    let reason = "";
    if (!provider.active) reason = "inactive";
    else if (provider.task !== options.task) reason = "does not serve this task";
    else if (allow && !allow.has(provider.id)) reason = "outside this showcase slice";
    else if (provider.priceAtomic > options.maxPriceAtomic) reason = "above the per-request cap";
    else if (provider.priceAtomic > options.remainingAtomic) reason = "above the remaining budget";
    const priceAdvantage =
      options.maxPriceAtomic === 0n
        ? 0
        : Number(options.maxPriceAtomic - provider.priceAtomic) / Number(options.maxPriceAtomic);
    const reputationScore = provider.successRate * log10OnePlus(provider.verifiedVolumeAtomic);
    return {
      ...provider,
      eligible: reason === "",
      reason,
      reputationScore,
      priceAdvantage: provider.priceAtomic > options.maxPriceAtomic ? 0 : priceAdvantage,
      score: 0,
    };
  });

  const eligible = marked.filter((provider) => provider.eligible);
  const reputationNorm = normalize(eligible.map((provider) => provider.reputationScore));
  const priceNorm = normalize(eligible.map((provider) => provider.priceAdvantage));
  eligible.forEach((provider, index) => {
    provider.score =
      options.mode === "price" ? provider.priceAdvantage : 0.7 * reputationNorm[index] + 0.3 * priceNorm[index];
  });
  eligible.sort(compareRank);
  const ineligible = marked.filter((provider) => !provider.eligible).sort((left, right) => left.id.localeCompare(right.id));
  return [...eligible, ...ineligible];
}
