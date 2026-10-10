// One-page dashboard. The browser talks to /rpc on this origin.
// The proxy target is web/config.json "rpc", then RPC_URL, then local Anvil.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = join(root, "web");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

async function rpcTarget() {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  try {
    const cfg = JSON.parse(await readFile(join(web, "config.json"), "utf8"));
    if (typeof cfg.rpc === "string" && cfg.rpc) return cfg.rpc;
  } catch {
    // The demo has not written a config yet.
  }
  return "http://127.0.0.1:8545";
}

function insideWeb(path) {
  const base = normalize(web + "/");
  return path === normalize(web) || path.startsWith(base);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/rpc") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const target = await rpcTarget();
      const upstream = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.concat(chunks)
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(text);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD, POST" });
      res.end();
      return;
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel === "/") rel = "/index.html";
    rel = rel.replace(/^\/+/, "");
    if (!rel || rel.includes("..")) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    const path = normalize(join(web, rel));
    if (!insideWeb(path)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    const body = await readFile(path);
    const headers = {
      "content-type": types[extname(path)] || "application/octet-stream"
    };
    if (extname(path) === ".json" || extname(path) === ".html" || extname(path) === ".js") {
      headers["cache-control"] = "no-store";
    }
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("not found");
      return;
    }
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("error");
  }
});

server.listen(port, host, () => {
  console.log(`http://${host}:${port}`);
});
