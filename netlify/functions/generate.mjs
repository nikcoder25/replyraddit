import Anthropic from "@anthropic-ai/sdk";
import { verifyToken, bearer, json } from "./_auth.mjs";

// ---- Reddit discovery (read-only, no credentials required) ----
// Reddit blocks its own public JSON endpoint from datacenter IPs (HTTP 403), so
// the primary source is PullPush.io — the actively-maintained Pushshift
// successor, which serves Reddit submission search over plain HTTP with no auth
// and no cloud-IP blocking. Public Reddit (rotating UAs) and optional OAuth are
// kept only as fallbacks.
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with a hard abort timeout so a slow source can't stall the function.
async function fetchTimeout(url, opts = {}, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Structured logging — visible in the Netlify Functions log for the request.
function logSrc(source, info) {
  try {
    console.log("[reddit] " + source + " " + JSON.stringify(info));
  } catch {
    console.log("[reddit] " + source);
  }
}

const UA_POOL = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
];
const REDDIT_UA =
  process.env.REDDIT_USER_AGENT || "web:replyraddit:1.0 (by /u/replyraddit-app)";

// Normalize a record from any source into the shape the scorer/handler expect.
function normalize(p) {
  if (!p || p.over_18 || !p.subreddit || !p.title) return null;
  let permalink = p.permalink || "";
  if (!permalink && p.full_link) {
    try { permalink = new URL(p.full_link).pathname; } catch { /* ignore */ }
  }
  if (!permalink) permalink = `/r/${p.subreddit}/comments/${p.id}/`;
  if (!permalink.startsWith("/")) permalink = "/" + permalink;
  return {
    id: p.id,
    title: p.title,
    subreddit: p.subreddit,
    selftext: p.selftext || "",
    num_comments: p.num_comments || 0,
    created_utc: p.created_utc || 0,
    permalink,
  };
}

// 1. PullPush.io — credential-free, datacenter-friendly. Retries with backoff.
async function searchPullPush(keyword) {
  const url =
    "https://api.pullpush.io/reddit/search/submission/?q=" +
    encodeURIComponent(keyword) +
    "&size=25&sort=desc&sort_type=score";
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await SLEEP(250);
    try {
      const res = await fetchTimeout(
        url,
        { headers: { "user-agent": UA_POOL[attempt % UA_POOL.length], accept: "application/json" } },
        6000,
      );
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const rows = (data?.data || []).map(normalize).filter(Boolean);
        logSrc("pullpush", { status: res.status, rows: rows.length });
        return rows;
      }
      logSrc("pullpush", { status: res.status });
      lastErr = new Error(`PullPush HTTP ${res.status}`);
      if (res.status !== 429 && res.status < 500) break; // only retry rate-limit / server errors
    } catch (e) {
      logSrc("pullpush", { error: String(e?.message || e) });
      lastErr = e;
    }
  }
  throw lastErr || new Error("PullPush request failed");
}

// 1b. Arctic Shift — independent credential-free Reddit archive (Pushshift-like).
async function searchArcticShift(keyword) {
  const url =
    "https://arctic-shift.photon-reddit.com/api/posts/search?query=" +
    encodeURIComponent(keyword) +
    "&limit=25&sort=desc&sort_type=score";
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await SLEEP(250);
    try {
      const res = await fetchTimeout(
        url,
        { headers: { "user-agent": UA_POOL[attempt % UA_POOL.length], accept: "application/json" } },
        6000,
      );
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const rows = (data?.data || []).map(normalize).filter(Boolean);
        logSrc("arcticshift", { status: res.status, rows: rows.length });
        return rows;
      }
      logSrc("arcticshift", { status: res.status });
      lastErr = new Error(`ArcticShift HTTP ${res.status}`);
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      logSrc("arcticshift", { error: String(e?.message || e) });
      lastErr = e;
    }
  }
  throw lastErr || new Error("ArcticShift request failed");
}

// Resolve with a source's rows only if it actually returned threads.
async function nonEmpty(fn) {
  const rows = await fn();
  if (rows && rows.length) return rows;
  throw new Error("no rows");
}

