import { currentUser, signOut } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who is signed in, if anyone. The client asks once on load. */
export async function GET() {
  const user = await currentUser();
  return Response.json(
    { user: user ? { email: user.email } : null },
    { headers: { "cache-control": "no-store" } }
  );
}

/** Signs out. Deletes the session server-side too, since clearing only the cookie leaves a usable token. */
export async function DELETE() {
  await signOut();
  return Response.json({ ok: true });
}
