import { companyRunListings, type Prefs } from "@/lib/jobs";

export const maxDuration = 60;

/** Poll a background /run-async company check and get its ranked listings once it completes. */
export async function POST(req: Request) {
  const { runId, prefs, company, careersUrl } = (await req.json()) as { runId: string; prefs: Prefs; company: string; careersUrl: string };
  try {
    return Response.json(await companyRunListings(runId, prefs, company, careersUrl));
  } catch (e) {
    return Response.json({ status: "ERROR", error: (e as Error).message, listings: [] }, { status: 502 });
  }
}