// 2. Public Reddit JSON with rotating User-Agents (often 403s from cloud IPs).
async function searchPublicReddit(keyword) {
  const qs =
    "/search.json?q=" + encodeURIComponent(keyword) + "&sort=relevance&t=year&limit=20";
  for (const host of ["https://www.reddit.com", "https://old.reddit.com"]) {
    for (let i = 0; i < UA_POOL.length; i++) {
      let res;
      try {
        res = await fetchTimeout(
          host + qs,
          {
            headers: {
              "user-agent": UA_POOL[i],
              accept: "application/json, text/javascript, */*; q=0.01",
              "accept-language": "en-US,en;q=0.9",
            },
          },
          4000,
        );
      } catch {
        continue;
      }
      if (res.ok) {
        const data = await res.json().catch(() => null);
        return (data?.data?.children || []).map((c) => normalize(c.data)).filter(Boolean);
      }
      if (res.status !== 403 && res.status !== 429) return []; // hard failure, stop trying UAs
      await SLEEP(250);
    }
  }
  return [];
}

// 3. Optional OAuth (only if app credentials happen to be configured).
let tokenCache = { token: null, exp: 0 };
async function searchOAuth(keyword) {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (!(tokenCache.token && Date.now() < tokenCache.exp)) {
    const basic = Buffer.from(`${id}:${secret}`).toString("base64");
    const tr = await fetchTimeout(
      "https://www.reddit.com/api/v1/access_token",
      {
        method: "POST",
        headers: {
          authorization: "Basic " + basic,
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": REDDIT_UA,
        },
        body: "grant_type=client_credentials",
      },
      3000,
    );
    if (!tr.ok) return null;
    const td = await tr.json();
    tokenCache = { token: td.access_token, exp: Date.now() + ((td.expires_in || 3600) - 60) * 1000 };
  }
  const res = await fetchTimeout(
    "https://oauth.reddit.com/search?q=" +
      encodeURIComponent(keyword) +
      "&sort=relevance&t=year&limit=20&type=link",
    { headers: { authorization: "Bearer " + tokenCache.token, "user-agent": REDDIT_UA } },
    3500,
  );
  if (!res.ok) {
    if (res.status === 401) tokenCache = { token: null, exp: 0 };
    return null;
  }
  const data = await res.json().catch(() => null);
  return (data?.data?.children || []).map((c) => normalize(c.data)).filter(Boolean);
}

// 1c. Reddit search via a public CORS proxy — the proxy fetches Reddit from its
// own IP, sidestepping the datacenter-IP block on Netlify.
const PROXIES = [
  { name: "allorigins", wrap: (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u) },
  { name: "corsproxy", wrap: (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u) },
];

async function fetchProxyReddit(proxy, redditUrl) {
  try {
    const res = await fetchTimeout(
      proxy.wrap(redditUrl),
      { headers: { "user-agent": UA_POOL[0], accept: "application/json" } },
      6000,
    );
    if (!res.ok) {
      logSrc("proxy:" + proxy.name, { status: res.status });
      return [];
    }
    const data = await res.json().catch(() => null);
    const rows = (data?.data?.children || []).map((c) => normalize(c.data)).filter(Boolean);
    logSrc("proxy:" + proxy.name, { status: res.status, rows: rows.length });
    return rows;
  } catch (e) {
    logSrc("proxy:" + proxy.name, { error: String(e?.message || e) });
    return [];
  }
}

async function searchReddit(keyword) {
  const redditUrl =
    "https://www.reddit.com/search.json?q=" +
    encodeURIComponent(keyword) +
    "&sort=relevance&t=year&limit=20";

  // Phase 1: race ALL credential-free sources in parallel — archives + CORS
  // proxies. Whichever returns real threads first wins, so total latency is
  // bounded by the fastest success (or the longest single timeout if all fail),
  // never the sum.
  const racers = [
    nonEmpty(() => searchPullPush(keyword)),
    nonEmpty(() => searchArcticShift(keyword)),
    ...PROXIES.map((p) => nonEmpty(() => fetchProxyReddit(p, redditUrl))),
  ];
  try {
    return await Promise.any(racers);
  } catch {
    logSrc("phase1", { result: "all archives + proxies failed or empty" });
  }

  // Phase 2: OAuth, only if app credentials happen to be configured.
  try {
    const rows = await searchOAuth(keyword);
    if (rows && rows.length) {
      logSrc("oauth", { rows: rows.length });
      return rows;
    }
  } catch (e) {
    logSrc("oauth", { error: String(e?.message || e) });
  }

  // Phase 3: direct public Reddit (usually 403 from cloud IPs) — last resort.
  try {
    const rows = await searchPublicReddit(keyword);
    logSrc("public", { rows: rows.length });
    if (rows && rows.length) return rows;
  } catch (e) {
    logSrc("public", { error: String(e?.message || e) });
  }

  logSrc("result", { outcome: "ALL sources failed" });
  const err = new Error(
    "Couldn't reach a Reddit data source right now. Please try again in a moment.",
  );
  err.status = 502;
  throw err;
}

