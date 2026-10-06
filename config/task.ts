export const ETH_USD_TASK = "eth-usd";

export const ETH_USD_SCHEMA = {
  type: "object",
  required: ["symbol", "price", "timestamp"],
  properties: {
    symbol: { type: "string", const: "ETH/USD" },
    price: { type: "number" },
    timestamp: { type: "integer" },
  },
} as const;

export function parseTask(task: string): { taskId: typeof ETH_USD_TASK } | { error: string } {
  const text = task.toLowerCase();
  const mentionsEth = text.includes("eth");
  const mentionsPrice = text.includes("usd") || text.includes("price");
  if (mentionsEth && mentionsPrice) return { taskId: ETH_USD_TASK };
  return {
    error: "This demo buys ETH/USD data. The task text did not match that job, so Rova did not open an order.",
  };
}
