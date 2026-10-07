import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { root } from "../config/env.ts";
import { VERIFIER_PORTS } from "../config/providers.ts";

export async function waitHealth(
  url: string,
  accept: (body: unknown) => boolean,
  attempts = 40,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (response.ok && accept(await response.json())) return true;
    } catch {
      // The process is still starting, or nothing is listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export function startTsx(script: string, env: Record<string, string>): ChildProcess {
  const tsx = path.join(root, "node_modules", ".bin", "tsx");
  return spawn(tsx, [path.join(root, script)], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
}

export function stop(child: ChildProcess | null): void {
  if (!child || child.killed || child.exitCode !== null) return;
  child.kill("SIGTERM");
}

function faultyEnv(expectFaulty: number | null): Record<string, string> {
  return { FAULTY_VERIFIER: expectFaulty === null ? "" : String(expectFaulty) };
}

export async function ensureVerifiers(expectFaulty: number | null): Promise<ChildProcess[]> {
  const started: ChildProcess[] = [];
  for (let index = 1; index <= VERIFIER_PORTS.length; index += 1) {
    const url = `http://127.0.0.1:${VERIFIER_PORTS[index - 1]}/health`;
    const wantFaulty = expectFaulty === index;
    const matches = (body: unknown) => {
      const record = body as { ok?: boolean; index?: number; faulty?: boolean };
      return record.ok === true && record.index === index && record.faulty === wantFaulty;
    };
    if (await waitHealth(url, matches, 2)) continue;
    if (await waitHealth(url, (body) => (body as { ok?: boolean }).ok === true, 1)) {
      throw new Error(`Verifier ${index} is already running with a different faulty switch. Stop it, then rerun.`);
    }
    const child = startTsx("gateway/src/verifier.ts", { VERIFIER_INDEX: String(index), ...faultyEnv(expectFaulty) });
    started.push(child);
    if (!(await waitHealth(url, matches, 80))) {
      stop(child);
      throw new Error(`Verifier ${index} did not become healthy.`);
    }
    console.log(`Left verifier ${index} running.`);
  }
  return started;
}

export async function ensureCoordinator(expectFaulty: number | null): Promise<ChildProcess | null> {
  const want = expectFaulty === null ? null : `Demo mode: Verifier #${expectFaulty} is faulty`;
  const matches = (body: unknown) => {
    const record = body as { ok?: boolean; service?: string; faultyBadge?: string | null };
    return record.ok === true && record.service === "coordinator" && (record.faultyBadge ?? null) === want;
  };
  if (await waitHealth("http://127.0.0.1:4200/health", matches, 2)) return null;
  if (await waitHealth("http://127.0.0.1:4200/health", (body) => (body as { ok?: boolean }).ok === true, 1)) {
    throw new Error("A gateway is already running with a different faulty switch. Stop it, then rerun.");
  }
  const child = startTsx("gateway/src/index.ts", faultyEnv(expectFaulty));
  if (!(await waitHealth("http://127.0.0.1:4200/health", matches, 80))) {
    stop(child);
    throw new Error("Coordinator did not become healthy.");
  }
  console.log("Left the coordinator running.");
  return child;
}
