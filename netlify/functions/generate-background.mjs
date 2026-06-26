// Background function — runs up to 15 min (Netlify), so ScraperAPI's slow
// residential routing has time to return. Writes the result to a job store
// keyed by user + jobId; the page polls job-status.mjs for it.
import { getStore } from "@netlify/blobs";
import { verifyToken, bearer } from "./_auth.mjs";
import { searchReddit, rankOpportunities } from "./_search.mjs";

const ok = () => new Response("accepted", { status: 202 });

export default async function handler(req) {
  const payload = verifyToken(bearer(req));
  if (!payload) return new Response("unauthorized", { status: 401 });

  let body;
  try { body = await req.json(); } catch { return new Response("bad request", { status: 400 }); }
  const jobId = String(body.jobId || "");
  const keyword = String(body.keyword || "").trim();
  if (!jobId || !keyword) return new Response("missing jobId/keyword", { status: 400 });

  const store = getStore("jobs");
  const key = payload.email + "/" + jobId;
  await store.setJSON(key, { status: "pending", owner: payload.email, createdAt: Date.now() });

  try {
    const posts = await searchReddit(keyword, { scraperTimeout: 30000 });
    const opportunities = rankOpportunities(posts, keyword);
    if (!opportunities.length) {
      await store.setJSON(key, {
        status: "empty",
        note: "No matching Reddit threads found. Try a broader keyword.",
        owner: payload.email,
      });
    } else {
      await store.setJSON(key, { status: "done", opportunities, owner: payload.email });
    }
  } catch (e) {
    if (e.status === 403 || e.status === 429) {
      await store.setJSON(key, { status: "empty", note: e.message, owner: payload.email });
    } else {
      await store.setJSON(key, { status: "error", error: e.message || "Search failed.", owner: payload.email });
    }
  }
  return ok();
}
