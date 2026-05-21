import { currentUser } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";

import { db, kanbanBoardShares, kanbanBoards, users } from "@/db";
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

  const upserted = await db.insert(users)
    .values({ clerkId, email: normalizedEmail, liveblocksId, name })
    .onConflictDoUpdate({
      target: users.clerkId,
      set: { email: normalizedEmail, liveblocksId, name },
    })
    .returning({ id: users.id });

  if (!upserted[0]) {
    return new Response("Database error.", { status: 500 });
  }

  const databaseUserId = upserted[0].id;

  await db.update(kanbanBoardShares)
    .set({ acceptedUserId: databaseUserId, updatedAt: new Date().toISOString() })
    .where(and(eq(kanbanBoardShares.email, normalizedEmail), eq(kanbanBoardShares.role, "editor")));

  const ownedBoard = await db.select({ id: kanbanBoards.id })
    .from(kanbanBoards)
    .where(and(eq(kanbanBoards.id, boardId), eq(kanbanBoards.userId, databaseUserId)))
    .limit(1);

  const sharedBoard = ownedBoard.length === 0
    ? await db.select({ id: kanbanBoardShares.id })
        .from(kanbanBoardShares)
        .where(and(
          eq(kanbanBoardShares.boardId, boardId),
          eq(kanbanBoardShares.email, normalizedEmail),
          eq(kanbanBoardShares.role, "editor"),
        ))
        .limit(1)
    : [];

  if (ownedBoard.length === 0 && sharedBoard.length === 0) {
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
