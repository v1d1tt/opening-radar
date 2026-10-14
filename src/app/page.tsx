"use client";

import { useEffect, useRef, useState } from "react";

type Seniority = "intern" | "entry" | "mid" | "senior" | "any";
type Step = { id: string; status: "running" | "done" | "failed" | "skipped"; detail: string };
type Listing = {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  sources: string[];
  via: string;
  pay?: string;
  score: number;
  reasons: string[];
  keywordHits: string[];
  requirements: string[];
  trust?: { level: "fresh" | "check" | "ghost"; reasons: string[] };
  fit?: { met: number; total: number; missing: string[]; metList: string[] };
};
type Stats = {
  searched: number;
  postingsFound: number;
  pagesRead: number;
  closedRemoved: number;
  agentListings: number;
  duplicatesMerged: number;
  agentSteps: number;
  agentCostUsd: number;
  layaMs: number;
  seconds: number;
};
type Result = { listings: Listing[]; hidden: number; engine: string; stats: Stats; partial: boolean };
type MonitorState = { id: string; query: string; results: { url: string; title: string }[] } | null;
type PrepField = { label: string; required?: boolean | null; category: string };
type Prep =
  | { state: "running"; stream?: string; progress: string[] }
  | { state: "done"; fromProfile: PrepField[]; youWrite: PrepField[]; checkFirst: PrepField[]; optional: PrepField[]; steps: number }
  | { state: "error"; message: string };
type Check = { state: "checking" } | { state: "done"; open: boolean; note: string } | { state: "error"; note: string };

const STEPS: { id: string; label: string; tool: string }[] = [
  { id: "search", label: "Find postings on job boards", tool: "TinyFish Search" },
  { id: "fetch", label: "Read each posting", tool: "TinyFish Fetch" },
  { id: "agent", label: "Browse Internshala live", tool: "TinyFish Agent, /run-sse" },
  { id: "company", label: "Check your target company", tool: "TinyFish Agent, /run-async" },
  { id: "dedup", label: "Merge duplicates", tool: "This app" },
  { id: "rank", label: "Match to your preferences and flag ghost jobs", tool: "Laya decision model" },
  { id: "fit", label: "Check your resume against each posting", tool: "Laya decision model" },
];

const ENGINE_LABEL: Record<string, string> = {
  "laya-local": "Laya, running on this laptop",
  "laya-space": "Laya, running on Hugging Face",
  rules: "fixed rules (Laya was unreachable)",
};

const SAVED_KEY = "opening-radar";

function scoreColor(s: number) {
  return s >= 70 ? "text-good" : s >= 50 ? "text-okay" : "text-weak";
}

