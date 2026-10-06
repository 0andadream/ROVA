export type SimpleSchema = {
  type?: string;
  required?: readonly string[];
  properties?: Record<string, { type?: string; const?: string | number }>;
};

export type Verification = {
  ok: boolean;
  requestOk: boolean;
  nonEmpty: boolean;
  schemaOk: boolean;
  latencyOk: boolean;
  freshnessOk: boolean;
  latencyMs: number;
  timestamp: number | null;
  ageSec: number | null;
  reasons: string[];
  response: unknown;
};

function typeOk(value: unknown, expected: string | undefined): boolean {
  if (!expected) return true;
  if (expected === "string") return typeof value === "string";
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  return false;
}

export function verifyResponse(input: {
  httpOk: boolean;
  bodyText: string;
  latencyMs: number;
  maxLatencyMs: number;
  maxAgeSec: number;
  nowSec: number;
  schema: SimpleSchema;
}): Verification {
  const reasons: string[] = [];
  const nonEmpty = input.bodyText.trim().length > 0;
  if (!nonEmpty) reasons.push("response body is empty");
  const requestOk = input.httpOk;
  if (!requestOk) reasons.push("provider request failed");

  let response: unknown = null;
  let schemaOk = false;
  if (nonEmpty) {
    try {
      response = JSON.parse(input.bodyText);
    } catch {
      reasons.push("response is not JSON");
    }
  }

  if (response !== null) {
    const schema = input.schema;
    const problems: string[] = [];
    if (schema.type !== "object" || response === null || typeof response !== "object" || Array.isArray(response)) {
      problems.push("response is not the expected object");
    } else {
      const record = response as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (record[key] === undefined || record[key] === null) problems.push(`missing ${key}`);
      }
      for (const [key, rule] of Object.entries(schema.properties ?? {})) {
        if (record[key] === undefined) continue;
        if (!typeOk(record[key], rule.type)) problems.push(`${key} has the wrong type`);
        if (rule.const !== undefined && record[key] !== rule.const) problems.push(`${key} is ${String(record[key])}`);
      }
    }
    schemaOk = problems.length === 0;
    reasons.push(...problems);
  }

  const latencyOk = input.latencyMs >= 0 && input.latencyMs <= input.maxLatencyMs;
  if (!latencyOk) reasons.push(`latency ${input.latencyMs}ms exceeds ${input.maxLatencyMs}ms`);

  let timestamp: number | null = null;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const raw = (response as Record<string, unknown>).timestamp;
    if (typeof raw === "number" && Number.isInteger(raw)) timestamp = raw;
  }
  let ageSec: number | null = null;
  let freshnessOk = false;
  if (timestamp === null) {
    reasons.push("response has no integer timestamp");
  } else {
    ageSec = input.nowSec - timestamp;
    if (ageSec < 0) reasons.push("timestamp is in the future");
    else if (ageSec > input.maxAgeSec) reasons.push(`response age ${ageSec}s exceeds max ${input.maxAgeSec}s`);
    else freshnessOk = true;
  }

  return {
    ok: requestOk && nonEmpty && schemaOk && latencyOk && freshnessOk,
    requestOk,
    nonEmpty,
    schemaOk,
    latencyOk,
    freshnessOk,
    latencyMs: input.latencyMs,
    timestamp,
    ageSec,
    reasons,
    response,
  };
}
