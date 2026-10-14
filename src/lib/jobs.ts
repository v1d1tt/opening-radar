import "server-only";
import { decideBatch, type Answers, type Engine, type Question } from "./laya";
import { agentStart, agentStream, fetchPages, getRun, search } from "./tinyfish";

export type Seniority = "intern" | "entry" | "mid" | "senior" | "any";

export type Prefs = {
  role: string;
  location: string;
  seniority: Seniority;
  keywords: string[];
  visa: boolean;
  company?: string;
  resume?: string;
};

export type Trust = { level: "fresh" | "check" | "ghost"; reasons: string[] };
export type Fit = { met: number; total: number; missing: string[]; metList: string[] };

export type Listing = {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  sources: string[];
  via: "Search + Fetch" | "Agent (live)" | "Agent (async)";
  excerpt: string;
  pay?: string;
  score: number;
  reasons: string[];
  keywordHits: string[];
  requirements: string[];
  ageDays: number | null;
  reposts: number;
  detailChars: number;
  trust?: Trust;
  fit?: Fit;
};

export type HuntEvent =
  | { type: "step"; id: string; status: "running" | "done" | "failed" | "skipped"; detail: string }
  | { type: "agent"; channel: "sse" | "async"; streamingUrl?: string; progress?: string; runId?: string; careersUrl?: string; company?: string }
  | { type: "result"; listings: Listing[]; hidden: number; engine: Engine; stats: Stats; partial: boolean };

export type Stats = {
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

const BOARDS = [
  { name: "Greenhouse", domains: "job-boards.greenhouse.io,boards.greenhouse.io", re: /greenhouse\.io\/[^/]+\/jobs\/\d+/ },
  { name: "Lever", domains: "jobs.lever.co", re: /jobs\.lever\.co\/[^/]+\/[0-9a-f-]{36}/ },
  { name: "Ashby", domains: "jobs.ashbyhq.com", re: /jobs\.ashbyhq\.com\/[^/]+\/[0-9a-f-]{36}/ },
  { name: "Workable", domains: "apply.workable.com", re: /apply\.workable\.com\/[^/]+\/j\/[0-9A-F]+/i },
  { name: "SmartRecruiters", domains: "jobs.smartrecruiters.com", re: /jobs\.smartrecruiters\.com\/[^/]+\/\d+/ },
];

const LEVEL_WORD: Record<Seniority, string> = {
  intern: "intern",
  entry: "",
  mid: "",
  senior: "senior",
  any: "",
};

const CITIES =
  /\b(Bengaluru|Bangalore|Hyderabad|Pune|Mumbai|New Delhi|Delhi|Gurugram|Gurgaon|Noida|Chennai|Kolkata|Ahmedabad|Remote|San Francisco|New York|Seattle|Austin|Boston|London|Dublin|Berlin|Amsterdam|Paris|Toronto|Vancouver|Singapore|Tokyo|Sydney|Tel Aviv|Zurich)\b/i;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const slug = (s: string) => norm(s).replace(/ /g, "-");

function canonical(url: string) {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    u.protocol = "https:";
    return u.toString().replace(/\/apply\/?$/, "").replace(/\/$/, "");
  } catch {
    return url;
  }
}

function boardOf(url: string) {
  return BOARDS.find((b) => b.re.test(url))?.name;
}

