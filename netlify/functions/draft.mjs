// Drafts ONE reply for a single thread — fast, isolated request so it never
// risks the function timeout. The frontend calls this once per opportunity.
import Anthropic from "@anthropic-ai/sdk";
import { verifyToken, bearer, json } from "./_auth.mjs";

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
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const product = String(body.product || "").trim();
  const persona = String(body.persona || "").trim();
  const title = String(body.title || "").trim();
  const subreddit = String(body.subreddit || "").trim();
  const snippet = String(body.snippet || "").slice(0, 220);
  if (!title) return json({ error: "Missing thread." }, 400);
  if (!product) return json({ error: "Describe your product / brand." }, 400);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const userMsg =
    `BRAND / PRODUCT:\n${product}\n\n` +
    `PERSONA (who is replying):\n${persona || "A helpful, experienced practitioner."}\n\n` +
    `REDDIT THREAD:\n${subreddit} — "${title}"\n${snippet || "(no body)"}\n\n` +
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
      { timeout: 8000 },
    );
    const text = resp.content.find((b) => b.type === "text")?.text || "{}";
    const parsed = JSON.parse(text);
    return json({ reply: parsed.reply || "", rationale: parsed.rationale || "" });
  } catch (e) {
    return json({ error: "AI generation failed: " + (e.message || "unknown error") }, 502);
  }
}
