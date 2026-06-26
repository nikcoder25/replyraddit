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
  status.innerHTML = '<span class="spinner"></span> Scanning Reddit and drafting replies… this can take 15–30s.';
  const btn = $("genSubmit");
  btn.disabled = true;

  try {
    const data = await api(
      "/generate",
      {
        keyword: $("keyword").value,
        product: $("product").value,
        persona: $("persona").value,
      },
      true,
    );
    status.hidden = true;
    renderResults(data.opportunities || [], data.note);
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

function renderResults(opps, note) {
  const results = $("results");
  if (!opps.length) {
    results.innerHTML = `<p class="gen-status">${note || "No opportunities found. Try a different keyword."}</p>`;
    return;
  }
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
        <textarea>${escapeHtml(o.reply || "(no draft generated)")}</textarea>
        ${o.rationale ? `<div class="reply-rationale">Why: ${escapeHtml(o.rationale)}</div>` : ""}
        <div class="reply-actions">
          <button class="chip chip-primary" data-copy>Copy reply</button>
          <a class="chip" href="${o.url}" target="_blank" rel="noopener">Open thread ↗</a>
        </div>
      </div>`;
    const copyBtn = el.querySelector("[data-copy]");
    const ta = el.querySelector("textarea");
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(ta.value);
      copyBtn.textContent = "Copied ✓";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = "Copy reply";
        copyBtn.classList.remove("copied");
      }, 1600);
    });
    results.appendChild(el);
  }
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
