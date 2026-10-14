import "server-only";

export type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

export type Answer = {
  type: string;
  noul?: number;
  choice?: string;
  probabilities?: Record<string, number>;
};

export type Answers = Record<string, Answer>;
export type Engine = "laya-local" | "laya-space" | "rules";

/* Local Laya (ONNX on this machine). Only used when LAYA_LOCAL=1, never on Vercel. */
let localModel: Promise<{ systemOne: (s: unknown, q: Record<string, Question>) => Promise<{ answers: Answers }> }> | null = null;

async function local() {
  if (!localModel) {
    localModel = (async () => {
      const mod = "@receptron/laya";
      const { Laya } = await import(/* webpackIgnore: true */ mod);
      return Laya.load({ modelDir: `${process.env.HOME}/.cache/laya-onnx` });
    })();
  }
  return localModel;
}

async function space(states: unknown[], questions: Record<string, Question>): Promise<Answers[]> {
  const base = process.env.LAYA_API_URL;
  const key = process.env.LAYA_API_KEY;
  if (!base || !key) throw new Error("Laya Space not configured");
  const start = await fetch(`${base}/gradio_api/call/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: [JSON.stringify({ states, questions }), key] }),
    signal: AbortSignal.timeout(20_000),
  });
  const { event_id } = await start.json();
  if (!event_id) throw new Error("Laya Space did not accept the call");
  const res = await fetch(`${base}/gradio_api/call/decide/${event_id}`, { signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  const m = text.match(/event: complete\s*\ndata: (.*)/);
  if (!m) throw new Error(`Laya Space error: ${text.slice(0, 120)}`);
  const out = JSON.parse(JSON.parse(m[1])[0]);
  if (out.error) throw new Error(`Laya Space: ${out.error}`);
  return out.answers as Answers[];
}

/** Score many states with the same questions. Tries local Laya, then the Space. Returns null if both fail. */
export async function decideBatch(
  states: unknown[],
  questions: Record<string, Question>,
): Promise<{ engine: Engine; answers: Answers[]; ms: number } | null> {
  const t0 = Date.now();
  if (process.env.LAYA_LOCAL === "1") {
    try {
      const m = await local();
      const answers: Answers[] = [];
      for (const s of states) answers.push((await m.systemOne(s, questions)).answers);
      return { engine: "laya-local", answers, ms: Date.now() - t0 };
    } catch (e) {
      console.error("local laya failed", e);
    }
  }
  try {
    const answers = await space(states, questions);
    return { engine: "laya-space", answers, ms: Date.now() - t0 };
  } catch (e) {
    console.error("laya space failed", e);
    return null;
  }
}
