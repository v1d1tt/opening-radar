import { agentRun } from "@/lib/tinyfish";

export const maxDuration = 150;

/** One quick check of a single posting with the synchronous /run endpoint. Never applies. */
export async function POST(req: Request) {
  const { url } = (await req.json()) as { url: string };
  if (!/^https:\/\//.test(url ?? "")) return Response.json({ error: "bad url" }, { status: 400 });
  try {
    const run = await agentRun({
      url,
      goal:
        "Check if this job posting is still open. Look for an Apply button or a message that the job is closed or no longer available. " +
        "Do not click Apply, do not log in, do not fill or submit any form. Return whether it is open, the apply link if visible, and any deadline shown.",
      output_schema: {
        type: "object",
        properties: {
          open: { type: "boolean" },
          apply_url: { type: "string", nullable: true },
          deadline: { type: "string", nullable: true },
          note: { type: "string" },
        },
        required: ["open", "note"],
      },
      browser_profile: "lite",
    });
    return Response.json({ status: run.status, result: run.result ?? null, steps: run.num_of_steps ?? null });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
