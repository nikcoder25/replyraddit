// ReplyRaddit app — auth + opportunity generation.
const API = "/.netlify/functions";
const TOKEN_KEY = "rr_token";

const $ = (id) => document.getElementById(id);
const token = () => localStorage.getItem(TOKEN_KEY);
const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const clearToken = () => localStorage.removeItem(TOKEN_KEY);

$("year").textContent = new Date().getFullYear();

let mode = "login"; // or "signup"

async function api(path, body, auth = false) {
  const headers = { "content-type": "application/json" };
  if (auth && token()) headers.authorization = "Bearer " + token();
  const res = await fetch(API + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll the background search job until it finishes (or times out).
async function pollJob(jobId, statusEl) {
  const deadline = Date.now() + 210000; // ScraperAPI async can take a couple minutes
  let secs = 0;
  while (Date.now() < deadline) {
    await sleep(2000);
    secs += 2;
    const rec = await api("/job-status", { jobId }, true);
    if (rec.status === "done" || rec.status === "empty") return rec;
    if (rec.status === "error") throw new Error(rec.error || "Search failed.");
    if (statusEl)
      statusEl.innerHTML =
        '<span class="spinner"></span> Scanning Reddit for opportunities… (' + secs + 's)';
  }
  throw new Error("Search timed out — please try again or use a broader keyword.");
}

// Fetch Reddit search results from the browser via JSONP (script tag) — runs on
// the user's residential IP, so it sidesteps the datacenter-IP block and CORS.
function redditJSONP(keyword) {
  return new Promise((resolve, reject) => {
    const cb = "rr_cb_" + Math.random().toString(36).slice(2);
    const url =
      "https://www.reddit.com/search.json?q=" +
      encodeURIComponent(keyword) +
      "&sort=relevance&t=year&limit=20&raw_json=1&jsonp=" +
      cb;
    const script = document.createElement("script");
    let done = false;
    const timer = setTimeout(() => finish(() => reject(new Error("Reddit request timed out"))), 12000);
    function cleanup() {
      clearTimeout(timer);
      try { delete window[cb]; } catch (_) { window[cb] = undefined; }
      script.remove();
    }
    function finish(fn) { if (done) return; done = true; cleanup(); fn(); }
    window[cb] = (data) =>
      finish(() => resolve((data && data.data && data.data.children) || []));
    script.onerror = () => finish(() => reject(new Error("Reddit request failed")));
    script.src = url;
    document.head.appendChild(script);
  });
}

function scoreClient(post, keyword) {
  const kw = keyword.toLowerCase();
  const title = (post.title || "").toLowerCase();
  const body = (post.selftext || "").toLowerCase();
  let relevance = 0;
  if (title.includes(kw)) relevance += 1;
  for (const w of kw.split(/\s+/).filter(Boolean)) {
    if (title.includes(w)) relevance += 0.25;
    if (body.includes(w)) relevance += 0.1;
  }
  relevance = Math.min(relevance, 1);
  const ageDays = (Date.now() / 1000 - (post.created_utc || 0)) / 86400;
  const recency = Math.max(0, 1 - ageDays / 365);
  const engagement = Math.min(1, Math.log10((post.num_comments || 0) + 1) / 2);
  const isQuestion = /\?|how|what|which|recommend|looking for|best/i.test(post.title) ? 1 : 0.4;
  return Math.round((0.7 * relevance + 0.12 * recency + 0.1 * engagement + 0.08 * isQuestion) * 100);
}

function rankClient(children, keyword) {
  return (children || [])
    .map((c) => c && c.data)
    .filter((p) => p && !p.over_18 && p.subreddit && p.title)
    .map((p) => ({
      id: p.id,
      title: p.title,
      subreddit: "r/" + p.subreddit,
      url: "https://www.reddit.com" + p.permalink,
      snippet: (p.selftext || "").slice(0, 400),
      comments: p.num_comments || 0,
      score: scoreClient(p, keyword),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// ---- view switching ----
function showApp(email) {
  $("authView").hidden = true;
  $("dashView").hidden = false;
  $("navUser").hidden = false;
  $("userEmail").textContent = email;
}
function showAuth() {
  $("authView").hidden = false;
  $("dashView").hidden = true;
  $("navUser").hidden = true;
}

// ---- auth form ----
function renderMode() {
  const signup = mode === "signup";
  $("authTitle").textContent = signup ? "Create your account" : "Log in to ReplyRaddit";
  $("authSubmit").textContent = signup ? "Sign up" : "Log in";
  $("toggleText").textContent = signup ? "Already have an account?" : "No account yet?";
  $("toggleLink").textContent = signup ? "Log in" : "Sign up";
  $("password").autocomplete = signup ? "new-password" : "current-password";
  $("authError").hidden = true;
}

$("toggleLink").addEventListener("click", (e) => {
  e.preventDefault();
  mode = mode === "login" ? "signup" : "login";
  renderMode();
});

$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("authError");
  err.hidden = true;
  const btn = $("authSubmit");
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Please wait…";
  try {
    const data = await api("/" + mode, {
      email: $("email").value,
      password: $("password").value,
    });
    setToken(data.token);
    showApp(data.user.email);
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

$("logoutBtn").addEventListener("click", () => {
  clearToken();
  showAuth();
});

// ---- generate ----
$("genForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("status");
  const results = $("results");
  results.innerHTML = "";
  status.hidden = false;
  status.className = "gen-status";
  status.innerHTML = '<span class="spinner"></span> Scanning Reddit for opportunities…';
  const btn = $("genSubmit");
  btn.disabled = true;

  const product = $("product").value;
  const persona = $("persona").value;
  const keyword = $("keyword").value.trim();
  try {
    let opps = [];

    // Primary: fetch Reddit from the user's browser (residential IP) via JSONP —
    // bypasses Reddit's datacenter-IP block and CORS. No server, no scraper.
    try {
      const children = await redditJSONP(keyword);
      opps = rankClient(children, keyword);
    } catch (_) {
      /* JSONP unavailable/blocked — fall through to the server fallback */
    }

    // Fallback: server-side background search (proxies / ScraperAPI).
    if (!opps.length) {
      status.innerHTML = '<span class="spinner"></span> Searching… (server fallback, can take a minute)';
      const jobId =
        (crypto.randomUUID && crypto.randomUUID()) ||
        Date.now() + "-" + Math.floor(Math.random() * 1e9);
      await api("/generate-background", { jobId, keyword }, true);
      const rec = await pollJob(jobId, status);
      opps = rec.opportunities || [];
      if (!opps.length) {
        status.hidden = true;
        results.innerHTML = `<p class="gen-status">${escapeHtml(rec.note || "No opportunities found. Try a different keyword.")}</p>`;
        return;
      }
    }

    status.hidden = true;
    renderOpportunities(opps, product, persona);
  } catch (e2) {
    if (/not authenticated/i.test(e2.message)) {
      clearToken();
      showAuth();
      return;
    }
    status.className = "gen-status error";
    status.textContent = "⚠ " + e2.message;
  } finally {
    btn.disabled = false;
  }
});

function renderOpportunities(opps, product, persona) {
  const results = $("results");
  results.innerHTML = "";
  for (const o of opps) {
    const el = document.createElement("div");
    el.className = "opp";
    el.innerHTML = `
      <div class="opp-top">
        <div class="opp-score ${o.score >= 70 ? "hi" : ""}">${o.score}</div>
        <div class="opp-meta">
          <div class="opp-sub">${escapeHtml(o.subreddit)}</div>
          <div class="opp-title"><a href="${o.url}" target="_blank" rel="noopener">${escapeHtml(o.title)}</a></div>
          <div class="opp-stats">${o.comments} comments · relevance score ${o.score}/100</div>
        </div>
      </div>
      <div class="reply-draft">
        <span class="reply-label">Suggested reply · draft</span>
        <div class="draft-slot"><span class="spinner"></span> Drafting reply…</div>
      </div>`;
    results.appendChild(el);

    const slot = el.querySelector(".draft-slot");
    api("/draft", { title: o.title, subreddit: o.subreddit, snippet: o.snippet, product, persona }, true)
      .then((d) => fillDraft(slot, d.reply || "", d.rationale || "", o.url))
      .catch((err) => {
        slot.innerHTML = `<div class="reply-rationale">Couldn't draft a reply: ${escapeHtml(err.message)}</div>`;
      });
  }
}

function fillDraft(slot, reply, rationale, url) {
  slot.innerHTML = `
    <textarea>${escapeHtml(reply || "(no draft generated)")}</textarea>
    ${rationale ? `<div class="reply-rationale">Why: ${escapeHtml(rationale)}</div>` : ""}
    <div class="reply-actions">
      <button class="chip chip-primary" data-copy>Copy reply</button>
      <a class="chip" href="${url}" target="_blank" rel="noopener">Open thread ↗</a>
    </div>`;
  const copyBtn = slot.querySelector("[data-copy]");
  const ta = slot.querySelector("textarea");
  copyBtn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(ta.value);
    copyBtn.textContent = "Copied ✓";
    copyBtn.classList.add("copied");
    setTimeout(() => {
      copyBtn.textContent = "Copy reply";
      copyBtn.classList.remove("copied");
    }, 1600);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

// ---- boot: restore session ----
(async function init() {
  renderMode();
  if (!token()) return showAuth();
  try {
    const data = await api("/me", {}, true);
    // /me is GET-friendly but we call POST; adjust if needed
    showApp(data.user.email);
  } catch {
    clearToken();
    showAuth();
  }
})();
