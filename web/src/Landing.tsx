import { useEffect, useState } from "react";
import { Logo } from "./Logo";

const LINE = "Give me a task, a budget and conditions. I'll find who can do it. They only get paid if it works.";
const PROJECT = "https://github.com/0andadream/ROVA";

function Typewriter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (count >= LINE.length) return;
    const timer = window.setTimeout(() => setCount((value) => value + 1), 28);
    return () => window.clearTimeout(timer);
  }, [count]);
  return <p className="max-w-3xl text-[26px] leading-snug">{LINE.slice(0, count)}</p>;
}

export function Landing({ go }: { go: (path: string) => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(PROJECT);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main className="relative min-h-screen overflow-hidden">
      <div className="stage-glow pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="relative z-10 flex min-h-screen w-full flex-col justify-between px-5 pb-16 pt-24 md:px-10 md:pb-20">
        <div className="flex w-full min-w-0 flex-1 items-center justify-center">
          <Logo labelled className="logo-glow h-auto w-full max-w-[680px]" />
        </div>
        <div className="flex w-full flex-col gap-8">
        <p className="intro-blur max-w-xl text-[26px] leading-snug">
          Hey, I'm Rova, your agent that makes sure agents get what they pay for.
        </p>
        <Typewriter />
        <p className="text-[15px] tracking-wide text-mute">Machines shouldn't pay for failed work.</p>
        <div className="flex flex-wrap gap-3">
          <button className="rounded-full bg-ink px-4 py-2 text-[15px] text-paper" onClick={() => go("/run")}>
            Give Rova a task
          </button>
          <button className="rounded-full bg-ink px-4 py-2 text-[15px] text-paper" onClick={() => go("/run")}>
            Watch a live run
          </button>
          <button className="rounded-full bg-ink/10 px-4 py-2 text-[15px]" onClick={() => go("/about")}>
            How Rova works
          </button>
          <button className="rounded-full bg-ink/10 px-4 py-2 text-[15px]" onClick={() => go("/providers")}>
            See providers
          </button>
          <button className="rounded-full border border-line px-4 py-2 text-[15px]" onClick={copy}>
            {copied ? "Copied" : "github.com/0andadream/ROVA"}
          </button>
        </div>
        </div>
      </div>
    </main>
  );
}
