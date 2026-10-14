import "server-only";

const KEY = () => {
  const k = process.env.TINYFISH_API_KEY;
  if (!k) throw new Error("TINYFISH_API_KEY is not set");
  return k;
};

const AGENT = "https://agent.tinyfish.ai/v1";

export type SearchResult = { url: string; title: string; snippet: string; site_name?: string; date?: string };

export async function search(query: string, opts: { includeDomains?: string; location?: string } = {}) {
  const params = new URLSearchParams({ query });
  if (opts.includeDomains) params.set("include_domains", opts.includeDomains);
  if (opts.location) params.set("location", opts.location);
  const res = await fetch(`https://api.search.tinyfish.ai?${params}`, {
    headers: { "X-API-Key": KEY() },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Search ${res.status}`);
  const body = await res.json();
  return (body.results ?? []) as SearchResult[];
}

export type FetchedPage = { url: string; final_url: string | null; title: string | null; text: string | null; published_date?: string | null };
export type FetchError = { url: string; error: string; status?: number };

export async function fetchPages(urls: string[]) {
  const res = await fetch("https://api.fetch.tinyfish.ai", {
    method: "POST",
    headers: { "X-API-Key": KEY(), "Content-Type": "application/json" },
    body: JSON.stringify({
      urls,
      format: "markdown",
      per_url_timeout_ms: 25_000,
      purpose: "Read job postings to extract title, company, location and requirements",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Fetch ${res.status}`);
  const body = await res.json();
  return { results: (body.results ?? []) as FetchedPage[], errors: (body.errors ?? []) as FetchError[] };
}

export type AgentEvent =
  | { type: "STARTED"; run_id: string }
  | { type: "STREAMING_URL"; run_id: string; streaming_url: string }
  | { type: "PROGRESS"; run_id: string; purpose: string }
  | { type: "HEARTBEAT" }
  | { type: "COMPLETE"; run_id: string; status: string; result?: unknown; error?: unknown };

type AgentRequest = { url: string; goal: string; output_schema?: object; browser_profile?: "lite" | "stealth" };

/** /run-sse: live progress and a streaming_url the UI can embed. */
export async function* agentStream(req: AgentRequest): AsyncGenerator<AgentEvent> {
  const res = await fetch(`${AGENT}/automation/run-sse`, {
    method: "POST",
    headers: { "X-API-Key": KEY(), "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(280_000),
  });
  if (!res.ok || !res.body) throw new Error(`Agent SSE ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          yield JSON.parse(line.slice(5).trim()) as AgentEvent;
        } catch {}
      }
    }
  }
}

/** /run-async: returns a run_id at once; poll getRun until it ends. */
export async function agentStart(req: AgentRequest) {
  const res = await fetch(`${AGENT}/automation/run-async`, {
    method: "POST",
    headers: { "X-API-Key": KEY(), "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json();
  if (!res.ok || !body.run_id) throw new Error(`Agent async ${res.status}: ${JSON.stringify(body.error ?? body)}`);
  return body.run_id as string;
}

export async function getRun(runId: string) {
  const res = await fetch(`${AGENT}/runs/${runId}`, {
    headers: { "X-API-Key": KEY() },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Run ${res.status}`);
  return (await res.json()) as {
    run_id: string;
    status: string;
    result?: unknown;
    error?: unknown;
    streaming_url?: string;
    num_of_steps?: number;
  };
}

export async function waitForRun(runId: string, maxMs = 200_000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const run = await getRun(runId);
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 4000));
  }
  return { run_id: runId, status: "STILL_RUNNING" as const };
}

/** /run: synchronous, for one quick check. */
export async function agentRun(req: AgentRequest) {
  const res = await fetch(`${AGENT}/automation/run`, {
    method: "POST",
    headers: { "X-API-Key": KEY(), "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Agent run ${res.status}: ${JSON.stringify(body.error ?? body)}`);
  return body as { run_id: string; status: string; result?: unknown; error?: unknown; num_of_steps?: number };
}

export async function createMonitor(name: string, query: string) {
  const res = await fetch(`${AGENT}/monitors`, {
    method: "POST",
    headers: { "X-API-Key": KEY(), "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "search",
      name,
      config: { query, recency_minutes: 1440, result_limit: 10 },
      schedule_cron: "0 9 * * *",
      purpose: "A new job or internship opening matching this search is posted",
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Monitor ${res.status}: ${JSON.stringify(body.error ?? body)}`);
  return body;
}

export async function runMonitor(id: string) {
  const res = await fetch(`${AGENT}/monitors/${id}/runs`, {
    method: "POST",
    headers: { "X-API-Key": KEY() },
    signal: AbortSignal.timeout(90_000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Monitor run ${res.status}: ${JSON.stringify(body.error ?? body)}`);
  return body;
}
