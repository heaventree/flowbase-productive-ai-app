import { currentUser } from "@clerk/nextjs/server";

import { supabase } from "@/db";
import {
  createLiveblocksClient,
  getAvatarColor,
  getInitials,
  getLiveblocksUserId,
  normalizeCollaborationEmail,
} from "@/lib/liveblocks";

function parseKanbanRoomId(room?: string) {
  const match = room?.match(/^kanban-board:(\d+)$/);
  return match ? Number(match[1]) : null;
}

export async function POST(request: Request) {
  const { room } = (await request.json().catch(() => ({}))) as { room?: string };
  const boardId = parseKanbanRoomId(room);

  if (!room || !boardId) {
    return new Response("Invalid Liveblocks room.", { status: 400 });
  }

  const clerkUser = await currentUser();
  const email = clerkUser?.primaryEmailAddress?.emailAddress;
  const clerkId = clerkUser?.id;

  if (!email || !clerkId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const normalizedEmail = normalizeCollaborationEmail(email);
  const liveblocksId = getLiveblocksUserId(normalizedEmail);
  const name = clerkUser.fullName || clerkUser.username || normalizedEmail.split("@")[0] || null;

  const { data: databaseUser, error } = await supabase
    .from("users")
    .upsert(
      { clerk_id: clerkId, email: normalizedEmail, liveblocks_id: liveblocksId, name },
      { onConflict: "clerk_id" },
    )
    .select("id")
    .single();

  if (error) {
    return new Response("Database error.", { status: 500 });
  }

  await supabase
    .from("kanban_board_shares")
    .update({ accepted_user_id: databaseUser.id, updated_at: new Date().toISOString() })
    .eq("email", normalizedEmail)
    .eq("role", "editor");

  const { data: ownedBoard } = await supabase
    .from("kanban_boards")
    .select("id")
    .eq("id", boardId)
    .eq("user_id", databaseUser.id)
    .maybeSingle();

  const { data: sharedBoard } = ownedBoard
    ? { data: null }
    : await supabase
        .from("kanban_board_shares")
        .select("id")
        .eq("board_id", boardId)
        .eq("email", normalizedEmail)
        .eq("role", "editor")
        .maybeSingle();

  if (!ownedBoard && !sharedBoard) {
    return new Response("Forbidden", { status: 403 });
  }

  const session = createLiveblocksClient().prepareSession(liveblocksId, {
    userInfo: {
      name: name ?? normalizedEmail,
      email: normalizedEmail,
      color: getAvatarColor(normalizedEmail),
      initials: getInitials(name ?? normalizedEmail),
    },
  });

  session.allow(room, session.FULL_ACCESS);
  const response = await session.authorize();

  return new Response(response.body, { status: response.status });
}
