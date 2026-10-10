const UNIT = 10n ** 18n;
const scoreEl = document.querySelector("#score");
const ledeEl = document.querySelector("#lede");
const metaEl = document.querySelector("#meta");
const barEl = document.querySelector("#bar");
const figuresEl = document.querySelector("#figures");
const chainNoteEl = document.querySelector("#chain-note");
const listNoteEl = document.querySelector("#list-note");
const rowsEl = document.querySelector("#rows");

let cfg = null;
let snap = null;
let busy = false;

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[ch]));
}

function units(wei) {
  const value = BigInt(wei);
  const whole = value / UNIT;
  const frac = (value % UNIT) / 10n ** 16n;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

function short(addr) {
  if (!addr) return "";
  const text = String(addr);
  if (text.length < 12) return text;
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

function pct(part, total) {
  if (total === 0n) return "0%";
  const bps = (part * 10000n) / total;
  return `${Number(bps) / 100}%`;
}

function bar(available, reserved, spent, cap) {
  const free = BigInt(available);
  const held = BigInt(reserved);
  const paid = BigInt(spent);
  const limit = BigInt(cap);
  const total = free + held + paid;
  if (total === 0n) return `<div class="track"></div>`;
  const used = held + paid;
  const overshoot = used > limit ? used - limit : 0n;
  const paidOver = overshoot > paid ? paid : overshoot;
  const paidIn = paid - paidOver;
  const heldOver = overshoot - paidOver;
  const heldIn = held - heldOver;
  const parts = [
    ["available", free],
    ["reserved", heldIn],
    ["over", heldOver],
    ["spent", paidIn],
    ["over", paidOver]
  ];
  const segs = parts
    .filter(([, amount]) => amount > 0n)
    .map(([name, amount]) => `<i class="${name}" style="width:${pct(amount, total)}"></i>`)
    .join("");
  const tick = overshoot > 0n ? `<b class="tick" style="left:${pct(limit, total)}"></b>` : "";
  return `<div class="track">${segs}${tick}</div>`;
}

function txCell(hash) {
  const label = `${hash.slice(0, 10)}…${hash.slice(-4)}`;
  if (cfg && cfg.explorer) {
    const href = `${String(cfg.explorer).replace(/\/$/, "")}/tx/${hash}`;
    return `<a class="tx" title="${esc(hash)}" href="${esc(href)}">${esc(label)}</a>`;
  }
  return `<span class="tx" title="${esc(hash)}">${esc(label)}</span>`;
}

function row(kind, who, amount, hash) {
  return `<div class="row">
    <span class="kind ${esc(kind.toLowerCase())}">${esc(kind)}</span>
    <span class="who" title="${esc(who || "")}">${esc(short(who))}</span>
    <span>${esc(units(amount))}</span>
    ${hash ? txCell(hash) : "<span></span>"}
  </div>`;
}

function renderScore() {
  if (!snap || !snap.naive || !snap.reserved) {
    scoreEl.hidden = true;
    scoreEl.innerHTML = "";
    return;
  }
  scoreEl.hidden = false;
  const cap = snap.cap;
  ledeEl.textContent = "Twenty agents each try to spend 1. The cap is 10. The pool holds 30.";
  metaEl.textContent = snap.local
    ? "Recorded on local Anvil. Hashes below are from that node."
    : "Recorded on Monad testnet.";
  scoreEl.innerHTML = `
    <article class="card fail">
      <h2>Check, then pay</h2>
      <p class="big">${esc(units(snap.naive.spent))}</p>
      <p>spent · cap ${esc(units(cap))} · overshoot ${esc(units(snap.naive.overshoot))}</p>
      ${bar(0, 0, snap.naive.spent, cap)}
    </article>
    <article class="card pass">
      <h2>Reserve, then pay</h2>
      <p class="big">${esc(units(snap.reserved.spent))}</p>
      <p>spent · ${esc(snap.reserved.accepted)} accepted · ${esc(snap.reserved.refused)} refused</p>
      ${bar(0, 0, snap.reserved.spent, cap)}
    </article>`;
}

function renderBar(state, note) {
  chainNoteEl.textContent = note;
  if (!state) {
    barEl.innerHTML = `<div class="track"></div>`;
    figuresEl.textContent = "";
    return;
  }
  barEl.innerHTML = bar(state.available, state.reserved, state.spent, state.cap);
  const bits = [
    `available ${units(state.available)}`,
    `reserved ${units(state.reserved)}`,
    `spent ${units(state.spent)}`,
    `overshoot ${units(state.overshoot)}`,
    `pool ${units(state.pool)}`
  ];
  if (state.vendorNaive != null) bits.push(`naive vendor ${units(state.vendorNaive)}`);
  if (state.vendorReserved != null) bits.push(`reserved vendor ${units(state.vendorReserved)}`);
  figuresEl.textContent = bits.join("  ·  ");
}

function renderRows(rows, note) {
  listNoteEl.textContent = note;
  if (!rows.length) {
    rowsEl.innerHTML = `<p class="empty">No pool yet. Start anvil, run node scripts/demo.mjs, and leave this page open.</p>`;
    return;
  }
  rowsEl.innerHTML = rows.map((item) => row(item.kind, item.agent || item.who || "", item.paid ?? item.amount, item.tx)).join("");
}

function snapshotRows() {
  if (!snap) return [];
  return [...(snap.naive?.rows || []), ...(snap.reserved?.rows || [])];
}

async function loadJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

async function rpc(method, params) {
  const res = await fetch("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const body = await res.json();
  if (body.error) {
    const detail = body.error.data && body.error.data.message ? body.error.data.message : body.error.message;
    throw new Error(detail || "rpc error");
  }
  return body.result;
}

function word(data, index) {
  const hex = String(data || "0x").slice(2);
  const slice = hex.slice(index * 64, index * 64 + 64);
  if (!slice) return 0n;
  return BigInt(`0x${slice}`);
}

function topicAddr(topic) {
  return `0x${topic.slice(-40)}`;
}

function decodeLog(log) {
  const topics = cfg.topics || {};
  const sig = (log.topics && log.topics[0]) || "";
  if (sig === topics.NaiveSpend) {
    return { kind: "NAIVE", agent: topicAddr(log.topics[1]), amount: word(log.data, 0), paid: word(log.data, 1), tx: log.transactionHash };
  }
  if (sig === topics.Reserved) {
    return { kind: "RESERVE", agent: topicAddr(log.topics[3]), amount: word(log.data, 0), tx: log.transactionHash };
  }
  if (sig === topics.Refused) {
    return { kind: "REFUSED", agent: topicAddr(log.topics[2]), amount: word(log.data, 0), tx: log.transactionHash };
  }
  if (sig === topics.Committed) {
    return { kind: "COMMIT", who: topicAddr(log.topics[2]), amount: word(log.data, 0), tx: log.transactionHash };
  }
  if (sig === topics.Released) {
    return { kind: "RELEASE", agent: topicAddr(log.topics[2]), amount: word(log.data, 0), tx: log.transactionHash };
  }
  if (sig === topics.Funded) {
    return { kind: "FUND", who: topicAddr(log.topics[1]), amount: word(log.data, 0), tx: log.transactionHash };
  }
  if (sig === topics.Reset) {
    return { kind: "RESET", who: topicAddr(log.topics[1]), amount: word(log.data, 0), tx: log.transactionHash };
  }
  return null;
}

function balanceData(addr) {
  return `0x70a08231${addr.slice(2).toLowerCase().padStart(64, "0")}`;
}

async function readChain() {
  const names = ["available", "reserved", "spent", "overshoot", "poolBalance", "cap"];
  const values = await Promise.all(names.map((name) => rpc("eth_call", [{ to: cfg.rova, data: cfg.selectors[name] }, "latest"])));
  const state = {
    available: BigInt(values[0]),
    reserved: BigInt(values[1]),
    spent: BigInt(values[2]),
    overshoot: BigInt(values[3]),
    pool: BigInt(values[4]),
    cap: BigInt(values[5])
  };
  if (cfg.token && cfg.vendorNaive && cfg.vendorReserved) {
    const [naiveBal, reservedBal] = await Promise.all([
      rpc("eth_call", [{ to: cfg.token, data: balanceData(cfg.vendorNaive) }, "latest"]),
      rpc("eth_call", [{ to: cfg.token, data: balanceData(cfg.vendorReserved) }, "latest"])
    ]);
    state.vendorNaive = BigInt(naiveBal);
    state.vendorReserved = BigInt(reservedBal);
  }
  const logs = await rpc("eth_getLogs", [{ address: cfg.rova, fromBlock: cfg.fromBlock || "0x0", toBlock: "latest" }]);
  const rows = logs.map(decodeLog).filter(Boolean);
  return { state, rows };
}

function recordedState() {
  if (!snap || !snap.final) return null;
  return {
    available: snap.final.available,
    reserved: snap.final.reserved,
    spent: snap.final.spent,
    overshoot: snap.final.overshoot,
    pool: snap.final.pool,
    cap: snap.cap,
    vendorNaive: snap.final.vendorNaive,
    vendorReserved: snap.final.vendorReserved
  };
}

async function once() {
  cfg = await loadJson("/config.json");
  snap = await loadJson("/snapshot.json");
  if (!snap) snap = await loadJson("/recording.json");
  renderScore();
  if (!cfg || !cfg.rova) {
    const note = snap && snap.final
      ? "Recorded Anvil run. This page has no chain attached."
      : "Waiting for the demo to deploy a pool.";
    renderBar(recordedState(), note);
    renderRows(snapshotRows(), snap && snap.final ? "Recorded run" : "");
    return;
  }
  metaEl.textContent = `${cfg.local ? "Local Anvil" : "Monad testnet " + cfg.chainId} · ${cfg.rova}`;
  try {
    const live = await readChain();
    renderBar(live.state, cfg.local ? "Live on this machine." : "Live on Monad testnet.");
    renderRows(live.rows, `${live.rows.length} events`);
  } catch (err) {
    renderBar(recordedState(), "Chain is not connected. Showing the recorded run.");
    renderRows(snapshotRows(), err.message || "rpc failed");
  }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    await once();
  } catch (err) {
    chainNoteEl.textContent = err.message || "Could not read the page data.";
  } finally {
    busy = false;
  }
}

tick();
setInterval(tick, 2000);
