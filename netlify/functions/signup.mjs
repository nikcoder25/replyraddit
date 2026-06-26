import { usersStore, hashPassword, signToken, json, normalizeEmail } from "./_auth.mjs";

const WEEK = 7 * 24 * 60 * 60 * 1000;

export default async function handler(req) {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  if (!email || !email.includes("@")) return json({ error: "Enter a valid email." }, 400);
  if (password.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);

  const store = usersStore();
  const existing = await store.get(email, { type: "json" });
  if (existing) return json({ error: "An account with this email already exists." }, 409);

  const user = {
    email,
    password: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  await store.setJSON(email, user);

  const token = signToken({ email, exp: Date.now() + WEEK });
  return json({ token, user: { email } });
}
