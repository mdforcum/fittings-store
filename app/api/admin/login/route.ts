import { endSession, passwordMatches, sameOrigin, startSession } from "@/lib/auth";
import { env, json } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "forbidden" }, 403);
  if (!env.adminPassword) return json({ error: "not_configured", message: "ADMIN_PASSWORD is not set." }, 503);
  let password = "";
  try {
    password = String(((await req.json()) as { password?: unknown }).password ?? "");
  } catch {
    /* fall through to the wrong-password path */
  }
  if (!passwordMatches(password)) {
    await new Promise((r) => setTimeout(r, 900)); // slows down guessing
    return json({ error: "wrong", message: "That password is not right." }, 401);
  }
  await startSession();
  return json({ ok: true });
}

export async function DELETE(req: Request) {
  if (!sameOrigin(req)) return json({ error: "forbidden" }, 403);
  await endSession();
  return json({ ok: true });
}
