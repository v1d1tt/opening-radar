import { extractText } from "unpdf";

/** Turn an uploaded resume PDF into plain text. Nothing is stored. */
export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Attach a PDF file" }, { status: 400 });
  if (file.size > 5_000_000) return Response.json({ error: "PDF is over 5 MB" }, { status: 413 });
  if (!/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name)) return Response.json({ error: "Only PDF resumes are supported" }, { status: 415 });
  try {
    const { text } = await extractText(new Uint8Array(await file.arrayBuffer()), { mergePages: true });
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length < 50) return Response.json({ error: "This PDF has no readable text. Export it again as a text PDF, not a scan." }, { status: 422 });
    return Response.json({ text: clean.slice(0, 6000), words: clean.split(" ").length });
  } catch {
    return Response.json({ error: "Could not read this PDF" }, { status: 422 });
  }
}
