export function explain(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { shortMessage?: string; details?: string };
    if (record.shortMessage === "RPC Request failed." && typeof record.details === "string" && record.details) {
      return record.details;
    }
    if (typeof record.shortMessage === "string") return record.shortMessage;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
