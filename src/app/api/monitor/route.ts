import { createMonitor, runMonitor } from "@/lib/tinyfish";

export const maxDuration = 120;

type MonitorResult = { url: string; title?: string | null; snippet?: string | null };

function pickResults(run: { results?: MonitorResult[] } | undefined) {
  return (run?.results ?? []).map((r) => ({ url: r.url, title: r.title ?? r.url, snippet: r.snippet ?? "" }));
}

/** Create a daily TinyFish Monitor for this search. */
export async function POST(req: Request) {
  const { role, location, seniority } = (await req.json()) as { role: string; location?: string; seniority?: string };
  if (!role) return Response.json({ error: "role is required" }, { status: 400 });
  const level = seniority === "intern" ? "internship" : seniority === "entry" ? "new grad job" : "job";
  const query = `${role} ${level} ${location ?? ""} opening apply`.replace(/\s+/g, " ").trim();
  try {
    const body = await createMonitor(`Job radar: ${role} ${location ?? ""}`.trim(), query);
    return Response.json({ id: body.monitor?.id, query, schedule: body.monitor?.schedule_cron, results: pickResults(body.run) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

/** Run an existing Monitor now and return what it found. */
export async function PUT(req: Request) {
  const { id } = (await req.json()) as { id: string };
  try {
    const body = await runMonitor(id);
    const run = body.run ?? body;
    return Response.json({ id, results: pickResults(run), changed: run.changed ?? run.diff ?? null });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
