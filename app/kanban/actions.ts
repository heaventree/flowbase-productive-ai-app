"use server";

import { currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";

import { db, users, kanbanBoards, kanbanColumns, kanbanTasks, kanbanBoardShares, calendarItems } from "@/db";
import { assertFreePlanLimit } from "@/lib/user-preferences";
import {
  createLiveblocksClient,
  getAvatarColor,
  getBoardRoomId,
  getInitials,
  getLiveblocksUserId,
  normalizeCollaborationEmail,
} from "@/lib/liveblocks";

const boardColors = ["sage", "clay", "amber", "sky", "violet"] as const;
const priorities = ["low", "medium", "high"] as const;
const labelColors = ["sage", "clay", "amber", "sky", "violet"] as const;
const defaultColumns = ["Todo", "In Progress", "Done"];
const maxColumns = 5;

export type BoardColor = (typeof boardColors)[number];
export type TaskPriority = (typeof priorities)[number];
export type LabelColor = (typeof labelColors)[number];

export type KanbanLabelDTO = {
  name: string;
  color: LabelColor;
};

export type KanbanTaskDTO = {
  id: number;
  columnId: number;
  title: string;
  description: string | null;
  dueDate: string;
  priority: TaskPriority;
  category: string | null;
  labels: KanbanLabelDTO[];
  syncCalendar: boolean;
  linkNotes: boolean;
  calendarItemId: number | null;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type KanbanCollaboratorDTO = {
  id: number | null;
  name: string | null;
  email: string;
  liveblocksId: string;
  role: "owner" | "editor";
  color: string;
  initials: string;
};

export type KanbanColumnDTO = {
  id: number;
  boardId: number;
  name: string;
  position: number;
  tasks: KanbanTaskDTO[];
};

export type KanbanBoardDTO = {
  id: number;
  name: string;
  color: BoardColor;
  owner: KanbanCollaboratorDTO;
  shares: KanbanCollaboratorDTO[];
  canManage: boolean;
  createdAt: string;
  updatedAt: string;
  columns: KanbanColumnDTO[];
};

export type BoardInput = {
  name: string;
  color: string;
};

export type ColumnInput = {
  boardId: number;
  name: string;
};

export type TaskInput = {
  columnId: number;
  title: string;
  description?: string;
  dueDate: string;
  priority: string;
  category?: string | null;
  labels: KanbanLabelDTO[];
  syncCalendar: boolean;
  linkNotes: boolean;
};

export type InviteInput = {
  boardId: number;
  email: string;
};

function normalizeBoardColor(value: string): BoardColor {
  return boardColors.includes(value as BoardColor) ? (value as BoardColor) : "sage";
}

function normalizePriority(value: string): TaskPriority {
  return priorities.includes(value as TaskPriority) ? (value as TaskPriority) : "medium";
}

function normalizeLabelColor(value: string): LabelColor {
  return labelColors.includes(value as LabelColor) ? (value as LabelColor) : "sage";
}

function cleanOptionalText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeLabels(labels: { name: string; color: string }[]) {
  return labels
    .map((label) => ({ name: label.name.trim(), color: normalizeLabelColor(label.color) }))
    .filter((label) => label.name)
    .slice(0, 5);
}

function normalizeCategory(value?: string | null) {
  return cleanOptionalText(value)?.slice(0, 36) ?? null;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function toCollaboratorDTO(input: {
  id: number | null;
  name: string | null;
  email: string;
  role: "owner" | "editor";
  liveblocksId?: string | null;
}): KanbanCollaboratorDTO {
  const email = normalizeCollaborationEmail(input.email);
  const liveblocksId = input.liveblocksId || getLiveblocksUserId(email);
  const display = input.name || email;

  return {
    id: input.id,
    name: input.name,
    email,
    liveblocksId,
    role: input.role,
    color: getAvatarColor(email),
    initials: getInitials(display),
  };
}

function toTaskDTO(task: any): KanbanTaskDTO {
  return {
    id: task.id,
    columnId: task.columnId,
    title: task.title,
    description: task.description,
    dueDate: task.dueDate,
    priority: normalizePriority(task.priority),
    category: normalizeCategory(task.category),
    labels: normalizeLabels(Array.isArray(task.labels) ? task.labels : []),
    syncCalendar: task.syncCalendar,
    linkNotes: task.linkNotes,
    calendarItemId: task.calendarItemId,
    position: task.position,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

async function getCurrentDatabaseUser() {
  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress;
  const clerkId = user?.id;

  if (!email || !clerkId) {
    throw new Error("You must be signed in to manage Kanban boards.");
  }

  const normalizedEmail = normalizeCollaborationEmail(email);
  const liveblocksId = getLiveblocksUserId(normalizedEmail);
  const name = user.fullName || user.username || normalizedEmail.split("@")[0] || null;

  const result = await db.insert(users)
    .values({ clerkId, email: normalizedEmail, liveblocksId, name })
    .onConflictDoUpdate({
      target: users.clerkId,
      set: { email: normalizedEmail, liveblocksId, name },
    })
    .returning({ id: users.id, email: users.email, liveblocksId: users.liveblocksId, name: users.name });

  const databaseUser = result[0];
  if (!databaseUser) throw new Error("Failed to upsert user.");

  await db.update(kanbanBoardShares)
    .set({ acceptedUserId: databaseUser.id, updatedAt: new Date().toISOString() })
    .where(and(eq(kanbanBoardShares.email, normalizedEmail), eq(kanbanBoardShares.role, "editor")));

  return {
    id: databaseUser.id,
    email: normalizedEmail,
    liveblocksId,
    name: databaseUser.name,
  };
}

async function assertBoardOwner(boardId: number, userId: number) {
  const rows = await db.select().from(kanbanBoards)
    .where(and(eq(kanbanBoards.id, boardId), eq(kanbanBoards.userId, userId)))
    .limit(1);

  if (!rows[0]) {
    throw new Error("Kanban board not found.");
  }

  return rows[0];
}

async function assertBoardAccess(boardId: number, user: Awaited<ReturnType<typeof getCurrentDatabaseUser>>) {
  const ownedRows = await db.select().from(kanbanBoards)
    .where(and(eq(kanbanBoards.id, boardId), eq(kanbanBoards.userId, user.id)))
    .limit(1);

  if (ownedRows[0]) {
    return { board: ownedRows[0], canManage: true };
  }

  const shareRows = await db.select().from(kanbanBoardShares)
    .where(and(
      eq(kanbanBoardShares.boardId, boardId),
      eq(kanbanBoardShares.email, user.email),
      eq(kanbanBoardShares.role, "editor"),
    ))
    .limit(1);

  if (!shareRows[0]) {
    throw new Error("Kanban board not found.");
  }

  const boardRows = await db.select().from(kanbanBoards).where(eq(kanbanBoards.id, boardId)).limit(1);
  if (!boardRows[0]) throw new Error("Kanban board not found.");

  return { board: boardRows[0], canManage: false };
}

async function assertColumnAccess(columnId: number, user: Awaited<ReturnType<typeof getCurrentDatabaseUser>>) {
  const columnRows = await db.select().from(kanbanColumns).where(eq(kanbanColumns.id, columnId)).limit(1);
  if (!columnRows[0]) throw new Error("Kanban column not found.");

  const column = columnRows[0];
  const { board } = await assertBoardAccess(column.boardId, user);
  return { column, board };
}

async function assertTaskAccess(taskId: number, user: Awaited<ReturnType<typeof getCurrentDatabaseUser>>) {
  const taskRows = await db.select().from(kanbanTasks).where(eq(kanbanTasks.id, taskId)).limit(1);
  if (!taskRows[0]) throw new Error("Kanban task not found.");

  const task = taskRows[0];
  const { column, board } = await assertColumnAccess(task.columnId, user);
  return { task, column, board };
}

async function upsertLiveblocksRoom(boardId: number) {
  const boardRows = await db.select().from(kanbanBoards).where(eq(kanbanBoards.id, boardId)).limit(1);
  if (!boardRows[0]) return;

  const ownerRows = await db.select().from(users).where(eq(users.id, boardRows[0].userId)).limit(1);
  if (!ownerRows[0]) return;

  const shares = await db.select().from(kanbanBoardShares).where(eq(kanbanBoardShares.boardId, boardId));
  const usersAccesses = [ownerRows[0].email, ...shares.map((share) => share.email)].reduce<Record<string, ["room:write"]>>((accesses, email) => {
    accesses[getLiveblocksUserId(email)] = ["room:write"];
    return accesses;
  }, {});

  await createLiveblocksClient().upsertRoom(getBoardRoomId(boardId), {
    update: {
      defaultAccesses: [],
      usersAccesses,
      metadata: { kind: "kanban", boardId: String(boardId) },
    },
    create: {
      defaultAccesses: [],
      usersAccesses,
      metadata: { kind: "kanban", boardId: String(boardId) },
    },
  });
}

async function nextColumnPosition(boardId: number) {
  const columns = await db.select({ id: kanbanColumns.id }).from(kanbanColumns).where(eq(kanbanColumns.boardId, boardId));
  return columns.length;
}

async function nextTaskPosition(columnId: number) {
  const tasks = await db.select({ id: kanbanTasks.id }).from(kanbanTasks).where(eq(kanbanTasks.columnId, columnId));
  return tasks.length;
}

async function syncCalendarItem(userId: number, input: {
  title: string;
  description?: string | null;
  dueDate: string;
  syncCalendar: boolean;
  calendarItemId?: number | null;
}) {
  if (!input.syncCalendar) {
    if (input.calendarItemId) {
      await db.delete(calendarItems).where(and(eq(calendarItems.id, input.calendarItemId), eq(calendarItems.userId, userId)));
    }
    return null;
  }

  const itemValues = {
    title: input.title,
    description: cleanOptionalText(input.description),
    itemType: "task",
    category: "work",
    scheduledDate: input.dueDate,
    scheduledTime: null as string | null,
    isDraft: false,
    updatedAt: new Date().toISOString(),
  };

  if (input.calendarItemId) {
    const updated = await db.update(calendarItems)
      .set(itemValues)
      .where(and(eq(calendarItems.id, input.calendarItemId), eq(calendarItems.userId, userId)))
      .returning({ id: calendarItems.id });

    if (updated[0]) return updated[0].id;
  }

  const inserted = await db.insert(calendarItems)
    .values({ userId, ...itemValues })
    .returning({ id: calendarItems.id });

  return inserted[0]?.id ?? null;
}

async function deleteLinkedCalendarItems(calendarItemIds: number[], userId: number) {
  if (calendarItemIds.length === 0) return;
  await db.delete(calendarItems).where(and(inArray(calendarItems.id, calendarItemIds), eq(calendarItems.userId, userId)));
}

export async function listKanbanBoards() {
  const user = await getCurrentDatabaseUser();

  const ownedBoards = await db.select().from(kanbanBoards)
    .where(eq(kanbanBoards.userId, user.id))
    .orderBy(kanbanBoards.createdAt, kanbanBoards.id);

  const sharedRows = await db.select().from(kanbanBoardShares)
    .where(and(eq(kanbanBoardShares.email, user.email), eq(kanbanBoardShares.role, "editor")));

  const sharedBoardIds = sharedRows.map((row) => row.boardId);
  const sharedBoards = sharedBoardIds.length > 0
    ? await db.select().from(kanbanBoards).where(inArray(kanbanBoards.id, sharedBoardIds))
    : [];

  const boardsById = new Map(
    [...ownedBoards, ...sharedBoards].map((board) => [board.id, board]),
  );
  const boards = Array.from(boardsById.values()).sort((left, right) => {
    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() || left.id - right.id;
  });

  if (boards.length === 0) return [];

  const boardIds = boards.map((board) => board.id);
  const ownerIds = Array.from(new Set(boards.map((board) => board.userId)));

  const [owners, shares, columns] = await Promise.all([
    db.select().from(users).where(inArray(users.id, ownerIds)),
    db.select().from(kanbanBoardShares).where(inArray(kanbanBoardShares.boardId, boardIds)).orderBy(kanbanBoardShares.createdAt, kanbanBoardShares.id),
    db.select().from(kanbanColumns).where(inArray(kanbanColumns.boardId, boardIds)).orderBy(kanbanColumns.position, kanbanColumns.id),
  ]);

  const ownerById = new Map(owners.map((owner) => [owner.id, owner]));
  const acceptedUserIds = shares.map((share) => share.acceptedUserId).filter(Boolean) as number[];
  const acceptedUsers = acceptedUserIds.length > 0
    ? await db.select().from(users).where(inArray(users.id, acceptedUserIds))
    : [];
  const acceptedUserById = new Map(acceptedUsers.map((u) => [u.id, u]));

  const sharesByBoard = shares.reduce<Record<number, KanbanCollaboratorDTO[]>>((grouped, share) => {
    const acceptedUser = share.acceptedUserId ? acceptedUserById.get(share.acceptedUserId) : null;
    grouped[share.boardId] = [
      ...(grouped[share.boardId] || []),
      toCollaboratorDTO({
        id: acceptedUser?.id ?? null,
        name: acceptedUser?.name ?? null,
        email: share.email,
        liveblocksId: acceptedUser?.liveblocksId,
        role: "editor",
      }),
    ];
    return grouped;
  }, {});

  const columnIds = columns.map((column) => column.id);
  const tasks = columnIds.length > 0
    ? await db.select().from(kanbanTasks).where(inArray(kanbanTasks.columnId, columnIds)).orderBy(kanbanTasks.position, kanbanTasks.id)
    : [];

  const tasksByColumn = tasks.reduce<Record<number, KanbanTaskDTO[]>>((grouped, task) => {
    grouped[task.columnId] = [...(grouped[task.columnId] || []), toTaskDTO(task)];
    return grouped;
  }, {});

  const columnsByBoard = columns.reduce<Record<number, KanbanColumnDTO[]>>((grouped, column) => {
    grouped[column.boardId] = [
      ...(grouped[column.boardId] || []),
      {
        id: column.id,
        boardId: column.boardId,
        name: column.name,
        position: column.position,
        tasks: tasksByColumn[column.id] || [],
      },
    ];
    return grouped;
  }, {});

  return boards.map<KanbanBoardDTO>((board) => ({
    id: board.id,
    name: board.name,
    color: normalizeBoardColor(board.color),
    owner: toCollaboratorDTO({
      id: board.userId,
      name: ownerById.get(board.userId)?.name ?? null,
      email: ownerById.get(board.userId)?.email ?? user.email,
      liveblocksId: ownerById.get(board.userId)?.liveblocksId,
      role: "owner",
    }),
    shares: sharesByBoard[board.id] || [],
    canManage: board.userId === user.id,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    columns: columnsByBoard[board.id] || [],
  }));
}

export async function createKanbanBoard(input: BoardInput) {
  await assertFreePlanLimit("boards");
  const user = await getCurrentDatabaseUser();
  const name = input.name.trim();

  if (!name) {
    throw new Error("Board name is required.");
  }

  const boardResult = await db.insert(kanbanBoards)
    .values({ userId: user.id, name, color: normalizeBoardColor(input.color), updatedAt: new Date().toISOString() })
    .returning({ id: kanbanBoards.id });

  if (!boardResult[0]) throw new Error("Failed to create board.");
  const boardId = boardResult[0].id;

  await db.insert(kanbanColumns).values(defaultColumns.map((columnName, index) => ({ boardId, name: columnName, position: index })));

  await upsertLiveblocksRoom(boardId);

  revalidatePath("/kanban");
  return (await listKanbanBoards()).find((nextBoard) => nextBoard.id === boardId)!;
}

export async function updateKanbanBoard(boardId: number, input: BoardInput) {
  const user = await getCurrentDatabaseUser();
  await assertBoardOwner(boardId, user.id);
  const name = input.name.trim();

  if (!name) {
    throw new Error("Board name is required.");
  }

  await db.update(kanbanBoards)
    .set({ name, color: normalizeBoardColor(input.color), updatedAt: new Date().toISOString() })
    .where(and(eq(kanbanBoards.id, boardId), eq(kanbanBoards.userId, user.id)));

  revalidatePath("/kanban");
  return listKanbanBoards();
}

export async function deleteKanbanBoard(boardId: number) {
  const user = await getCurrentDatabaseUser();
  await assertBoardOwner(boardId, user.id);

  const columns = await db.select({ id: kanbanColumns.id }).from(kanbanColumns).where(eq(kanbanColumns.boardId, boardId));
  const columnIds = columns.map((c) => c.id);

  const calendarIds = columnIds.length > 0
    ? (await db.select({ calendarItemId: kanbanTasks.calendarItemId }).from(kanbanTasks).where(inArray(kanbanTasks.columnId, columnIds)))
        .map((t) => t.calendarItemId).filter(Boolean) as number[]
    : [];

  await deleteLinkedCalendarItems(calendarIds, user.id);
  await db.delete(kanbanBoards).where(and(eq(kanbanBoards.id, boardId), eq(kanbanBoards.userId, user.id)));

  revalidatePath("/kanban");
  revalidatePath("/calendar");
  return listKanbanBoards();
}

export async function inviteKanbanCollaborator(input: InviteInput) {
  const user = await getCurrentDatabaseUser();
  const board = await assertBoardOwner(input.boardId, user.id);
  const email = normalizeCollaborationEmail(input.email);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid collaborator email.");
  }

  if (email === user.email) {
    throw new Error("You already own this board.");
  }

  const acceptedUserRows = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

  await db.insert(kanbanBoardShares)
    .values({
      boardId: board.id,
      email,
      role: "editor",
      invitedByUserId: user.id,
      acceptedUserId: acceptedUserRows[0]?.id ?? null,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [kanbanBoardShares.boardId, kanbanBoardShares.email],
      set: { role: "editor", invitedByUserId: user.id, acceptedUserId: acceptedUserRows[0]?.id ?? null, updatedAt: new Date().toISOString() },
    });

  await upsertLiveblocksRoom(board.id);
  revalidatePath("/kanban");

  return listKanbanBoards();
}

export async function createKanbanColumn(input: ColumnInput) {
  const user = await getCurrentDatabaseUser();
  await assertBoardAccess(input.boardId, user);
  const name = input.name.trim();

  if (!name) {
    throw new Error("Column name is required.");
  }

  const position = await nextColumnPosition(input.boardId);
  if (position >= maxColumns) {
    throw new Error("Each board can have up to 5 columns.");
  }

  await db.insert(kanbanColumns).values({ boardId: input.boardId, name, position, updatedAt: new Date().toISOString() });
  await db.update(kanbanBoards).set({ updatedAt: new Date().toISOString() }).where(eq(kanbanBoards.id, input.boardId));

  revalidatePath("/kanban");
  return listKanbanBoards();
}

export async function updateKanbanColumn(columnId: number, name: string) {
  const user = await getCurrentDatabaseUser();
  const { column } = await assertColumnAccess(columnId, user);
  const nextName = name.trim();

  if (!nextName) {
    throw new Error("Column name is required.");
  }

  await db.update(kanbanColumns).set({ name: nextName, updatedAt: new Date().toISOString() }).where(eq(kanbanColumns.id, columnId));
  await db.update(kanbanBoards).set({ updatedAt: new Date().toISOString() }).where(eq(kanbanBoards.id, column.boardId));

  revalidatePath("/kanban");
  return listKanbanBoards();
}

export async function deleteKanbanColumn(columnId: number) {
  const user = await getCurrentDatabaseUser();
  const { column } = await assertColumnAccess(columnId, user);

  const tasks = await db.select({ calendarItemId: kanbanTasks.calendarItemId }).from(kanbanTasks).where(eq(kanbanTasks.columnId, columnId));
  const calendarItemIds = tasks.map((t) => t.calendarItemId).filter(Boolean) as number[];

  await deleteLinkedCalendarItems(calendarItemIds, user.id);
  await db.delete(kanbanColumns).where(eq(kanbanColumns.id, columnId));
  await db.update(kanbanBoards).set({ updatedAt: new Date().toISOString() }).where(eq(kanbanBoards.id, column.boardId));

  revalidatePath("/kanban");
  revalidatePath("/calendar");
  return listKanbanBoards();
}

export async function createKanbanTask(input: TaskInput) {
  await assertFreePlanLimit("tasks");
  const user = await getCurrentDatabaseUser();
  const { column, board } = await assertColumnAccess(input.columnId, user);
  const title = input.title.trim();
  const dueDate = cleanOptionalText(input.dueDate) || todayKey();

  if (!title) {
    throw new Error("Task title is required.");
  }

  const calendarItemId = await syncCalendarItem(user.id, {
    title,
    description: input.description,
    dueDate,
    syncCalendar: input.syncCalendar,
  });

  await db.insert(kanbanTasks).values({
    columnId: column.id,
    title,
    description: cleanOptionalText(input.description),
    dueDate,
    priority: normalizePriority(input.priority),
    category: normalizeCategory(input.category),
    labels: normalizeLabels(input.labels),
    syncCalendar: input.syncCalendar,
    linkNotes: input.linkNotes,
    calendarItemId,
    position: await nextTaskPosition(column.id),
    updatedAt: new Date().toISOString(),
  });

  await db.update(kanbanBoards).set({ updatedAt: new Date().toISOString() }).where(eq(kanbanBoards.id, board.id));

  revalidatePath("/kanban");
  revalidatePath("/calendar");
  return listKanbanBoards();
}

export async function updateKanbanTask(taskId: number, input: TaskInput) {
  const user = await getCurrentDatabaseUser();
  const { task, board } = await assertTaskAccess(taskId, user);
  const { column } = await assertColumnAccess(input.columnId, user);
  const title = input.title.trim();
  const dueDate = cleanOptionalText(input.dueDate) || todayKey();

  if (!title) {
    throw new Error("Task title is required.");
  }

  const calendarItemId = await syncCalendarItem(user.id, {
    title,
    description: input.description,
    dueDate,
    syncCalendar: input.syncCalendar,
    calendarItemId: task.calendarItemId,
  });

  await db.update(kanbanTasks)
    .set({
      columnId: column.id,
      title,
      description: cleanOptionalText(input.description),
      dueDate,
      priority: normalizePriority(input.priority),
      category: normalizeCategory(input.category),
      labels: normalizeLabels(input.labels),
      syncCalendar: input.syncCalendar,
      linkNotes: input.linkNotes,
      calendarItemId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(kanbanTasks.id, taskId));

  await db.update(kanbanBoards).set({ updatedAt: new Date().toISOString() }).where(eq(kanbanBoards.id, board.id));

  revalidatePath("/kanban");
  revalidatePath("/calendar");
  return listKanbanBoards();
}

export async function deleteKanbanTask(taskId: number) {
  const user = await getCurrentDatabaseUser();
  const { task, board } = await assertTaskAccess(taskId, user);

  await deleteLinkedCalendarItems(task.calendarItemId ? [task.calendarItemId] : [], user.id);
  await db.delete(kanbanTasks).where(eq(kanbanTasks.id, taskId));
  await db.update(kanbanBoards).set({ updatedAt: new Date().toISOString() }).where(eq(kanbanBoards.id, board.id));

  revalidatePath("/kanban");
  revalidatePath("/calendar");
  return listKanbanBoards();
}

export async function moveKanbanTask(taskId: number, targetColumnId: number, targetPosition: number) {
  const user = await getCurrentDatabaseUser();
  const { task, board } = await assertTaskAccess(taskId, user);
  const { column } = await assertColumnAccess(targetColumnId, user);

  const columnTasks = await db.select().from(kanbanTasks)
    .where(eq(kanbanTasks.columnId, column.id))
    .orderBy(kanbanTasks.position, kanbanTasks.id);

  const withoutMoved = columnTasks.filter((nextTask) => nextTask.id !== taskId);
  const boundedPosition = Math.max(0, Math.min(targetPosition, withoutMoved.length));
  const reordered = [
    ...withoutMoved.slice(0, boundedPosition),
    { ...task, columnId: column.id },
    ...withoutMoved.slice(boundedPosition),
  ];

  await db.update(kanbanTasks)
    .set({ columnId: column.id, position: boundedPosition, updatedAt: new Date().toISOString() })
    .where(eq(kanbanTasks.id, taskId));

  await Promise.all(
    reordered.map((nextTask, index) =>
      db.update(kanbanTasks)
        .set({ position: index, updatedAt: new Date().toISOString() })
        .where(eq(kanbanTasks.id, nextTask.id)),
    ),
  );

  await db.update(kanbanBoards).set({ updatedAt: new Date().toISOString() }).where(eq(kanbanBoards.id, board.id));

  revalidatePath("/kanban");
  return listKanbanBoards();
}
