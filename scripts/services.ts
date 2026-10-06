import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { root } from "../config/env.ts";

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
