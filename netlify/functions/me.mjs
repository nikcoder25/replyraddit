import { verifyToken, bearer, json } from "./_auth.mjs";

export default async function handler(req) {
  const payload = verifyToken(bearer(req));
  if (!payload) return json({ error: "Not authenticated" }, 401);
  return json({ user: { email: payload.email } });
}
