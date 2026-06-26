// Discovery only — finds and scores Reddit threads. AI drafting is a separate,
// fast per-thread request (draft.mjs), so a slow proxy here never competes with
// AI time against Netlify's function timeout.
import { verifyToken, bearer, json } from "./_auth.mjs";

async function fetchTimeout(url, opts = {}, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

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
];
const REDDIT_UA =
  process.env.REDDIT_USER_AGENT || "web:replyraddit:1.0 (by /u/replyraddit-app)";

const REDDIT_SEARCH = (kw) =>
  "https://www.reddit.com/search.json?q=" +
  encodeURIComponent(kw) +
  "&sort=relevance&t=year&limit=20";

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

// Parse a Reddit listing, transparently unwrapping proxy envelopes
// (allorigins returns {"contents": "<reddit json string>"}).
function extractChildren(rawText) {
  let payload = null;
  try { payload = JSON.parse(rawText); } catch { return []; }
  if (payload && typeof payload.contents === "string") {
    try { payload = JSON.parse(payload.contents); } catch { return []; }
  }
  return (payload?.data?.children || []).map((c) => normalize(c.data)).filter(Boolean);
}

// --- Sources (credential-free unless noted) ---

// ScraperAPI — keyed residential proxy; the most reliable from cloud IPs.
async function searchScraperAPI(keyword) {
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) return []; // not configured → skip instantly
  const url =
    "https://api.scraperapi.com/?api_key=" +
    encodeURIComponent(key) +
    "&url=" +
    encodeURIComponent(REDDIT_SEARCH(keyword));
  try {
    const res = await fetchTimeout(url, { headers: { accept: "application/json" } }, 8000);
    if (!res.ok) { logSrc("scraperapi", { status: res.status }); return []; }
    const rows = extractChildren(await res.text());
    logSrc("scraperapi", { status: res.status, rows: rows.length });
    return rows;
  } catch (e) {
    logSrc("scraperapi", { error: String(e?.message || e) });
    return [];
  }
}

// PullPush.io — Pushshift successor (single quick attempt).
async function searchPullPush(keyword) {
  const url =
    "https://api.pullpush.io/reddit/search/submission/?q=" +
    encodeURIComponent(keyword) +
    "&size=25&sort=desc&sort_type=score";
  try {
    const res = await fetchTimeout(
      url,
      { headers: { "user-agent": UA_POOL[0], accept: "application/json" } },
      3500,
    );
    if (!res.ok) { logSrc("pullpush", { status: res.status }); return []; }
    const data = await res.json().catch(() => null);
    const rows = (data?.data || []).map(normalize).filter(Boolean);
    logSrc("pullpush", { status: res.status, rows: rows.length });
    return rows;
  } catch (e) {
    logSrc("pullpush", { error: String(e?.message || e) });
    return [];
  }
}

// Public CORS proxies — fetch Reddit from the proxy's IP. allorigins gets a
// longer timeout because it's the one that actually reaches Reddit.
const PROXIES = [
  { name: "allorigins", timeout: 7500, wrap: (u) => "https://api.allorigins.win/get?url=" + encodeURIComponent(u) },
  { name: "corsproxy", timeout: 3500, wrap: (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u) },
];

async function fetchProxyReddit(proxy, redditUrl) {
  try {
    const res = await fetchTimeout(
      proxy.wrap(redditUrl),
      { headers: { "user-agent": UA_POOL[0], accept: "application/json" } },
      proxy.timeout,
    );
    if (!res.ok) { logSrc("proxy:" + proxy.name, { status: res.status }); return []; }
    const rows = extractChildren(await res.text());
    logSrc("proxy:" + proxy.name, { status: res.status, rows: rows.length });
    return rows;
  } catch (e) {
    logSrc("proxy:" + proxy.name, { error: String(e?.message || e) });
    return [];
  }
}

// Optional app-only OAuth (only if creds are configured).
let tokenCache = { token: null, exp: 0 };
async function searchOAuth(keyword) {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return [];
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
    if (!tr.ok) return [];
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
    return [];
  }
  const data = await res.json().catch(() => null);
  return (data?.data?.children || []).map((c) => normalize(c.data)).filter(Boolean);
}

async function nonEmpty(fn) {
  const rows = await fn();
  if (rows && rows.length) return rows;
  throw new Error("no rows");
}

async function searchReddit(keyword) {
  const redditUrl = REDDIT_SEARCH(keyword);
  // Race all sources — fastest with results wins; latency bounded by the
  // slowest single timeout (only if all fail), never the sum.
  const racers = [
    nonEmpty(() => searchScraperAPI(keyword)),
    nonEmpty(() => searchPullPush(keyword)),
    ...PROXIES.map((p) => nonEmpty(() => fetchProxyReddit(p, redditUrl))),
  ];
  try {
    return await Promise.any(racers);
  } catch {
    logSrc("phase1", { result: "all sources failed or empty" });
  }
  try {
    const rows = await searchOAuth(keyword);
    if (rows && rows.length) { logSrc("oauth", { rows: rows.length }); return rows; }
  } catch (e) {
    logSrc("oauth", { error: String(e?.message || e) });
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

  const score = 0.7 * relevance + 0.12 * recency + 0.1 * engagement + 0.08 * isQuestion;
  return Math.round(score * 100);
}

export default async function handler(req) {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const payload = verifyToken(bearer(req));
  if (!payload) return json({ error: "Not authenticated" }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const keyword = String(body.keyword || "").trim();
  if (!keyword) return json({ error: "Enter a keyword or topic." }, 400);

  let posts;
  try {
    posts = await searchReddit(keyword);
  } catch (e) {
    if (e.status === 403 || e.status === 429) {
      return json({ opportunities: [], note: e.message }, 200);
    }
    return json({ error: e.message || "Reddit search failed." }, 502);
  }

  const opportunities = posts
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
    .slice(0, 5);

  if (opportunities.length === 0) {
    return json({ opportunities: [], note: "No matching Reddit threads found. Try a broader keyword." });
  }
  return json({ opportunities });
}
