import { hunt, type HuntEvent, type Prefs } from "@/lib/jobs";

export const maxDuration = 300;

export async function POST(req: Request) {
  const body = (await req.json()) as Partial<Prefs>;
  const prefs: Prefs = {
    role: (body.role ?? "").trim().slice(0, 80),
    location: (body.location ?? "").trim().slice(0, 60),
    seniority: body.seniority ?? "any",
    keywords: (body.keywords ?? []).map((k) => k.trim()).filter(Boolean).slice(0, 6),
    visa: !!body.visa,
    company: (body.company ?? "").trim().slice(0, 60) || undefined,
    resume: (body.resume ?? "").slice(0, 6000) || undefined,
  };
  if (!prefs.role) return Response.json({ error: "role is required" }, { status: 400 });

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const emit = (e: HuntEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        await hunt(prefs, emit);
      } catch (e) {
        emit({ type: "step", id: "fatal", status: "failed", detail: (e as Error).message });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
