# Opening Radar

Live job and internship openings from careers pages and job portals, matched to what you want.

**Live app:** https://opening-radar.vercel.app

You set a role, location, level, keywords, an optional target company and an optional resume PDF. Opening Radar reads the live web, drops dead links and duplicates, flags ghost jobs, checks your resume against each posting's own requirements, and ranks what is left. Every listing links straight to apply.

Built for the TinyFish × DTU workshop, Job Portal / Careers Finder track.

## How TinyFish is used

| Endpoint | What it does here |
| --- | --- |
| **Search** | Finds live postings for your role and city across 5 job boards at once (Greenhouse, Lever, Ashby, Workable, SmartRecruiters) with `include_domains`. Also finds a target company's own careers site. |
| **Fetch** | Reads up to 20 postings in parallel. Gives the real title, company, location and requirement bullets. Pages that 404 or redirect to a board index are counted as closed and dropped. |
| **Agent `/run-sse`** | Browses Internshala live (Fetch only sees marketing text there). The live browser streams into the page while it works. |
| **Agent `/run-async`** | Reads your target company's careers site in the background. The page polls the run and merges its openings when it finishes, so the main search never waits on it. |
| **Agent `/run`** | "Check it is open": one quick synchronous check of a single posting. |
| **Agent `/run-sse`** | "Prep application": opens the posting's application form and lists every field. It never types, uploads or submits. |
| **Monitor** | "Watch this search daily": a search Monitor re-runs your query every morning at 9 to catch new openings. |

Free routes run first: Search and Fetch return ranked results in about 15 seconds; Agent results join as they finish.

## What makes it different

1. **Resume fit check.** Upload a PDF resume. For each top posting, the Laya decision model checks the posting's own requirement bullets one by one: "You meet 5 of 7. Missing: Docker; 2+ years of Go."
2. **Ghost-job filter.** Each listing gets a trust badge: live opening, check before applying, or likely ghost job (talent-pool wording, old post date, same role reposted, no detail, no location). Ghost jobs rank lower.
3. **Application prep.** The agent reads the application form. Laya sorts each field into "your profile covers", "you need to write", "check first" (work authorization) and optional.

## Ranking

[Laya](https://huggingface.co/convaiinnovations/laya) is an open-weight decision model. It returns typed answers with probabilities instead of text, so it cannot invent a listing. For each listing it answers: is this the role you asked for, is it in your location, what level is it, does it offer visa support. Level and location work as gates, so a Berlin job or a VP role cannot outrank a Bangalore internship for an intern search. Hard checks (city names and aliases, dead links) are plain code.

Laya runs on this laptop (ONNX, about 140 ms a call) during local use, and on a Hugging Face Space for the deployed app (`laya-space/`). If Laya is unreachable, the app says "ranked with fixed rules".

## Run locally

```bash
npm install
cp .env.example .env.local   # add your keys
npm run dev
```

Environment variables: `TINYFISH_API_KEY`, `LAYA_API_URL`, `LAYA_API_KEY`, and optionally `LAYA_LOCAL=1` to run Laya on your machine.

## Safety

- The TinyFish key stays on the server.
- The agents never log in, apply, upload or submit anything.
- The resume PDF is read once to text and not stored on the server.


current status: to be updated this weekend.
