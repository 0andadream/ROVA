import { useEffect, useState } from "react";
import { externalHref, loadActivity, loadMeta, type ActivityRow, type Meta } from "./api";
import { Trust } from "./Trust";

function LinkCell({ href, label }: { href: string | null; label: string }) {
  const safe = externalHref(href);
  if (!safe) return <span>—</span>;
  return (
    <a className="underline" href={safe} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

export function Activity() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [badge, setBadge] = useState<string | null>(null);
  const [faulty, setFaulty] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    const pull = () => {
      loadMeta()
        .then((next) => {
          if (!gone) setMeta(next);
        })
        .catch(() => undefined);
      loadActivity()
        .then((next) => {
          if (gone) return;
          setRows(next.rows);
          setBadge(next.demoBadge);
          setFaulty(next.faultyBadge);
          setError(null);
        })
        .catch((reason: Error) => {
          if (!gone) setError(reason.message);
        });
    };
    pull();
    const timer = window.setInterval(pull, 5000);
    return () => {
      gone = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <main className="px-5 pb-16 pt-24 md:px-8">
      <h1 className="text-[26px]">Activity</h1>
      <div className="mt-4 flex flex-wrap gap-3">
        {badge && <p className="inline-block rounded-full border border-fail px-3 py-1 text-[15px] text-fail">{badge}</p>}
        {faulty && <p className="inline-block rounded-full border border-fail px-3 py-1 text-[15px] text-fail">{faulty}</p>}
      </div>
      {error && <p className="mt-4 text-[15px] text-fail">{error}</p>}
      {rows && rows.length === 0 && <p className="mt-6 text-[15px] text-mute">No orders on this escrow yet.</p>}
      {rows && rows.length > 0 && (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-left text-[15px]">
            <thead className="text-mute">
              <tr>
                <th className="py-2 pr-4 font-medium">Order</th>
                <th className="py-2 pr-4 font-medium">Provider</th>
                <th className="py-2 pr-4 font-medium">Amount</th>
                <th className="py-2 pr-4 font-medium">Result</th>
                <th className="py-2 pr-4 font-medium">Latency</th>
                <th className="py-2 pr-4 font-medium">Freshness</th>
                <th className="py-2 pr-4 font-medium">Evidence</th>
                <th className="py-2 pr-4 font-medium">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.orderId} className="border-t border-line">
                  <td className="py-3 pr-4">#{row.orderId}</td>
                  <td className="py-3 pr-4">{row.provider}</td>
                  <td className="py-3 pr-4">${row.amountUsd}</td>
                  <td className={`py-3 pr-4 ${row.result.includes("REFUNDED") ? "text-fail" : row.result.includes("PAID") ? "text-pass" : ""}`}>
                    {row.result}
                  </td>
                  <td className="py-3 pr-4">{row.latencyMs === null ? "—" : `${row.latencyMs} ms`}</td>
                  <td className="py-3 pr-4">{row.freshness}</td>
                  <td className="py-3 pr-4">
                    <LinkCell href={row.evidenceUrl} label="record" />
                  </td>
                  <td className="py-3 pr-4">
                    <LinkCell href={row.txUrl} label={row.txHash ? `${row.txHash.slice(0, 10)}…` : "tx"} />
                    {row.feedbackUrl && (
                      <>
                        {" · "}
                        <LinkCell href={row.feedbackUrl} label="reputation" />
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Trust meta={meta} />
    </main>
  );
}