export default function Home() {
  const [role, setRole] = useState("Software Engineer");
  const [location, setLocation] = useState("Bangalore");
  const [seniority, setSeniority] = useState<Seniority>("intern");
  const [keywords, setKeywords] = useState("backend, python");
  const [company, setCompany] = useState("");
  const [visa, setVisa] = useState(false);
  const [resume, setResume] = useState("");
  const [resumeNote, setResumeNote] = useState("");

  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Record<string, Step>>({});
  const [streamUrl, setStreamUrl] = useState<string>();
  const [progress, setProgress] = useState<string[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string>();
  const [monitor, setMonitor] = useState<MonitorState>(null);
  const [monitorBusy, setMonitorBusy] = useState(false);
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [preps, setPreps] = useState<Record<string, Prep>>({});
  const startedAt = useRef(0);
  const [companyRun, setCompanyRun] = useState<{ runId: string; careersUrl: string; company: string; prefs: unknown } | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(SAVED_KEY);
      if (saved) {
        const s = JSON.parse(saved);
        if (s.monitor) setMonitor(s.monitor);
        if (s.resume) setResume(s.resume);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)), 500);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    if (!companyRun) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const res = await fetch("/api/company-run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(companyRun),
        });
        const body = await res.json();
        if (body.status === "COMPLETED") {
          const found: Listing[] = body.listings ?? [];
          setSteps((s) => ({
            ...s,
            company: { id: "company", status: "done", detail: `${companyRun.company}: ${found.length} matching openings found on its careers site in ${body.steps ?? "?"} agent steps` },
          }));
          setResult((r) => {
            if (!r) return r;
            const have = new Set(r.listings.map((l) => l.url));
            const add = found.filter((l) => !have.has(l.url));
            return { ...r, listings: [...r.listings, ...add].sort((a, b) => b.score - a.score), stats: { ...r.stats, agentListings: r.stats.agentListings + add.length } };
          });
          return;
        }
        if (body.status === "PENDING" || body.status === "RUNNING") {
          setSteps((s) => ({
            ...s,
            company: {
              id: "company",
              status: "running",
              detail:
                body.status === "PENDING"
                  ? `Queued at TinyFish, which runs 2 agents at a time. ${companyRun.company} starts when a slot frees.`
                  : `Agent is reading ${new URL(companyRun.careersUrl).host} in the background. Its openings join the list when it finishes.`,
            },
          }));
        }
        if (["FAILED", "CANCELLED", "ERROR"].includes(body.status)) {
          setSteps((s) => ({ ...s, company: { id: "company", status: "failed", detail: `${companyRun.company} not checked: agent run ${body.status.toLowerCase()}` } }));
          return;
        }
      } catch {}
      setTimeout(tick, 6000);
    };
    const t = setTimeout(tick, 6000);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [companyRun]);

  const kwList = keywords.split(",").map((k) => k.trim()).filter(Boolean);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setRunning(true);
    setSteps({});
    setStreamUrl(undefined);
    setProgress([]);
    setResult(null);
    setError(undefined);
    setChecks({});
    setPreps({});
    setCompanyRun(null);
    startedAt.current = Date.now();
    try {
      try {
        const saved = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "{}");
        localStorage.setItem(SAVED_KEY, JSON.stringify({ ...saved, resume }));
      } catch {}
      const res = await fetch("/api/hunt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, location, seniority, keywords: kwList, visa, company, resume }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `Request failed (${res.status})`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "step") setSteps((s) => ({ ...s, [ev.id]: ev }));
          if (ev.type === "agent" && ev.channel === "async" && ev.runId) {
            setCompanyRun({ runId: ev.runId, careersUrl: ev.careersUrl, company: ev.company, prefs: { role, location, seniority, keywords: kwList, visa } });
          }
          if (ev.type === "agent" && ev.channel === "sse") {
            if (ev.streamingUrl) setStreamUrl(ev.streamingUrl);
            if (ev.progress) setProgress((p) => [ev.progress, ...p].slice(0, 6));
          }
          if (ev.type === "result") setResult(ev);
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function uploadResume(file: File) {
    setResumeNote("Reading your PDF…");
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/resume", { method: "POST", body: fd });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setResume(body.text);
      setResumeNote(`Loaded ${file.name}, ${body.words} words`);
    } catch (err) {
      setResumeNote((err as Error).message);
    }
  }

  async function watch() {
    setMonitorBusy(true);
    try {
      const res = await fetch("/api/monitor", {
        method: monitor ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(monitor ? { id: monitor.id } : { role, location, seniority }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      const next = { id: body.id ?? monitor?.id, query: body.query ?? monitor?.query ?? "", results: body.results ?? [] };
      setMonitor(next);
      try {
        const saved = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "{}");
        localStorage.setItem(SAVED_KEY, JSON.stringify({ ...saved, monitor: next }));
      } catch {}
    } catch (err) {
      setError(`Watch failed: ${(err as Error).message}`);
    } finally {
      setMonitorBusy(false);
    }
  }

  async function prep(l: Listing) {
    setPreps((p) => ({ ...p, [l.id]: { state: "running", progress: [] } }));
    try {
      const res = await fetch("/api/prep", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: l.url }) });
      if (!res.body) throw new Error(`Request failed (${res.status})`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          setPreps((p) => {
            const cur = p[l.id];
            if (ev.type === "stream" && cur?.state === "running") return { ...p, [l.id]: { ...cur, stream: ev.url } };
            if (ev.type === "progress" && cur?.state === "running") return { ...p, [l.id]: { ...cur, progress: [ev.text, ...cur.progress].slice(0, 3) } };
            if (ev.type === "done") return { ...p, [l.id]: { state: "done", ...ev } };
            if (ev.type === "error") return { ...p, [l.id]: { state: "error", message: ev.message } };
            return p;
          });
        }
      }
    } catch (err) {
      setPreps((p) => ({ ...p, [l.id]: { state: "error", message: (err as Error).message } }));
    }
  }

  async function check(l: Listing) {
    setChecks((c) => ({ ...c, [l.id]: { state: "checking" } }));
    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: l.url }),
      });
      const body = await res.json();
      if (!res.ok || !body.result) throw new Error(body.error ?? `Agent ${body.status}`);
      setChecks((c) => ({ ...c, [l.id]: { state: "done", open: !!body.result.open, note: body.result.deadline ? `Deadline ${body.result.deadline}` : body.result.note } }));
    } catch (err) {
      setChecks((c) => ({ ...c, [l.id]: { state: "error", note: (err as Error).message } }));
    }
  }

  const visible = result ? (showAll ? result.listings : result.listings.filter((l) => l.score >= 35)) : [];
  const started = running || Object.keys(steps).length > 0;

  return (
    <main className="mx-auto grid max-w-[1320px] gap-8 px-4 py-8 lg:grid-cols-[340px_1fr] lg:px-8">
      <aside className="lg:sticky lg:top-8 lg:self-start">
        <h1 className="font-display text-[2.6rem] font-bold leading-[1.02] tracking-tight">Opening Radar</h1>
        <p className="mt-3 max-w-[32ch] text-[15px] leading-relaxed text-muted">
          Tell it what you want. It reads live careers pages and job portals, drops dead links and duplicates, and ranks what is left for you.
        </p>

        <form onSubmit={run} className="mt-7 space-y-4">
          <Field label="Role">
            <input className="input" value={role} onChange={(e) => setRole(e.target.value)} required placeholder="Data Analyst" />
          </Field>
          <Field label="Location">
            <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Bangalore, or Remote" />
          </Field>
          <Field label="Level">
            <select className="input" value={seniority} onChange={(e) => setSeniority(e.target.value as Seniority)}>
              <option value="intern">Internship</option>
              <option value="entry">New grad or entry level</option>
              <option value="mid">Mid level</option>
              <option value="senior">Senior</option>
              <option value="any">Any level</option>
            </select>
          </Field>
          <Field label="Keywords" hint="Separate with commas">
            <input className="input" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="react, ml" />
          </Field>
          <Field label="Company to check directly" hint="Optional. The agent opens its careers site.">
            <input className="input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Razorpay" />
          </Field>
          <Field label="Your resume" hint="Optional. PDF, read once and not stored.">
            <input
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => e.target.files?.[0] && uploadResume(e.target.files[0])}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-ink file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-cobalt"
            />
            {resumeNote && <p className="mt-1.5 text-sm text-muted">{resumeNote}</p>}
            <textarea
              className="input mt-2 min-h-[72px] resize-y text-sm"
              value={resume}
              onChange={(e) => setResume(e.target.value)}
              placeholder="Or paste the text here. Used to check each posting's requirements."
            />
          </Field>
          <label className="flex items-center gap-2.5 text-[15px]">
            <input type="checkbox" checked={visa} onChange={(e) => setVisa(e.target.checked)} className="size-4 accent-[var(--cobalt)]" />
            I need visa sponsorship
          </label>
          <button
            disabled={running}
            className="w-full rounded-md bg-cobalt px-4 py-3 font-display text-[17px] font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
          >
            {running ? `Searching the live web… ${elapsed}s` : "Find openings"}
          </button>
        </form>

        <div className="mt-6 border-t border-line pt-5">
          <p className="text-[15px] font-semibold">Keep this search fresh</p>
          <p className="mt-1 text-sm text-muted">
            {monitor
              ? `A TinyFish Monitor re-runs "${monitor.query}" every morning at 9.`
              : "Set a TinyFish Monitor to re-check the web every morning and catch new openings."}
          </p>
          <button
            type="button"
            onClick={watch}
            disabled={monitorBusy}
            className="mt-3 rounded-md border border-ink/20 bg-paper px-3.5 py-2 text-sm font-semibold hover:border-cobalt disabled:opacity-60"
          >
            {monitorBusy ? "Checking…" : monitor ? "Check for new openings now" : "Watch this search daily"}
          </button>
          {monitor && monitor.results.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-sm">
              {monitor.results.slice(0, 5).map((r) => (
                <li key={r.url} className="truncate">
                  <a href={r.url} target="_blank" rel="noreferrer" className="text-cobalt hover:underline">
                    {r.title}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <section className="min-w-0">
        {!started && !result && (
          <div className="flex h-full min-h-[420px] flex-col justify-center rounded-lg border border-dashed border-line bg-paper/60 p-10">
            <p className="font-display text-2xl font-semibold">Nothing searched yet</p>
            <p className="mt-2 max-w-[56ch] text-muted">
              Set your role and location, then press Find openings. You will see each source being read, the agent browsing a portal live, and a ranked list with apply links.
            </p>
          </div>
        )}

        {started && (
          <div className="grid gap-5 xl:grid-cols-[1fr_420px]">
            <ol className="rounded-lg bg-paper p-5">
              {STEPS.map((s, i) => {
                const st = steps[s.id];
                const status = st?.status;
                return (
                  <li key={s.id} className="flex gap-3.5 border-b border-line py-3 last:border-0">
                    <span
                      className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-[13px] font-bold ${
                        status === "done"
                          ? "bg-good text-white"
                          : status === "failed"
                            ? "bg-okay text-white"
                            : status === "running"
                              ? "running-dot bg-cobalt text-white"
                              : "bg-fog text-muted"
                      }`}
                    >
                      {i + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="font-semibold">
                        {s.label} <span className="font-normal text-muted">with {s.tool}</span>
                      </p>
                      <p className="mt-0.5 text-sm text-muted">{st?.detail ?? (running ? "Waiting" : "Not run")}</p>
                    </div>
                  </li>
                );
              })}
            </ol>

            <div className="flex flex-col overflow-hidden rounded-lg bg-ink text-white">
              <p className="px-4 pt-3 text-sm font-semibold">Agent browser, live</p>
              <div className="relative m-3 aspect-[4/3] overflow-hidden rounded bg-black/40">
                {streamUrl ? (
                  <iframe src={streamUrl} className="absolute inset-0 size-full" title="TinyFish agent live browser" />
                ) : (
                  <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-white/60">
                    {running ? "Starting a cloud browser…" : "The live view appears here while the agent works."}
                  </p>
                )}
              </div>
              <ul className="space-y-1 px-4 pb-4 text-[13px] text-white/75">
                {progress.map((p, i) => (
                  <li key={i} className={i === 0 ? "text-white" : ""}>
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {error && <p className="mt-5 rounded-md border border-okay/40 bg-paper p-4 text-sm">{error}</p>}

        {result && (
          <div className="mt-8">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="font-display text-[1.9rem] font-bold leading-tight">
                  {visible.length} {visible.length === 1 ? "opening fits" : "openings fit"} what you asked for
                </h2>
                <p className="mt-1 text-sm text-muted">
                  {result.stats.postingsFound} postings found, {result.stats.closedRemoved} dead links dropped, {result.stats.duplicatesMerged} duplicates merged,{" "}
                  {result.stats.agentListings} from agent runs. Ranked by {ENGINE_LABEL[result.engine]}. {result.stats.seconds}s total, agent cost $
                  {result.stats.agentCostUsd.toFixed(3)}.
                </p>
                {result.partial && running && (
                  <p className="mt-1 text-sm font-semibold text-cobalt">Job boards are in. The agent is still browsing more sources and will add them here.</p>
                )}
              </div>
              {result.hidden > 0 && (
                <button onClick={() => setShowAll((v) => !v)} className="text-sm font-semibold text-cobalt hover:underline">
                  {showAll ? "Hide weak matches" : `Show ${result.hidden} weak matches`}
                </button>
              )}
            </div>

            {visible.length === 0 ? (
              <p className="mt-6 rounded-lg bg-paper p-6 text-muted">
                No strong matches this time. Try a broader role name, another city, or fewer keywords.
              </p>
            ) : (
              <ol className="mt-5 divide-y divide-line overflow-hidden rounded-lg bg-paper">
                {visible.map((l) => {
                  const c = checks[l.id];
                  return (
                    <li key={l.id} className="grid grid-cols-[64px_1fr] gap-4 p-5 sm:grid-cols-[80px_1fr_auto]">
                      <div className="text-center">
                        <p className={`font-display text-[2.4rem] font-bold leading-none ${scoreColor(l.score)}`}>{l.score}</p>
                        <p className="mt-1 text-xs text-muted">match</p>
                      </div>
                      <div className="min-w-0">
                        <p className="font-display text-lg font-semibold leading-snug">{l.title}</p>
                        <p className="text-[15px]">
                          {l.company} <span className="text-muted">in {l.location}</span>
                          {l.pay && <span className="text-muted">, {l.pay}</span>}
                        </p>
                        <p className="mt-2 text-sm text-muted">{l.reasons.join(". ")}.</p>
                        {l.fit && (
                          <div className="mt-2 text-sm">
                            <p className="font-semibold">
                              You meet {l.fit.met} of {l.fit.total} requirements
                            </p>
                            {l.fit.missing.length > 0 && <p className="text-muted">Missing: {l.fit.missing.join("; ")}</p>}
                          </div>
                        )}
                        {l.trust && (
                          <p
                            className={`mt-2 text-sm ${l.trust.level === "fresh" ? "text-good" : l.trust.level === "check" ? "text-okay" : "text-weak"}`}
                          >
                            <span className="font-semibold">
                              {l.trust.level === "fresh" ? "Live opening" : l.trust.level === "check" ? "Check before applying" : "Likely ghost job"}
                            </span>
                            {l.trust.reasons.length > 0 && <span>: {l.trust.reasons.join(", ")}</span>}
                          </p>
                        )}
                        <p className="mt-2 flex flex-wrap gap-1.5 text-xs">
                          {l.sources.map((s) => (
                            <span key={s} className="rounded bg-fog px-2 py-0.5 font-medium">
                              {s}
                            </span>
                          ))}
                          <span className="rounded px-2 py-0.5 text-muted">via {l.via}</span>
                        </p>
                        {c && (
                          <p className={`mt-2 text-sm ${c.state === "done" ? (c.open ? "text-good" : "text-okay") : "text-muted"}`}>
                            {c.state === "checking"
                              ? "Agent is opening the posting to check it…"
                              : c.state === "done"
                                ? `${c.open ? "Still open" : "Looks closed"}. ${c.note ?? ""}`
                                : `Could not check: ${c.note}`}
                          </p>
                        )}
                        {preps[l.id] && <PrepPanel prep={preps[l.id]} />}
                      </div>
                      <div className="col-span-2 flex gap-2 sm:col-span-1 sm:flex-col sm:items-end">
                        <a
                          href={l.url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-md bg-ink px-3.5 py-2 text-sm font-semibold text-white hover:bg-cobalt"
                        >
                          Open and apply
                        </a>
                        <button
                          onClick={() => check(l)}
                          disabled={c?.state === "checking"}
                          className="rounded-md border border-line px-3.5 py-2 text-sm font-semibold hover:border-cobalt disabled:opacity-60"
                        >
                          Check it is open
                        </button>
                        {l.via === "Search + Fetch" && (
                          <button
                            onClick={() => prep(l)}
                            disabled={preps[l.id]?.state === "running"}
                            className="rounded-md border border-line px-3.5 py-2 text-sm font-semibold hover:border-cobalt disabled:opacity-60"
                          >
                            Prep application
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function PrepPanel({ prep }: { prep: Prep }) {
  if (prep.state === "error") return <p className="mt-3 text-sm text-okay">Could not read the application form: {prep.message}</p>;
  if (prep.state === "running")
    return (
      <div className="mt-3 overflow-hidden rounded-md bg-ink p-3 text-white">
        <p className="text-sm font-semibold">Agent is opening the application form. It reads it and never types or submits.</p>
        {prep.stream && (
          <div className="relative mt-2 aspect-[16/9] overflow-hidden rounded bg-black/40">
            <iframe src={prep.stream} className="absolute inset-0 size-full" title="Agent reading the application form" />
          </div>
        )}
        {prep.progress[0] && <p className="mt-2 text-[13px] text-white/75">{prep.progress[0]}</p>}
      </div>
    );
  const group = (title: string, items: PrepField[], tone: string) =>
    items.length > 0 && (
      <div>
        <p className={`font-semibold ${tone}`}>
          {title} ({items.length})
        </p>
        <p className="text-muted">{items.map((f) => `${f.label}${f.required ? " *" : ""}`).join("; ")}</p>
      </div>
    );
  return (
    <div className="mt-3 space-y-2 rounded-md border border-line p-3 text-sm">
      <p className="font-semibold">Application checklist, read by the agent in {prep.steps} steps. Nothing was typed or sent.</p>
      {group("Check first", prep.checkFirst, "text-okay")}
      {group("You need to write", prep.youWrite, "text-ink")}
      {group("Your profile covers", prep.fromProfile, "text-good")}
      {group("Optional", prep.optional, "text-muted")}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[15px] font-semibold">{label}</span>
      {hint && <span className="ml-2 text-sm text-muted">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}
