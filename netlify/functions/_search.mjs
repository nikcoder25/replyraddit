// Shared Reddit discovery + scoring, used by the background search function.
export async function fetchTimeout(url, opts = {}, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export function logSrc(source, info) {
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

// ScraperAPI — keyed residential proxy. Slow (8-12s) but reliable from cloud IPs,
// so it gets a long timeout (only viable inside the background function).
async function searchScraperAPI(keyword, timeoutMs) {
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) { logSrc("scraperapi", { skipped: "no SCRAPERAPI_KEY set" }); return []; }
  const target = REDDIT_SEARCH(keyword);
  // Canonical ScraperAPI format: https://api.scraperapi.com/?api_key=KEY&url=ENCODED
  const url =
    "https://api.scraperapi.com/?api_key=" +
    encodeURIComponent(key) +
    "&url=" +
    encodeURIComponent(target);
  // Log the exact request (key redacted) + key length so we can see if it's empty.
  logSrc("scraperapi:req", {
    url: "https://api.scraperapi.com/?api_key=***&url=" + encodeURIComponent(target),
    keyLen: key.length,
    timeoutMs,
  });
  const started = Date.now();
  try {
    const res = await fetchTimeout(url, { headers: { accept: "application/json" } }, timeoutMs);
    const text = await res.text();
    const ms = Date.now() - started;
    if (!res.ok) {
      // ScraperAPI returns the failure reason in the body (e.g. bad key, blocked).
      logSrc("scraperapi", { status: res.status, ms, body: text.slice(0, 300) });
      return [];
    }
    const rows = extractChildren(text);
    logSrc("scraperapi", { status: res.status, ms, rows: rows.length });
    return rows;
  } catch (e) {
    logSrc("scraperapi", {
      ms: Date.now() - started,
      error: String(e?.message || e),
      name: e?.name || "",
      cause: String(e?.cause?.message || e?.cause || ""),
    });
    return [];
  }
}

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

async function nonEmpty(fn) {
  const rows = await fn();
  if (rows && rows.length) return rows;
  throw new Error("no rows");
}

// Full search — races free sources (fast) and ScraperAPI (slow, generous
// timeout). Whichever returns real threads first wins.
export async function searchReddit(keyword, opts = {}) {
  const scraperTimeout = opts.scraperTimeout || 8000;
  const redditUrl = REDDIT_SEARCH(keyword);
  const racers = [
    nonEmpty(() => searchScraperAPI(keyword, scraperTimeout)),
    nonEmpty(() => searchPullPush(keyword)),
    ...PROXIES.map((p) => nonEmpty(() => fetchProxyReddit(p, redditUrl))),
  ];
  try {
    return await Promise.any(racers);
  } catch {
    logSrc("result", { outcome: "ALL sources failed" });
    const err = new Error(
      "Couldn't reach a Reddit data source right now. Please try again in a moment.",
    );
    err.status = 502;
    throw err;
  }
}

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

export function rankOpportunities(posts, keyword) {
  return posts
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
}
