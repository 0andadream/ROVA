import { useEffect, useState, type FormEvent } from "react";
import { externalHref, loadRankings, loadRun, startRun, type Meta, type Rankings, type RunRecord } from "./api";
import { Trust } from "./Trust";

const field = "w-full border-b border-line bg-transparent py-2 text-[15px] outline-none";

export function Run({ meta }: { meta: Meta | null }) {
  const [task, setTask] = useState("Get ETH/USD price data");
  const [budget, setBudget] = useState("0.05");
  const [maxPrice, setMaxPrice] = useState("0.05");
  const [latency, setLatency] = useState("3000");
  const [freshness, setFreshness] = useState("60");
  const [expiry, setExpiry] = useState("10");
  const [schema, setSchema] = useState("");
  const [run, setRun] = useState<RunRecord | null>(null);
  const [rankings, setRankings] = useState<Rankings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (meta && !schema) setSchema(JSON.stringify(meta.schema, null, 2));
  }, [meta, schema]);

  useEffect(() => {
    let gone = false;
    const pull = () => {
      loadRankings(maxPrice || "0.05", budget || "0.05")
        .then((next) => {
          if (!gone) setRankings(next);
        })
        .catch(() => {
          if (!gone) setRankings(null);
        });
    };
    pull();
    const timer = window.setInterval(pull, run?.status === "running" ? 2000 : 8000);
    return () => {
      gone = true;
      window.clearInterval(timer);
    };
  }, [budget, maxPrice, run?.status, run?.steps.length]);

  useEffect(() => {
    if (!run || run.status !== "running") return;
    const timer = window.setInterval(() => {
      loadRun(run.id)
        .then(setRun)
        .catch((reason: Error) => setError(reason.message));
    }, 800);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const started = await startRun({
        task,
        totalBudget: budget,
        maxPrice,
        maxLatencyMs: Number(latency),
        maxAgeSec: Number(freshness),
        expiryMinutes: Number(expiry),
        schema,
      });
      setRun(await loadRun(started.runId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The run did not start.");
    } finally {
      setBusy(false);
    }
  }

  const badge = meta?.demoBadge;

  return (
    <main className="px-5 pb-16 pt-24 md:px-8">
      {badge && (
        <p className="mb-6 inline-block rounded-full border border-fail px-3 py-1 text-[15px] text-fail">{badge}</p>
      )}
      <div className="grid items-start gap-10 lg:grid-cols-[280px_minmax(0,1fr)_300px]">
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <label className="text-[15px] text-mute">
            Task
            <textarea className={`${field} min-h-24 resize-y`} value={task} onChange={(event) => setTask(event.target.value)} />
          </label>
          <label className="text-[15px] text-mute">
            Total budget (USDC)
            <input className={field} value={budget} onChange={(event) => setBudget(event.target.value)} />
          </label>
          <label className="text-[15px] text-mute">
            Max provider price
            <input className={field} value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} />
          </label>
          <label className="text-[15px] text-mute">
            Max latency (ms)
            <input className={field} value={latency} onChange={(event) => setLatency(event.target.value)} />
          </label>
          <label className="text-[15px] text-mute">
            Max data age (sec)
            <input className={field} value={freshness} onChange={(event) => setFreshness(event.target.value)} />
          </label>
          <label className="text-[15px] text-mute">
            Expiry (minutes)
            <input className={field} value={expiry} onChange={(event) => setExpiry(event.target.value)} />
          </label>
          <label className="text-[15px] text-mute">
            Schema
            <textarea className={`${field} min-h-36 font-mono text-[13px]`} value={schema} onChange={(event) => setSchema(event.target.value)} />
          </label>
          <button className="mt-2 rounded-full bg-ink px-4 py-2 text-[15px] text-paper disabled:opacity-40" disabled={busy || run?.status === "running"} type="submit">
            {run?.status === "running" ? "Running" : "RUN ROVA"}
          </button>
          {error && <p className="text-[15px] text-fail">{error}</p>}
          {!meta?.ready && <p className="text-[15px] text-mute">The deployment is not loaded. Fund the wallets and run pnpm run setup.</p>}
        </form>

        <section className="min-h-[50vh]">
          {!run && <p className="text-[26px] leading-snug text-mute">The timeline fills from the live run. Nothing here is filled in ahead of a transaction.</p>}
          <ol className="flex flex-col gap-4">
            {run?.steps.map((step, index) => {
              const href = externalHref(step.txUrl);
              const large = step.kind === "refunded" || step.kind === "paid";
              return (
                <li key={`${step.at}-${index}`}>
                  <p className={large ? `text-4xl leading-none tracking-tight md:text-5xl ${step.kind === "refunded" ? "text-fail" : "text-pass"}` : "text-[15px]"}>
                    {step.title}
                  </p>
                  <p className="mt-1 text-[15px] text-mute">
                    {step.detail}
                    {step.orderId ? ` · Order #${step.orderId}` : ""}
                  </p>
                  {href && step.txHash && (
                    <a className="text-[15px] underline" href={href} target="_blank" rel="noreferrer">
                      {step.txHash}
                    </a>
                  )}
                </li>
              );
            })}
          </ol>
          {run?.error && <p className="mt-6 text-[15px] text-fail">{run.error}</p>}
          {run?.summary && (
            <dl className="mt-10 grid grid-cols-2 gap-x-6 gap-y-3 text-[15px] md:grid-cols-4">
              <div>
                <dt className="text-mute">Providers</dt>
                <dd>{run.summary.providersEvaluated}</dd>
              </div>
              <div>
                <dt className="text-mute">Orders</dt>
                <dd>{run.summary.orders}</dd>
              </div>
              <div>
                <dt className="text-mute">Paid provider</dt>
                <dd>{run.summary.successfulProvider ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-mute">Paid</dt>
                <dd>${run.summary.paid}</dd>
              </div>
              <div>
                <dt className="text-mute">Refunded</dt>
                <dd>${run.summary.refunded}</dd>
              </div>
              <div>
                <dt className="text-mute">Net spent</dt>
                <dd>${run.summary.netSpent}</dd>
              </div>
              <div>
                <dt className="text-mute">Budget left</dt>
                <dd>${run.summary.budgetRemaining}</dd>
              </div>
              <div>
                <dt className="text-mute">Result</dt>
                <dd>{run.summary.result ? `${run.summary.result.symbol} ${run.summary.result.price}` : "—"}</dd>
              </div>
            </dl>
          )}
        </section>

        <aside>
          <h2 className="text-[15px] text-mute">Provider rankings</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-mute">{rankings?.formula ?? "Rankings load from chain feedback and escrow events."}</p>
          <ol className="mt-4 flex flex-col gap-4">
            {(rankings?.providers ?? []).map((provider) => (
              <li key={provider.id} className="border-t border-line pt-3 text-[15px]">
                <p>
                  {provider.rank ?? "–"} {provider.name} · ${provider.price}
                </p>
                <p className="text-mute">
                  success {(provider.successRate * 100).toFixed(0)}% · orders {provider.orders} · volume ${provider.verifiedVolume} · score {provider.score}
                </p>
                {!provider.eligible && <p className="text-mute">{provider.reason}</p>}
              </li>
            ))}
          </ol>
          {!rankings && <p className="mt-4 text-[15px] text-mute">Rankings are unavailable until the providers and the deployment answer.</p>}
        </aside>
      </div>
      <Trust meta={meta} />
    </main>
  );
}