// ---- Multi-factor relevance scoring (relevance weighted highest) ----
function scorePost(post, keyword) {
  const kw = keyword.toLowerCase();
  const title = (post.title || "").toLowerCase();
  const body = (post.selftext || "").toLowerCase();

  let relevance = 0;
  if (title.includes(kw)) relevance += 1;
  for (const word of kw.split(/\s+/).filter(Boolean)) {
    if (title.includes(word)) relevance += 0.25;
    if (body.includes(word)) relevance += 0.1;
  }
  relevance = Math.min(relevance, 1);

  const ageDays = (Date.now() / 1000 - (post.created_utc || 0)) / 86400;
  const recency = Math.max(0, 1 - ageDays / 365);
  const engagement = Math.min(1, Math.log10((post.num_comments || 0) + 1) / 2);
  const isQuestion = /\?|how|what|which|recommend|looking for|best/i.test(post.title) ? 1 : 0.4;

  // 70% relevance, then recency / engagement / intent
  const score =
    0.7 * relevance + 0.12 * recency + 0.1 * engagement + 0.08 * isQuestion;
  return Math.round(score * 100);
}

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string" },
    rationale: { type: "string" },
  },
  required: ["reply", "rationale"],
};

const SYSTEM_PROMPT =
  "You are a Reddit marketing co-pilot. Write an authentic, value-first reply that genuinely helps the original poster and only mentions the brand if it is truly relevant. Never sound like an ad. Be human, specific, and helpful, and disclose affiliation naturally if you recommend the product. Keep the reply to 2-4 sentences.";

export default async function handler(req) {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const payload = verifyToken(bearer(req));
  if (!payload) return json({ error: "Not authenticated" }, 401);

  if (!process.env.ANTHROPIC_API_KEY) {
    return json(
      { error: "Server is missing ANTHROPIC_API_KEY. Set it in Netlify → Site configuration → Environment variables." },
      500,
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const keyword = String(body.keyword || "").trim();
  const product = String(body.product || "").trim();
  const persona = String(body.persona || "").trim();
  if (!keyword) return json({ error: "Enter a keyword or topic." }, 400);
  if (!product) return json({ error: "Describe your product / brand." }, 400);

  // 1. Discover + score
  let posts;
  try {
    posts = await searchReddit(keyword);
  } catch (e) {
    // Reddit block / rate-limit: respond gracefully so the UI shows a clean,
    // actionable message instead of a hard error.
    if (e.status === 403 || e.status === 429) {
      return json({ opportunities: [], note: e.message }, 200);
    }
    return json({ error: e.message || "Reddit search failed." }, 502);
  }
  const scored = posts
    .map((p) => ({
      id: p.id,
      title: p.title,
      subreddit: "r/" + p.subreddit,
      url: "https://www.reddit.com" + p.permalink,
      snippet: (p.selftext || "").slice(0, 400),
      comments: p.num_comments || 0,
      score: scorePost(p, keyword),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (scored.length === 0) {
    return json({ opportunities: [], note: "No matching public Reddit threads found. Try a broader keyword." });
  }

  // 2. Draft replies — one fast Sonnet call per thread, run in parallel so the
  // whole request stays well under the function timeout. maxRetries: 0 and a
  // per-call timeout keep a single slow call from blowing the budget.
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });

  async function draftFor(p) {
    const userMsg =
      `BRAND / PRODUCT:\n${product}\n\n` +
      `PERSONA (who is replying):\n${persona || "A helpful, experienced practitioner."}\n\n` +
      `REDDIT THREAD:\n${p.subreddit} — "${p.title}"\n${(p.snippet || "(no body)").slice(0, 220)}\n\n` +
      "Write ONE reply draft. Return JSON only.";
    try {
      const resp = await client.messages.create(
        {
          model: "claude-sonnet-4-6",
          max_tokens: 400,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMsg }],
          output_config: { format: { type: "json_schema", schema: DRAFT_SCHEMA } },
        },
        { timeout: 7000 },
      );
      const text = resp.content.find((b) => b.type === "text")?.text || "{}";
      const parsed = JSON.parse(text);
      return { reply: parsed.reply || "", rationale: parsed.rationale || "" };
    } catch {
      return { reply: "", rationale: "" };
    }
  }

  const drafts = await Promise.all(scored.map(draftFor));
  const opportunities = scored.map((p, i) => ({
    ...p,
    reply: drafts[i].reply,
    rationale: drafts[i].rationale,
  }));

  return json({ opportunities });
}
