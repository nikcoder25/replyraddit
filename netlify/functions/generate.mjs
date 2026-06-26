import Anthropic from "@anthropic-ai/sdk";
import { verifyToken, bearer, json } from "./_auth.mjs";

// ---- Reddit discovery (public JSON, read-only — no account/auth) ----
// Reddit blocks requests without a real browser User-Agent (HTTP 403).
const REDDIT_HOSTS = ["https://www.reddit.com", "https://old.reddit.com"];
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function searchReddit(keyword) {
  const path =
    "/search.json?q=" +
    encodeURIComponent(keyword) +
    "&sort=relevance&t=year&limit=15";

  let lastStatus = 0;
  for (const host of REDDIT_HOSTS) {
    let res;
    try {
      res = await fetch(host + path, {
        headers: {
          "user-agent": BROWSER_UA,
          accept: "application/json, text/javascript, */*; q=0.01",
          "accept-language": "en-US,en;q=0.9",
        },
      });
    } catch {
      lastStatus = -1;
      continue; // network error — try next host
    }
    if (res.ok) {
      const data = await res.json().catch(() => null);
      return (data?.data?.children || [])
        .map((c) => c.data)
        .filter((p) => p && !p.over_18 && p.subreddit && p.title);
    }
    lastStatus = res.status;
    // Only worth trying the fallback host on a block / rate-limit.
    if (res.status !== 403 && res.status !== 429) break;
  }

  const err = new Error(
    lastStatus === 403 || lastStatus === 429
      ? "Reddit is temporarily blocking automated search from this server (HTTP " +
        lastStatus +
        "). This can happen from cloud IPs — please try again in a moment."
      : "Reddit search failed (HTTP " + lastStatus + ").",
  );
  err.status = lastStatus;
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
