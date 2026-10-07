export function explain(error: unknown): string {
  const details: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { details?: string; cause?: unknown };
    if (typeof record.details === "string" && record.details && record.details !== "RPC Request failed.") {
      details.push(record.details);
    }
    current = record.cause;
  }
  if (details.length > 0) return details[details.length - 1];
  if (error && typeof error === "object" && typeof (error as { shortMessage?: string }).shortMessage === "string") {
    return (error as { shortMessage: string }).shortMessage;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
