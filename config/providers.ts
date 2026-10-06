export const SEEDS = [
  { id: "A", name: "Provider A", port: 4101, price: "0.04", delayMs: 160 },
  { id: "B", name: "Provider B", port: 4102, price: "0.02", delayMs: 240 },
  { id: "C", name: "Provider C", port: 4103, price: "0.03", delayMs: 900 },
] as const;

export type SeedId = (typeof SEEDS)[number]["id"];

export function providerUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export const GATEWAY_PORT = 4200;
export const AGENT_PORT = 4300;

export const DEMO_BADGE = "Demo mode: Provider B serving stale data";

export function gatewayBase(): string {
  return process.env.GATEWAY_URL ?? `http://127.0.0.1:${GATEWAY_PORT}`;
}
