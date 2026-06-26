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
  const deadline = Date.now() + 90000; // ScraperAPI can take a while
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
  try {
    const jobId =
      (crypto.randomUUID && crypto.randomUUID()) ||
      Date.now() + "-" + Math.floor(Math.random() * 1e9);
    // Kick off the background search (returns 202 immediately), then poll.
    await api("/generate-background", { jobId, keyword: $("keyword").value }, true);
    const rec = await pollJob(jobId, status);
    status.hidden = true;
    const opps = rec.opportunities || [];
    if (!opps.length) {
      results.innerHTML = `<p class="gen-status">${escapeHtml(rec.note || "No opportunities found. Try a different keyword.")}</p>`;
      return;
    }
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
