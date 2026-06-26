import Anthropic from "@anthropic-ai/sdk";
import { verifyToken, bearer, json } from "./_auth.mjs";

// ---- Reddit discovery (read-only, no credentials required) ----
// Reddit blocks its own public JSON endpoint from datacenter IPs (HTTP 403), so
// the primary source is PullPush.io — the actively-maintained Pushshift
// successor, which serves Reddit submission search over plain HTTP with no auth
// and no cloud-IP blocking. Public Reddit (rotating UAs) and optional OAuth are
// kept only as fallbacks.
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

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
    "&size=40&sort=desc&sort_type=score";
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await SLEEP(400 * attempt);
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA_POOL[attempt % UA_POOL.length], accept: "application/json" },
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const rows = (data?.data || []).map(normalize).filter(Boolean);
        return rows;
      }
      lastErr = new Error(`PullPush HTTP ${res.status}`);
      if (res.status !== 429 && res.status < 500) break; // only retry rate-limit / server errors
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("PullPush request failed");
}

// 2. Public Reddit JSON with rotating User-Agents (often 403s from cloud IPs).
async function searchPublicReddit(keyword) {
  const qs =
    "/search.json?q=" + encodeURIComponent(keyword) + "&sort=relevance&t=year&limit=20";
  for (const host of ["https://www.reddit.com", "https://old.reddit.com"]) {
    for (let i = 0; i < UA_POOL.length; i++) {
      let res;
      try {
        res = await fetch(host + qs, {
          headers: {
            "user-agent": UA_POOL[i],
            accept: "application/json, text/javascript, */*; q=0.01",
            "accept-language": "en-US,en;q=0.9",
          },
        });
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
    const tr = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        authorization: "Basic " + basic,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": REDDIT_UA,
      },
      body: "grant_type=client_credentials",
    });
    if (!tr.ok) return null;
    const td = await tr.json();
    tokenCache = { token: td.access_token, exp: Date.now() + ((td.expires_in || 3600) - 60) * 1000 };
  }
  const res = await fetch(
    "https://oauth.reddit.com/search?q=" +
      encodeURIComponent(keyword) +
      "&sort=relevance&t=year&limit=20&type=link",
    { headers: { authorization: "Bearer " + tokenCache.token, "user-agent": REDDIT_UA } },
  );
  if (!res.ok) {
    if (res.status === 401) tokenCache = { token: null, exp: 0 };
    return null;
  }
  const data = await res.json().catch(() => null);
  return (data?.data?.children || []).map((c) => normalize(c.data)).filter(Boolean);
}

async function searchReddit(keyword) {
  // Primary: credential-free PullPush. Fall back to OAuth (if configured),
  // then public Reddit. Return whatever first yields real threads.
  const sources = [
    () => searchPullPush(keyword),
    () => searchOAuth(keyword),
    () => searchPublicReddit(keyword),
  ];
  let lastErr;
  for (const run of sources) {
    try {
      const rows = await run();
      if (rows && rows.length) return rows;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) {
    const err = new Error(
      "Couldn't reach a Reddit data source right now. Please try again in a moment.",
    );
    err.status = 502;
    throw err;
  }
  return []; // sources responded but found nothing
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

const REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    replies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          postId: { type: "string" },
          reply: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["postId", "reply", "rationale"],
      },
    },
  },
  required: ["replies"],
};

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
    .slice(0, 5);

  if (scored.length === 0) {
    return json({ opportunities: [], note: "No matching public Reddit threads found. Try a broader keyword." });
  }

  // 2. Draft replies with Claude
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const promptThreads = scored
    .map(
      (p, i) =>
        `${i + 1}. postId=${p.id} | ${p.subreddit} | "${p.title}"\n   ${p.snippet || "(no body)"}`,
    )
    .join("\n\n");

  const system =
    "You are a Reddit marketing co-pilot. Write authentic, value-first replies that genuinely help the original poster and only mention the brand if it is truly relevant. Never sound like an ad. Respect subreddit culture: be human, specific, and helpful. Disclose affiliation naturally if you recommend the product. Keep each reply 2-5 sentences.";

  const userMsg = `BRAND / PRODUCT:\n${product}\n\nPERSONA (who is replying):\n${persona || "A helpful, experienced practitioner."}\n\nFor each Reddit thread below, write one reply draft. Return JSON only.\n\nTHREADS:\n${promptThreads}`;

  let drafts = {};
  try {
    const resp = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: userMsg }],
      output_config: { format: { type: "json_schema", schema: REPLY_SCHEMA } },
    });
    const text = resp.content.find((b) => b.type === "text")?.text || "{}";
    const parsed = JSON.parse(text);
    for (const r of parsed.replies || []) drafts[r.postId] = r;
  } catch (e) {
    return json({ error: "AI generation failed: " + (e.message || "unknown error") }, 502);
  }

  const opportunities = scored.map((p) => ({
    ...p,
    reply: drafts[p.id]?.reply || "",
    rationale: drafts[p.id]?.rationale || "",
  }));

  return json({ opportunities });
}
