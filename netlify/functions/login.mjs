import { usersStore, verifyPassword, signToken, json, normalizeEmail } from "./_auth.mjs";

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

  const store = usersStore();
  const user = await store.get(email, { type: "json" });
  if (!user || !verifyPassword(password, user.password)) {
    return json({ error: "Incorrect email or password." }, 401);
  }

  const token = signToken({ email, exp: Date.now() + WEEK });
  return json({ token, user: { email } });
}