function companyFromUrl(url: string) {
  const seg = new URL(url).pathname.split("/").filter(Boolean)[0] ?? "";
  return seg.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseTitle(board: string, raw: string, url: string) {
  let title = raw.trim();
  let company = companyFromUrl(url);
  let m;
  if ((m = raw.match(/^Job Application for (.+) at (.+)$/))) [title, company] = [m[1], m[2]];
  else if ((m = raw.match(/^(.+?) Careers \| (.+)$/))) [company, title] = [m[1], m[2]];
  else if (board === "Lever" && (m = raw.match(/^(.+?) - (.+)$/))) [company, title] = [m[1], m[2]];
  else if ((m = raw.match(/^(.+) @ (.+)$/))) [title, company] = [m[1], m[2]];
  return { title: title.replace(/\s+/g, " ").trim(), company: company.trim() };
}

function findLocation(text: string, prefs: Prefs) {
  const head = text.slice(0, 2500);
  const labelled = head.match(/(?:Location|Office location|Based in)\s*[:\-–]?\s*\**\s*([A-Z][^\n|*]{2,60})/);
  if (labelled) return labelled[1].trim();
  const city = head.match(CITIES);
  if (city) return city[1];
  if (prefs.location && norm(head).includes(norm(prefs.location))) return prefs.location;
  return "Not stated";
}

function keywordHits(text: string, keywords: string[]) {
  const t = norm(text);
  return keywords.filter((k) => k && t.includes(norm(k)));
}

const REQ_HEAD = /(requirement|qualification|what you('|’)ll need|what we('|’)re looking for|you have|you bring|must have|skills|who you are|about you|you should|we expect|eligibility)/i;

/** Pull the requirement bullets out of a posting's markdown. */
function extractRequirements(text: string) {
  const lines = text.split("\n");
  const bullets = (from: number) => {
    const out: string[] = [];
    for (let i = from; i < lines.length && out.length < 7; i++) {
      const m = lines[i].match(/^\s*(?:[-*•]|\d+\.)\s+(.{12,})/);
      if (m) out.push(m[1].replace(/[*_`]/g, "").trim().slice(0, 140));
      else if (out.length && /^#+\s|^\*\*/.test(lines[i])) break;
    }
    return out;
  };
  const head = lines.findIndex((l) => REQ_HEAD.test(l) && l.length < 90);
  const found = head >= 0 ? bullets(head + 1) : [];
  return found.length >= 2 ? found : bullets(0).slice(0, 6);
}

/** "3 months ago", "2026-09-01" -> days since posted. */
function ageInDays(s?: string | null) {
  if (!s) return null;
  const m = s.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/i);
  if (m) {
    const n = +m[1];
    const unit = m[2].toLowerCase();
    return unit.startsWith("minute") || unit.startsWith("hour") ? 0 : unit === "day" ? n : unit === "week" ? n * 7 : unit === "month" ? n * 30 : n * 365;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t) / 86_400_000));
}

const EVERGREEN = /talent (pool|community|network)|future opportunit|general application|always (hiring|looking)|express(ing)? (your )?interest|pipeline role|not (an )?(active|open) (role|position)|evergreen/i;

/** Ghost-job check: is this a real, current opening or a stale or evergreen posting? */
function assessTrust(l: Listing): Trust {
  const ghost: string[] = [];
  const check: string[] = [];
  const fresh: string[] = [];
  if (EVERGREEN.test(`${l.title} ${l.excerpt}`)) ghost.push("Reads like a talent-pool posting, not a live opening");
  if (l.ageDays !== null) {
    if (l.ageDays > 120) ghost.push(`Posted about ${Math.round(l.ageDays / 30)} months ago`);
    else if (l.ageDays > 45) check.push(`Posted about ${Math.round(l.ageDays / 30)} months ago`);
    else fresh.push(l.ageDays <= 1 ? "Posted in the last day" : `Posted ${l.ageDays} days ago`);
  }
  if (l.reposts > 0) check.push(`Same role posted ${l.reposts + 1} times`);
  if (l.via === "Search + Fetch") {
    if (l.detailChars < 400) check.push("Very little detail in the posting");
    else fresh.push("Page is live, read just now");
  }
  if (l.location === "Not stated") check.push("No location given");
  if (ghost.length) return { level: "ghost", reasons: [...ghost, ...check] };
  if (check.length >= 2) return { level: "check", reasons: check };
  return { level: check.length ? "check" : "fresh", reasons: [...fresh, ...check] };
}

/* ---------- Search + Fetch route ---------- */

async function discoverAndRead(prefs: Prefs, emit: (e: HuntEvent) => void, stats: Stats) {
  const q = [prefs.role, LEVEL_WORD[prefs.seniority], prefs.location]
    .filter(Boolean)
    .join(" ");
  emit({ type: "step", id: "search", status: "running", detail: `Searching ${BOARDS.length} job boards for "${q}"` });
  const perBoard = await Promise.all(
    BOARDS.map((b) => search(q, { includeDomains: b.domains }).catch(() => [])),
  );
  stats.searched = BOARDS.length;
  // Interleave boards so one board does not crowd out the rest.
  const seen = new Set<string>();
  const found: { url: string; board: string; snippet: string; date?: string }[] = [];
  for (let i = 0; i < 10; i++) {
    perBoard.forEach((results, bi) => {
      const r = results[i];
      if (!r || !BOARDS[bi].re.test(r.url)) return;
      const url = canonical(r.url);
      if (seen.has(url)) return;
      seen.add(url);
      found.push({ url, board: BOARDS[bi].name, snippet: r.snippet, date: r.date });
    });
  }
  const picked = found.slice(0, 20);
  stats.postingsFound = found.length;
  emit({
    type: "step",
    id: "search",
    status: "done",
    detail: `${found.length} live postings found on ${new Set(found.map((f) => f.board)).size} boards`,
  });

  emit({ type: "step", id: "fetch", status: "running", detail: `Reading ${picked.length} postings in parallel` });
  const chunks = [picked.slice(0, 10), picked.slice(10, 20)].filter((c) => c.length);
  const pages = await Promise.all(chunks.map((c) => fetchPages(c.map((p) => p.url)).catch(() => ({ results: [], errors: [] }))));
  const listings: Listing[] = [];
  let closed = 0;
  for (const { results, errors } of pages) {
    closed += errors.filter((e) => e.error === "page_not_found").length;
    for (const page of results) {
      const final = page.final_url ?? page.url;
      // A closed Greenhouse job redirects to the board with ?error=true.
      if (/error=true/.test(final) || !page.text || !page.title) {
        closed++;
        continue;
      }
      const src = picked.find((p) => p.url === canonical(page.url));
      const board = src?.board ?? boardOf(page.url) ?? "Careers page";
      const { title, company } = parseTitle(board, page.title, page.url);
      // A job that closed often lands on the company's board index ("Open Roles", "Current openings").
      if (/^(open roles|current (job )?openings|jobs at|careers)/i.test(title) || norm(title) === norm(company) || /current job openings/i.test(page.title)) {
        closed++;
        continue;
      }
      listings.push({
        id: canonical(page.url),
        title,
        company,
        location: findLocation(page.text, prefs),
        url: canonical(page.url),
        sources: [board],
        via: "Search + Fetch",
        excerpt: page.text.replace(/[#*_>\[\]()!]/g, " ").replace(/\s+/g, " ").slice(0, 700),
        score: 0,
        reasons: [],
        keywordHits: keywordHits(page.text, prefs.keywords),
        requirements: extractRequirements(page.text),
        ageDays: ageInDays(page.published_date) ?? ageInDays(src?.date) ?? ageInDays(page.text.match(/posted\s*(?:on)?\s*:?\s*([^\n]{3,30})/i)?.[1]),
        reposts: 0,
        detailChars: page.text.length,
      });
    }
  }
  stats.pagesRead = listings.length + closed;
  stats.closedRemoved = closed;
  emit({
    type: "step",
    id: "fetch",
    status: "done",
    detail: `${listings.length} open postings read, ${closed} closed or dead links removed`,
  });
  return listings;
}

/* ---------- Agent routes ---------- */

const AGENT_SCHEMA = {
  type: "object",
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          company: { type: "string" },
          location: { type: "string" },
          pay: { type: "string", nullable: true },
          url: { type: "string" },
        },
        required: ["title", "company", "location", "url"],
      },
    },
  },
  required: ["jobs"],
};

type AgentJob = { title: string; company: string; location: string; pay?: string | null; url: string };

function agentJobs(result: unknown): AgentJob[] {
  const r = result as { jobs?: AgentJob[] } | null;
  return Array.isArray(r?.jobs) ? r.jobs.filter((j) => j?.title && j?.url) : [];
}

function toListing(j: AgentJob, source: string, via: Listing["via"], base: string, prefs: Prefs): Listing {
  let url = j.url;
  try {
    url = new URL(j.url, base).toString();
  } catch {}
  return {
    id: canonical(url),
    title: j.title.trim(),
    company: j.company.trim(),
    location: j.location?.trim() || "Not stated",
    url: canonical(url),
    sources: [source],
    via,
    pay: j.pay ?? undefined,
    excerpt: `${j.title} at ${j.company}, ${j.location}. ${j.pay ?? ""}`,
    score: 0,
    reasons: [],
    keywordHits: keywordHits(`${j.title} ${j.company}`, prefs.keywords),
    requirements: [],
    ageDays: null,
    reposts: 0,
    detailChars: 0,
  };
}

function portalUrl(prefs: Prefs) {
  const city = prefs.location && !/remote/i.test(prefs.location) ? `-in-${slug(prefs.location.split(",")[0])}` : "";
  return prefs.seniority === "intern"
    ? `https://internshala.com/internships/${slug(prefs.role)}-internship${city}/`
    : `https://internshala.com/jobs/${slug(prefs.role)}-jobs${city}/`;
}

/** Internshala needs a real browser (Fetch only sees marketing text), so Agent runs it live over SSE. */
async function portalAgent(prefs: Prefs, emit: (e: HuntEvent) => void, stats: Stats) {
  const url = portalUrl(prefs);
  const kind = prefs.seniority === "intern" ? "internships" : "jobs";
  emit({ type: "step", id: "agent", status: "running", detail: "Agent is opening Internshala in a live browser" });
  try {
    let jobs: AgentJob[] = [];
    let steps = 0;
    for await (const ev of agentStream({
      url,
      goal:
        `Close any popup. If this Internshala page lists ${kind} related to "${prefs.role}", read the first 6 listings and stop. ` +
        `If it shows no listings or unrelated ones, type "${prefs.role}" in the search box, run the search, then read the first 6 results and stop. ` +
        `For each listing return the exact title, company, location, stipend or salary, and the absolute URL of its detail page. Do not log in, do not apply, do not submit any application.`,
      output_schema: AGENT_SCHEMA,
      browser_profile: "lite",
    })) {
      if (ev.type === "STREAMING_URL") emit({ type: "agent", channel: "sse", streamingUrl: ev.streaming_url, runId: ev.run_id });
      if (ev.type === "PROGRESS") {
        steps++;
        emit({ type: "agent", channel: "sse", progress: ev.purpose });
      }
      if (ev.type === "COMPLETE") {
        if (ev.status !== "COMPLETED") throw new Error(`Agent ${ev.status}`);
        jobs = agentJobs(ev.result);
      }
    }
    stats.agentSteps += steps;
    // Internshala returns near matches: keep only titles that share a word with the role.
    const roleWords = norm(prefs.role).split(" ").filter((w) => w.length > 2).map((w) => w.slice(0, 5));
    const kept = jobs.filter((j) => roleWords.some((w) => norm(j.title).includes(w)));
    emit({
      type: "step",
      id: "agent",
      status: "done",
      detail: `Internshala: ${jobs.length} listings read in ${steps} steps, ${kept.length} match the role`,
    });
    return kept.map((j) => toListing(j, "Internshala", "Agent (live)", "https://internshala.com", prefs));
  } catch (e) {
    emit({ type: "step", id: "agent", status: "failed", detail: `Internshala not checked: ${(e as Error).message}` });
    return [];
  }
}

/** A target company's own careers site: Search finds it, then Agent reads it in the background with /run-async.
 *  The hunt does not wait: the page polls the run and merges its listings when they land. */
async function companyAgent(prefs: Prefs, emit: (e: HuntEvent) => void) {
  const company = prefs.company?.trim();
  if (!company) {
    emit({ type: "step", id: "company", status: "skipped", detail: "No target company set" });
    return;
  }
  emit({ type: "step", id: "company", status: "running", detail: `Finding ${company}'s careers page` });
  try {
    const results = await search(`${company} careers official site open positions`);
    const thirdParty = /linkedin|naukri|glassdoor|indeed|ambitionbox|instahyre|wellfound|internshala|cutshort|foundit|monster|shine\.com|wikipedia/i;
    const own = results.filter((r) => !thirdParty.test(r.url));
    const cslug = norm(company).replace(/ /g, "");
    const page =
      own.find((r) => r.url.toLowerCase().includes(cslug) && /career|jobs|join|work-with-us/i.test(r.url)) ??
      own.find((r) => /career|jobs|join|work-with-us|lever|greenhouse|ashby/i.test(r.url)) ??
      own[0];
    if (!page) throw new Error("no careers page found");
    const runId = await agentStart({
      url: page.url,
      goal:
        `Find open roles at ${company} that match "${prefs.role}"` +
        (prefs.location ? ` in or near ${prefs.location}` : "") +
        `. Use the site's search or filters if there are any. Close cookie banners. Return up to 8 matching openings with exact title, company, location, and the absolute URL of each job page. ` +
        `If there are no matching openings, return an empty list. Do not log in, do not apply.`,
      output_schema: AGENT_SCHEMA,
      browser_profile: "lite",
    });
    emit({ type: "agent", channel: "async", runId, careersUrl: page.url, company });
    emit({
      type: "step",
      id: "company",
      status: "running",
      detail: `Agent is reading ${new URL(page.url).host} in the background. Its openings join the list when it finishes.`,
    });
  } catch (e) {
    emit({ type: "step", id: "company", status: "failed", detail: `${company} not checked: ${(e as Error).message}` });
  }
}

/** Called by the page while it polls a background company run. */
export async function companyRunListings(runId: string, prefs: Prefs, company: string, careersUrl: string) {
  const run = await getRun(runId);
  if (!["COMPLETED", "FAILED", "CANCELLED"].includes(run.status)) return { status: run.status, listings: [] as Listing[] };
  if (run.status !== "COMPLETED") return { status: run.status, listings: [] as Listing[] };
  const stats = { layaMs: 0 } as Stats;
  const listings = agentJobs(run.result).map((j) => toListing(j, `${company} careers`, "Agent (async)", careersUrl, prefs));
  const { engine } = await rank(listings, prefs, () => {}, stats);
  return { status: run.status, listings, engine, steps: run.num_of_steps ?? null };
}

/* ---------- Dedup and ranking ---------- */

function dedup(all: Listing[], stats: Stats) {
  const byKey = new Map<string, Listing>();
  for (const l of all) {
    const key = `${norm(l.company)}|${norm(l.title)}|${norm(l.location).split(" ")[0] ?? ""}`;
    const prev = byKey.get(key) ?? [...byKey.values()].find((x) => x.url === l.url);
    if (prev) {
      if (prev.url !== l.url && prev.sources.some((x) => l.sources.includes(x))) prev.reposts++;
      prev.sources = [...new Set([...prev.sources, ...l.sources])];
      stats.duplicatesMerged++;
    } else byKey.set(key, l);
  }
  return [...byKey.values()];
}

const LEVELS = {
  intern: "internship, co-op or trainee role for students",
  entry: "new graduate or entry level, 0 to 2 years of experience",
  mid: "mid level, 3 to 5 years of experience",
  senior: "senior, staff, principal, lead or manager",
};

const ALIASES: string[][] = [
  ["bangalore", "bengaluru"],
  ["gurgaon", "gurugram"],
  ["delhi", "new delhi", "ncr", "noida", "gurgaon", "gurugram"],
  ["mumbai", "bombay"],
  ["chennai", "madras"],
  ["new york", "nyc"],
  ["san francisco", "sf", "bay area"],
];
const INDIA = /bangalore|bengaluru|hyderabad|pune|mumbai|delhi|gurgaon|gurugram|noida|chennai|kolkata|ahmedabad|india/;

/** Hard location check from the posting's own location text. Null when the posting does not say. */
function placeRule(location: string, prefs: Prefs): number | null {
  if (!prefs.location) return 1;
  const loc = norm(location);
  if (!loc || loc === "not stated") return null;
  const want = norm(prefs.location);
  if (/remote/.test(want)) return /remote|anywhere/.test(loc) ? 1 : 0.15;
  const names = ALIASES.find((a) => a.some((n) => want.includes(n))) ?? [want];
  if (names.some((n) => loc.includes(n))) return 1;
  if (/remote|anywhere/.test(loc)) return 0.7;
  if (INDIA.test(want) && /india/.test(loc)) return 0.6;
  return 0.05;
}

function rulesAnswers(l: Listing, prefs: Prefs): Answers {
  const t = norm(l.title);
  const roleWords = norm(prefs.role).split(" ").filter((w) => w.length > 2);
  const match = roleWords.filter((w) => t.includes(w)).length / Math.max(roleWords.length, 1);
  const level = /intern|trainee|co op/.test(t) ? "intern" : /senior|staff|lead|principal|manager/.test(t) ? "senior" : /new grad|junior|graduate|entry/.test(t) ? "entry" : "mid";
  const loc = norm(l.location);
  const place = !prefs.location || loc.includes(norm(prefs.location)) || loc.includes("remote") ? 1 : 0.1;
  return {
    match: { type: "noul", noul: match },
    place: { type: "noul", noul: place },
    level: { type: "choice", choice: level, probabilities: { [level]: 1 } },
  };
}

async function rank(listings: Listing[], prefs: Prefs, emit: (e: HuntEvent) => void, stats: Stats) {
  if (!listings.length) return { engine: "rules" as Engine, ranked: [] as Listing[] };
  emit({ type: "step", id: "rank", status: "running", detail: `Laya is judging ${listings.length} more listings against your preferences` });
  const questions: Record<string, Question> = {
    match: {
      type: "noul",
      instructions: `Is this job a ${prefs.role} role${prefs.keywords.length ? ` that involves ${prefs.keywords.join(", ")}` : ""}?`,
    },
    place: {
      type: "noul",
      instructions: prefs.location
        ? `Is this job based in ${prefs.location}, or open to remote candidates there?`
        : "Is this job open to remote candidates?",
    },
    level: { type: "choice", instructions: "What seniority level is this job?", criteria: LEVELS },
  };
  if (prefs.visa) questions.visa = { type: "noul", instructions: "Does this job offer visa sponsorship or relocation support?" };

  const states = listings.map((l) => ({ title: l.title, company: l.company, location: l.location, posting: l.excerpt }));
  const laya = await decideBatch(states, questions);
  const engine: Engine = laya?.engine ?? "rules";
  stats.layaMs = laya?.ms ?? 0;

  listings.forEach((l, i) => {
    const a = laya?.answers[i] ?? rulesAnswers(l, prefs);
    const match = a.match?.noul ?? 0;
    const rule = placeRule(l.location, prefs);
    const place = rule ?? 0.5 * (a.place?.noul ?? 0.5);
    const levelP = prefs.seniority === "any" ? 1 : (a.level?.probabilities?.[prefs.seniority] ?? (a.level?.choice === prefs.seniority ? 1 : 0));
    const kw = prefs.keywords.length ? l.keywordHits.length / prefs.keywords.length : 1;
    const visa = prefs.visa ? (a.visa?.noul ?? 0) : null;
    // Role and keywords set the base. Level and location work as gates, so a VP role or a Berlin job
    // cannot rank high for a Bangalore intern search however well the title matches.
    const base = visa === null ? 0.75 * match + 0.25 * kw : 0.6 * match + 0.2 * kw + 0.2 * visa;
    l.score = Math.round(100 * base * (0.3 + 0.7 * levelP) * (0.3 + 0.7 * place));
    l.trust = assessTrust(l);
    if (l.trust.level === "ghost") l.score = Math.round(l.score * 0.6);
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    l.reasons = [
      `Role fit ${pct(match)}`,
      rule === null ? `Location not stated, ${pct(place)} guess` : `Location fit ${pct(place)}`,
      `Level: ${a.level?.choice ?? "unknown"}${prefs.seniority !== "any" ? ` (${pct(levelP)} ${prefs.seniority})` : ""}`,
      ...(prefs.keywords.length ? [`Keywords ${l.keywordHits.length}/${prefs.keywords.length}`] : []),
      ...(visa !== null ? [`Visa support ${pct(visa)}`] : []),
    ];
  });
  emit({
    type: "step",
    id: "rank",
    status: "done",
    detail: engine === "rules" ? "Laya unavailable, ranked with fixed rules" : `Ranked by Laya (${engine === "laya-local" ? "on this laptop" : "Hugging Face Space"}) in ${stats.layaMs} ms`,
  });
  return { engine, ranked: listings.sort((a, b) => b.score - a.score) };
}

/** Novelty 1: check the user's resume against each top posting's own requirement bullets with Laya. */
async function fitCheck(listings: Listing[], prefs: Prefs, emit: (e: HuntEvent) => void) {
  const resume = prefs.resume?.trim() ?? "";
  if (resume.length < 80) {
    emit({ type: "step", id: "fit", status: "skipped", detail: "Paste your resume to see which requirements you meet" });
    return;
  }
  const top = listings.filter((l) => l.requirements.length >= 2 && l.score >= 35).slice(0, 8);
  emit({ type: "step", id: "fit", status: "running", detail: `Laya is checking your resume against the requirements of ${top.length} postings` });
  let checked = 0;
  for (const l of top) {
    const qs: Record<string, Question> = Object.fromEntries(
      l.requirements.map((r, i) => [`r${i}`, { type: "noul", instructions: `Does the candidate meet this job requirement: ${r}` } as Question]),
    );
    const out = await decideBatch([{ candidate_resume: resume.slice(0, 1800) }], qs);
    if (!out) continue;
    const a = out.answers[0];
    const metList = l.requirements.filter((_, i) => (a[`r${i}`]?.noul ?? 0) >= 0.6);
    const missing = l.requirements.filter((_, i) => (a[`r${i}`]?.noul ?? 0) < 0.6);
    l.fit = { met: metList.length, total: l.requirements.length, missing, metList };
    l.score = Math.round(l.score * (0.6 + (0.4 * metList.length) / l.requirements.length));
    checked++;
  }
  listings.sort((a, b) => b.score - a.score);
  const strong = top.filter((l) => l.fit && l.fit.met / l.fit.total >= 0.6).length;
  emit({
    type: "step",
    id: "fit",
    status: checked ? "done" : "failed",
    detail: checked ? `Checked ${checked} postings line by line. You meet most requirements on ${strong}.` : "Laya was unreachable, fit not checked",
  });
}

export async function hunt(prefs: Prefs, emit: (e: HuntEvent) => void) {
  const t0 = Date.now();
  const stats: Stats = {
    searched: 0,
    postingsFound: 0,
    pagesRead: 0,
    closedRemoved: 0,
    agentListings: 0,
    duplicatesMerged: 0,
    agentSteps: 0,
    agentCostUsd: 0,
    layaMs: 0,
    seconds: 0,
  };
  const finish = (ranked: Listing[], engine: Engine, partial: boolean) => {
    stats.agentCostUsd = Math.round(stats.agentSteps * 0.016 * 1000) / 1000;
    stats.seconds = Math.round((Date.now() - t0) / 100) / 10;
    const shown = ranked.filter((l) => l.score >= 35).length;
    emit({ type: "result", listings: ranked, hidden: ranked.length - shown, engine, stats: { ...stats }, partial });
  };

  // Job-board results are ranked and shown first; agent results join when they finish.
  let engine: Engine = "rules";
  const boardsP = discoverAndRead(prefs, emit, stats).then(async (ls) => {
    const r = await rank(dedup(ls, stats), prefs, emit, stats);
    engine = r.engine;
    await fitCheck(r.ranked, prefs, emit);
    finish(r.ranked, engine, true);
    return r.ranked;
  });
  const [boards, portal] = await Promise.all([boardsP, portalAgent(prefs, emit, stats), companyAgent(prefs, emit)]);
  const company: Listing[] = [];
  stats.agentListings = portal.length;
  emit({ type: "step", id: "dedup", status: "running", detail: "Merging agent results with job-board results" });
  const merged = dedup([...boards, ...portal, ...company], stats);
  emit({ type: "step", id: "dedup", status: "done", detail: `${merged.length} unique listings, ${stats.duplicatesMerged} duplicates merged` });
  const fresh = merged.filter((l) => l.reasons.length === 0);
  if (fresh.length) engine = (await rank(fresh, prefs, emit, stats)).engine;
  finish(merged.sort((a, b) => b.score - a.score), engine, false);
}
