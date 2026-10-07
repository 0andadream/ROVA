import { useEffect, useState } from "react";
import { loadMeta, type Meta } from "./api";
import { Logo } from "./Logo";
import { About } from "./About";
import { Activity } from "./Activity";
import { Landing } from "./Landing";
import { Providers } from "./Providers";
import { Run } from "./Run";

function useRoute() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  function go(next: string) {
    if (window.location.pathname !== next) window.history.pushState({}, "", next);
    setPath(next);
  }
  return { path, go };
}

const LINKS = [
  { href: "/run", label: "Agent" },
  { href: "/providers", label: "Providers" },
  { href: "/activity", label: "Activity" },
  { href: "/about", label: "About" },
];

export function App() {
  const { path, go } = useRoute();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [open, setOpen] = useState(false);
  const landing = path === "/";

  useEffect(() => {
    let gone = false;
    loadMeta()
      .then((next) => {
        if (!gone) setMeta(next);
      })
      .catch(() => {
        if (!gone) setMeta(null);
      });
    return () => {
      gone = true;
    };
  }, [path]);

  function navigate(href: string) {
    setOpen(false);
    go(href);
  }

  const monadHref = meta?.escrowUrl ?? meta?.explorerUrl ?? null;

  return (
    <div className="min-h-screen">
      <header className={`fixed inset-x-0 top-0 z-20 flex items-center justify-between px-5 md:px-8 ${landing ? "mix-blend-normal" : "bg-paper/80 backdrop-blur-md"}`}>
        <button className="min-w-0 py-4" aria-label="ROVA" onClick={() => navigate("/")}>
          <Logo className="logo-glow-sm h-7 w-auto max-w-[42vw] md:h-8 md:max-w-none" />
        </button>
        <nav className="hidden items-center gap-8 text-[23px] md:flex">
          {LINKS.map((link) => (
            <button key={link.href} className={path === link.href ? "text-ink" : "text-mute"} onClick={() => navigate(link.href)}>
              {link.label}
            </button>
          ))}
        </nav>
        {monadHref ? (
          <a className="hidden text-[23px] md:inline" href={monadHref} target="_blank" rel="noreferrer">
            View on Monad
          </a>
        ) : (
          <span className="hidden text-[23px] text-mute md:inline">View on Monad</span>
        )}
        <button className="py-4 text-[23px] md:hidden" aria-label="Menu" onClick={() => setOpen((value) => !value)}>
          {open ? "Close" : "Menu"}
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-10 flex flex-col justify-end gap-6 bg-paper px-8 pb-16 pt-24 text-[26px] md:hidden">
          {LINKS.map((link) => (
            <button key={link.href} className="text-left" onClick={() => navigate(link.href)}>
              {link.label}
            </button>
          ))}
          {monadHref && (
            <a href={monadHref} target="_blank" rel="noreferrer">
              View on Monad
            </a>
          )}
        </div>
      )}
      {path === "/" && <Landing go={navigate} />}
      {path === "/run" && <Run meta={meta} />}
      {path === "/activity" && <Activity />}
      {path === "/providers" && <Providers meta={meta} />}
      {path === "/about" && <About meta={meta} />}
      {path !== "/" && path !== "/run" && path !== "/activity" && path !== "/providers" && path !== "/about" && (
        <main className="px-6 pt-32">
          <p className="text-[26px]">That page is not part of Rova.</p>
          <button className="mt-6 text-[15px] underline" onClick={() => navigate("/")}>
            Back home
          </button>
        </main>
      )}
    </div>
  );
}
