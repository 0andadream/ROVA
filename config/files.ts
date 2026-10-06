import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evidenceDir, runsDir } from "./env.ts";

export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function evidenceFile(orderId: string): string {
  return path.join(evidenceDir(), `${orderId}.json`);
}

export function runFile(runId: string): string {
  return path.join(runsDir(), `${runId}.json`);
}
