const SCALE = 1_000_000n;

export function parseUsdc(input: string): bigint {
  const value = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(value)) {
    throw new Error(`Amount ${input} is not a USDC value with at most 6 decimals.`);
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, "0"));
}

export function formatUsdc(amount: bigint): string {
  const negative = amount < 0n;
  const value = negative ? -amount : amount;
  const whole = value / SCALE;
  const fraction = value % SCALE;
  const cents = (fraction / 10_000n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${cents}`;
}
