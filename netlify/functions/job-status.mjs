// Returns the current state of a background search job for the logged-in user.
import { getStore } from "@netlify/blobs";
import { verifyToken, bearer, json } from "./_auth.mjs";

export default async function handler(req) {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const payload = verifyToken(bearer(req));
  if (!payload) return json({ error: "Not authenticated" }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const jobId = String(body.jobId || "");
  if (!jobId) return json({ error: "Missing jobId" }, 400);

  const store = getStore("jobs");
  const rec = await store.get(payload.email + "/" + jobId, { type: "json" });
  if (!rec) return json({ status: "pending" }); // not written yet
  if (rec.owner && rec.owner !== payload.email) return json({ error: "Forbidden" }, 403);
  return json(rec);
}
