import { decideBatch } from "@/lib/laya";
import { agentStream } from "@/lib/tinyfish";

export const maxDuration = 300;

type Field = { label: string; required?: boolean | null; kind?: string | null };

const CATEGORIES = {
  identity: "name, email, phone number or address",
  links: "LinkedIn, GitHub, portfolio or website link",
  resume: "resume or CV file upload",
  education: "school, degree, graduation year or GPA",
  work_authorization: "visa status, work authorization, sponsorship or citizenship",
  availability: "start date, notice period, internship dates or relocation",
  compensation: "salary, stipend or compensation expectations",
  essay: "an open question that needs a written answer, such as why this company or a cover letter",
  demographic: "gender, race, veteran or disability self-identification",
  other: "anything else",
};

const RULES: [RegExp, string][] = [
  [/resume|\bcv\b/i, "resume"],
  [/sponsor|visa|work (authori[sz]ation|permit)|authori[sz]ed to work|citizenship|right to work/i, "work_authorization"],
  [/salary|compensation|stipend|\bctc\b|expected pay/i, "compensation"],
  [/gender|race|ethnic|veteran|disabilit|pronoun|sexual orientation/i, "demographic"],
  [/linkedin|github|portfolio|website|\burl\b/i, "links"],
  [/name|e-?mail|phone|mobile|address|current location|city/i, "identity"],
  [/school|university|college|degree|graduat|gpa|cgpa/i, "education"],
  [/start date|notice|availab|relocat|when can you/i, "availability"],
  [/cover letter|why (do you|are you)|tell us|describe|additional information/i, "essay"],
];

const FROM_PROFILE = new Set(["identity", "links", "resume", "education"]);

/** Novelty 3: the agent opens the application form and reads it (never types, never submits);
 *  Laya sorts each field into "your profile covers it", "you must write it" or "check first". */
export async function POST(req: Request) {
  const { url } = (await req.json()) as { url: string };
  if (!/^https:\/\//.test(url ?? "")) return Response.json({ error: "bad url" }, { status: 400 });

  // Go straight to the form where the board has a fixed form URL.
  const formUrl = /jobs\.lever\.co/.test(url) ? `${url}/apply` : /jobs\.ashbyhq\.com/.test(url) ? `${url}/application` : url;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const emit = (e: object) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        let fields: Field[] = [];
        let steps = 0;
        for await (const ev of agentStream({
          url: formUrl,
          goal:
            "This page has the job's application form, possibly below the job description. Scroll to it. If no form is visible, click the Apply button once. Stay on this job. " +
            "List every field and question on the form: its label or question text, whether it is required, and its type (text, file upload, dropdown, yes/no, long answer). " +
            "Do not type into any field, do not upload anything, do not log in, and never click Submit or Send.",
          output_schema: {
            type: "object",
            properties: {
              fields: {
                type: "array",
                items: {
                  type: "object",
                  properties: { label: { type: "string" }, required: { type: "boolean", nullable: true }, kind: { type: "string", nullable: true } },
                  required: ["label"],
                },
              },
            },
            required: ["fields"],
          },
          browser_profile: "lite",
        })) {
          if (ev.type === "STREAMING_URL") emit({ type: "stream", url: ev.streaming_url });
          if (ev.type === "PROGRESS") {
            steps++;
            emit({ type: "progress", text: ev.purpose });
          }
          if (ev.type === "COMPLETE") {
            if (ev.status !== "COMPLETED") throw new Error(`agent ${ev.status.toLowerCase()}`);
            const r = ev.result as { fields?: Field[] } | null;
            fields = (r?.fields ?? []).filter((f) => f?.label).slice(0, 30);
          }
        }
        if (!fields.length) throw new Error("no application form found on this page");

        // Plain rules for the obvious fields; Laya decides the rest.
        const ruled = fields.map((f) => RULES.find(([re]) => re.test(f.label))?.[1] ?? null);
        const unknown = fields.filter((_, i) => !ruled[i]);
        const out = unknown.length
          ? await decideBatch(
              unknown.map((f) => ({ form_field: f.label, type: f.kind ?? "unknown" })),
              { category: { type: "choice", instructions: "What does this job application form field ask for?", criteria: CATEGORIES } },
            )
          : null;
        let u = 0;
        const sorted = fields.map((f, i) => ({ ...f, category: ruled[i] ?? out?.answers[u++]?.category?.choice ?? "other" }));
        emit({
          type: "done",
          steps,
          engine: out?.engine ?? "rules",
          fromProfile: sorted.filter((f) => FROM_PROFILE.has(f.category)),
          youWrite: sorted.filter((f) => ["essay", "compensation", "availability", "other"].includes(f.category)),
          checkFirst: sorted.filter((f) => f.category === "work_authorization"),
          optional: sorted.filter((f) => f.category === "demographic"),
        });
      } catch (e) {
        emit({ type: "error", message: (e as Error).message });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
