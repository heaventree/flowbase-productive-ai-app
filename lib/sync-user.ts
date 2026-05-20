import "server-only";

import { currentUser } from "@clerk/nextjs/server";

import { supabase } from "@/db";
import { getLiveblocksUserId, normalizeCollaborationEmail } from "@/lib/liveblocks";

export async function syncCurrentUserToDatabase() {
  const user = await currentUser();

  const email = user?.primaryEmailAddress?.emailAddress;
  const clerkId = user?.id;

  if (!email || !clerkId) {
    return;
  }

  const normalizedEmail = normalizeCollaborationEmail(email);
  const name =
    user.fullName ||
    user.username ||
    normalizedEmail.split("@")[0] ||
    null;

  await supabase
    .from("users")
    .upsert(
      {
        clerk_id: clerkId,
        email: normalizedEmail,
        liveblocks_id: getLiveblocksUserId(normalizedEmail),
        name,
      },
      { onConflict: "clerk_id" },
    );
}
