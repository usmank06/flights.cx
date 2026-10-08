import type { Metadata } from "next";
import { AccountView } from "@/components/auth/account-view";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Your trips", robots: { index: false } };

/** Saved searches and price watches. Signing in only adds an address for watch emails. */
export default async function AccountPage() {
  // Read on the server so the first paint already shows who is signed in.
  const user = await currentUser();
  return <AccountView signedInAs={user?.email ?? null} />;
}
