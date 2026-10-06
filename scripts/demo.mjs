import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", ".bin", "tsx");

if (!existsSync(path.join(root, "config", "deployments.json"))) {
  console.error("config/deployments.json is missing. Fund the wallets, then run pnpm run setup.");
  process.exit(1);
}
if (!existsSync(tsx)) {
  console.error("Dependencies are missing. Run pnpm install.");
  process.exit(1);
}

const children = [];
let stopping = false;

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 400);
}

function start(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (signal === "SIGTERM" || signal === "SIGINT") return;
    console.error(`${label} exited ${code ?? signal}`);
    shutdown(code || 1);
  });
  children.push(child);
}

const stale = process.env.DEMO_STALE ?? "1";
const publicPort = process.env.PORT;
start("providers", tsx, [path.join(root, "providers/src/index.ts")], { DEMO_STALE: stale });
start("gateway", tsx, [path.join(root, "gateway/src/index.ts")], {});
start("agent", tsx, [path.join(root, "agent/src/index.ts")], {});

if (publicPort) {
  start("web", "pnpm", ["--filter", "@rova/web", "exec", "vite", "preview", "--host", "0.0.0.0", "--port", publicPort, "--strictPort"], {});
} else {
  start("web", "pnpm", ["--filter", "@rova/web", "dev"], {});
}

console.log("ROVA demo");
console.log(publicPort ? `Listening on 0.0.0.0:${publicPort}` : "Live run: http://127.0.0.1:5173/run");
console.log(stale === "1" ? "Demo mode: Provider B serving stale data" : "Demo stale switch is off");

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
