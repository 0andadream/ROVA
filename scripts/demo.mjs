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

function start(label, file, env) {
  const child = spawn(tsx, [path.join(root, file)], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    if (code && code !== 0) console.error(`${label} exited ${code}`);
  });
  children.push(child);
}

const stale = process.env.DEMO_STALE ?? "1";
start("providers", "providers/src/index.ts", { DEMO_STALE: stale });
start("gateway", "gateway/src/index.ts", {});
start("agent", "agent/src/index.ts", {});

const web = spawn("pnpm", ["--filter", "@rova/web", "dev"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
children.push(web);

console.log("ROVA demo");
console.log("Live run: http://127.0.0.1:5173/run");
console.log(stale === "1" ? "Demo mode: Provider B serving stale data" : "Demo stale switch is off");

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 400);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
