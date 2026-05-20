"use server";

import { currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

import { supabase } from "@/db";
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
    columnId: task.column_id,
    title: task.title,
    description: task.description,
    dueDate: task.due_date,
    priority: normalizePriority(task.priority),
    category: normalizeCategory(task.category),
    labels: normalizeLabels(task.labels ?? []),
    syncCalendar: task.sync_calendar,
    linkNotes: task.link_notes,
    calendarItemId: task.calendar_item_id,
    position: task.position,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
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

  const { data: databaseUser, error } = await supabase
    .from("users")
    .upsert(
      { clerk_id: clerkId, email: normalizedEmail, liveblocks_id: liveblocksId, name },
      { onConflict: "clerk_id" },
    )
    .select("id, email, liveblocks_id, name")
    .single();

  if (error) throw new Error(error.message);

  await supabase
    .from("kanban_board_shares")
    .update({ accepted_user_id: databaseUser.id, updated_at: new Date().toISOString() })
    .eq("email", normalizedEmail)
    .eq("role", "editor");

  return {
    id: databaseUser.id,
    email: normalizedEmail,
    liveblocksId,
    name: databaseUser.name,
  };
}

async function assertBoardOwner(boardId: number, userId: number) {
  const { data: board } = await supabase
    .from("kanban_boards")
    .select("*")
    .eq("id", boardId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!board) {
    throw new Error("Kanban board not found.");
  }

  return board;
}

async function assertBoardAccess(boardId: number, user: Awaited<ReturnType<typeof getCurrentDatabaseUser>>) {
  const { data: ownedBoard } = await supabase
    .from("kanban_boards")
    .select("*")
    .eq("id", boardId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (ownedBoard) {
    return { board: ownedBoard, canManage: true };
  }

  const { data: shareRow } = await supabase
    .from("kanban_board_shares")
    .select("*, kanban_boards!inner(*)")
    .eq("board_id", boardId)
    .eq("email", user.email)
    .eq("role", "editor")
    .maybeSingle();

  if (!shareRow) {
    throw new Error("Kanban board not found.");
  }

  return { board: (shareRow as any).kanban_boards, canManage: false };
}

async function assertColumnAccess(columnId: number, user: Awaited<ReturnType<typeof getCurrentDatabaseUser>>) {
  const { data: record } = await supabase
    .from("kanban_columns")
    .select("*, kanban_boards!inner(*)")
    .eq("id", columnId)
    .maybeSingle();

  if (!record) {
    throw new Error("Kanban column not found.");
  }

  const board = (record as any).kanban_boards;
  await assertBoardAccess(board.id, user);
  return { column: record, board };
}

async function assertTaskAccess(taskId: number, user: Awaited<ReturnType<typeof getCurrentDatabaseUser>>) {
  const { data: record } = await supabase
    .from("kanban_tasks")
    .select("*, kanban_columns!inner(*, kanban_boards!inner(*))")
    .eq("id", taskId)
    .maybeSingle();

  if (!record) {
    throw new Error("Kanban task not found.");
  }

  const column = (record as any).kanban_columns;
  const board = column.kanban_boards;
  await assertBoardAccess(board.id, user);
  return { task: record, column, board };
}

async function upsertLiveblocksRoom(boardId: number) {
  const { data: board } = await supabase.from("kanban_boards").select("*").eq("id", boardId).maybeSingle();
  if (!board) return;

  const { data: owner } = await supabase.from("users").select("*").eq("id", board.user_id).maybeSingle();
  if (!owner) return;

  const { data: shares } = await supabase.from("kanban_board_shares").select("*").eq("board_id", boardId);
  const usersAccesses = [owner.email, ...(shares ?? []).map((share: any) => share.email)].reduce<Record<string, ["room:write"]>>((accesses, email) => {
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
  const { data: columns } = await supabase
    .from("kanban_columns")
    .select("id")
    .eq("board_id", boardId);
  return (columns ?? []).length;
}

async function nextTaskPosition(columnId: number) {
  const { data: tasks } = await supabase
    .from("kanban_tasks")
    .select("id")
    .eq("column_id", columnId);
  return (tasks ?? []).length;
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
      await supabase
        .from("calendar_items")
        .delete()
        .eq("id", input.calendarItemId)
        .eq("user_id", userId);
    }
    return null;
  }

  const itemValues = {
    title: input.title,
    description: cleanOptionalText(input.description),
    item_type: "task",
    category: "work",
    scheduled_date: input.dueDate,
    scheduled_time: null,
    is_draft: false,
    updated_at: new Date().toISOString(),
  };

  if (input.calendarItemId) {
    const { data: item } = await supabase
      .from("calendar_items")
      .update(itemValues)
      .eq("id", input.calendarItemId)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle();

    if (item) return item.id;
  }

  const { data: item } = await supabase
    .from("calendar_items")
    .insert({ user_id: userId, ...itemValues })
    .select("id")
    .single();

  return item?.id ?? null;
}

async function deleteLinkedCalendarItems(calendarItemIds: number[], userId: number) {
  if (calendarItemIds.length === 0) return;

  await supabase
    .from("calendar_items")
    .delete()
    .in("id", calendarItemIds)
    .eq("user_id", userId);
}

export async function listKanbanBoards() {
  const user = await getCurrentDatabaseUser();

  const { data: ownedBoards } = await supabase
    .from("kanban_boards")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at")
    .order("id");

  const { data: sharedRows } = await supabase
    .from("kanban_board_shares")
    .select("*, kanban_boards!inner(*)")
    .eq("email", user.email)
    .eq("role", "editor");

  const boardsById = new Map(
    [...(ownedBoards ?? []), ...(sharedRows ?? []).map((row: any) => row.kanban_boards)].map((board) => [board.id, board]),
  );
  const boards = Array.from(boardsById.values()).sort((left, right) => {
    const leftTime = new Date(left.created_at).getTime();
    const rightTime = new Date(right.created_at).getTime();
    return leftTime - rightTime || left.id - right.id;
  });

  if (boards.length === 0) return [];

  const boardIds = boards.map((board) => board.id);
  const ownerIds = Array.from(new Set(boards.map((board) => board.user_id)));

  const [
    { data: owners },
    { data: shares },
    { data: columns },
  ] = await Promise.all([
    supabase.from("users").select("*").in("id", ownerIds),
    supabase.from("kanban_board_shares").select("*").in("board_id", boardIds).order("created_at").order("id"),
    supabase.from("kanban_columns").select("*").in("board_id", boardIds).order("position").order("id"),
  ]);

  const ownerById = new Map((owners ?? []).map((owner: any) => [owner.id, owner]));
  const acceptedUserIds = (shares ?? []).map((share: any) => share.accepted_user_id).filter(Boolean);
  const { data: acceptedUsers } = acceptedUserIds.length > 0
    ? await supabase.from("users").select("*").in("id", acceptedUserIds)
    : { data: [] };
  const acceptedUserById = new Map((acceptedUsers ?? []).map((u: any) => [u.id, u]));

  const sharesByBoard = (shares ?? []).reduce<Record<number, KanbanCollaboratorDTO[]>>((grouped, share: any) => {
    const acceptedUser = share.accepted_user_id ? acceptedUserById.get(share.accepted_user_id) : null;
    grouped[share.board_id] = [
      ...(grouped[share.board_id] || []),
      toCollaboratorDTO({
        id: (acceptedUser as any)?.id ?? null,
        name: (acceptedUser as any)?.name ?? null,
        email: share.email,
        liveblocksId: (acceptedUser as any)?.liveblocks_id,
        role: "editor",
      }),
    ];
    return grouped;
  }, {});

  const columnIds = (columns ?? []).map((column: any) => column.id);
  const { data: tasks } = columnIds.length > 0
    ? await supabase.from("kanban_tasks").select("*").in("column_id", columnIds).order("position").order("id")
    : { data: [] };

  const tasksByColumn = (tasks ?? []).reduce<Record<number, KanbanTaskDTO[]>>((grouped, task: any) => {
    grouped[task.column_id] = [...(grouped[task.column_id] || []), toTaskDTO(task)];
    return grouped;
  }, {});

  const columnsByBoard = (columns ?? []).reduce<Record<number, KanbanColumnDTO[]>>((grouped, column: any) => {
    grouped[column.board_id] = [
      ...(grouped[column.board_id] || []),
      {
        id: column.id,
        boardId: column.board_id,
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
      id: board.user_id,
      name: (ownerById.get(board.user_id) as any)?.name ?? null,
      email: (ownerById.get(board.user_id) as any)?.email ?? user.email,
      liveblocksId: (ownerById.get(board.user_id) as any)?.liveblocks_id,
      role: "owner",
    }),
    shares: sharesByBoard[board.id] || [],
    canManage: board.user_id === user.id,
    createdAt: board.created_at,
    updatedAt: board.updated_at,
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

  const { data: board, error } = await supabase
    .from("kanban_boards")
    .insert({ user_id: user.id, name, color: normalizeBoardColor(input.color), updated_at: new Date().toISOString() })
    .select()
    .single();

  if (error) throw new Error(error.message);

  await supabase
    .from("kanban_columns")
    .insert(defaultColumns.map((columnName, index) => ({ board_id: board.id, name: columnName, position: index })));

  await upsertLiveblocksRoom(board.id);

  revalidatePath("/kanban");
  return (await listKanbanBoards()).find((nextBoard) => nextBoard.id === board.id)!;
}

export async function updateKanbanBoard(boardId: number, input: BoardInput) {
  const user = await getCurrentDatabaseUser();
  await assertBoardOwner(boardId, user.id);
  const name = input.name.trim();

  if (!name) {
    throw new Error("Board name is required.");
  }

  await supabase
    .from("kanban_boards")
    .update({ name, color: normalizeBoardColor(input.color), updated_at: new Date().toISOString() })
    .eq("id", boardId)
    .eq("user_id", user.id);

  revalidatePath("/kanban");
  return listKanbanBoards();
}

export async function deleteKanbanBoard(boardId: number) {
  const user = await getCurrentDatabaseUser();
  await assertBoardOwner(boardId, user.id);

  const { data: columns } = await supabase.from("kanban_columns").select("id").eq("board_id", boardId);
  const columnIds = (columns ?? []).map((c: any) => c.id);

  const { data: tasks } = columnIds.length > 0
    ? await supabase.from("kanban_tasks").select("calendar_item_id").in("column_id", columnIds)
    : { data: [] };

  const calendarItemIds = (tasks ?? []).map((t: any) => t.calendar_item_id).filter(Boolean);
  await deleteLinkedCalendarItems(calendarItemIds, user.id);

  await supabase.from("kanban_boards").delete().eq("id", boardId).eq("user_id", user.id);

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

  const { data: acceptedUser } = await supabase.from("users").select("id").eq("email", email).maybeSingle();

  await supabase
    .from("kanban_board_shares")
    .upsert(
      {
        board_id: board.id,
        email,
        role: "editor",
        invited_by_user_id: user.id,
        accepted_user_id: (acceptedUser as any)?.id ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "board_id,email" },
    );

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

  await supabase.from("kanban_columns").insert({ board_id: input.boardId, name, position, updated_at: new Date().toISOString() });
  await supabase.from("kanban_boards").update({ updated_at: new Date().toISOString() }).eq("id", input.boardId);

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

  await supabase.from("kanban_columns").update({ name: nextName, updated_at: new Date().toISOString() }).eq("id", columnId);
  await supabase.from("kanban_boards").update({ updated_at: new Date().toISOString() }).eq("id", (column as any).board_id);

  revalidatePath("/kanban");
  return listKanbanBoards();
}

export async function deleteKanbanColumn(columnId: number) {
  const user = await getCurrentDatabaseUser();
  const { column } = await assertColumnAccess(columnId, user);

  const { data: tasks } = await supabase.from("kanban_tasks").select("calendar_item_id").eq("column_id", columnId);
  const calendarItemIds = (tasks ?? []).map((t: any) => t.calendar_item_id).filter(Boolean);

  await deleteLinkedCalendarItems(calendarItemIds, user.id);
  await supabase.from("kanban_columns").delete().eq("id", columnId);
  await supabase.from("kanban_boards").update({ updated_at: new Date().toISOString() }).eq("id", (column as any).board_id);

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

  await supabase.from("kanban_tasks").insert({
    column_id: (column as any).id,
    title,
    description: cleanOptionalText(input.description),
    due_date: dueDate,
    priority: normalizePriority(input.priority),
    category: normalizeCategory(input.category),
    labels: normalizeLabels(input.labels),
    sync_calendar: input.syncCalendar,
    link_notes: input.linkNotes,
    calendar_item_id: calendarItemId,
    position: await nextTaskPosition((column as any).id),
    updated_at: new Date().toISOString(),
  });

  await supabase.from("kanban_boards").update({ updated_at: new Date().toISOString() }).eq("id", (board as any).id);

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
    calendarItemId: (task as any).calendar_item_id,
  });

  await supabase
    .from("kanban_tasks")
    .update({
      column_id: (column as any).id,
      title,
      description: cleanOptionalText(input.description),
      due_date: dueDate,
      priority: normalizePriority(input.priority),
      category: normalizeCategory(input.category),
      labels: normalizeLabels(input.labels),
      sync_calendar: input.syncCalendar,
      link_notes: input.linkNotes,
      calendar_item_id: calendarItemId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", taskId);

  await supabase.from("kanban_boards").update({ updated_at: new Date().toISOString() }).eq("id", (board as any).id);

  revalidatePath("/kanban");
  revalidatePath("/calendar");
  return listKanbanBoards();
}

export async function deleteKanbanTask(taskId: number) {
  const user = await getCurrentDatabaseUser();
  const { task, board } = await assertTaskAccess(taskId, user);

  await deleteLinkedCalendarItems((task as any).calendar_item_id ? [(task as any).calendar_item_id] : [], user.id);
  await supabase.from("kanban_tasks").delete().eq("id", taskId);
  await supabase.from("kanban_boards").update({ updated_at: new Date().toISOString() }).eq("id", (board as any).id);

  revalidatePath("/kanban");
  revalidatePath("/calendar");
  return listKanbanBoards();
}

export async function moveKanbanTask(taskId: number, targetColumnId: number, targetPosition: number) {
  const user = await getCurrentDatabaseUser();
  const { task, board } = await assertTaskAccess(taskId, user);
  const { column } = await assertColumnAccess(targetColumnId, user);

  const { data: columnTasks } = await supabase
    .from("kanban_tasks")
    .select("*")
    .eq("column_id", (column as any).id)
    .order("position")
    .order("id");

  const tasks = columnTasks ?? [];
  const withoutMoved = tasks.filter((nextTask: any) => nextTask.id !== taskId);
  const boundedPosition = Math.max(0, Math.min(targetPosition, withoutMoved.length));
  const reordered = [
    ...withoutMoved.slice(0, boundedPosition),
    { ...(task as any), column_id: (column as any).id },
    ...withoutMoved.slice(boundedPosition),
  ];

  await supabase
    .from("kanban_tasks")
    .update({ column_id: (column as any).id, position: boundedPosition, updated_at: new Date().toISOString() })
    .eq("id", taskId);

  await Promise.all(
    reordered.map((nextTask: any, index) =>
      supabase
        .from("kanban_tasks")
        .update({ position: index, updated_at: new Date().toISOString() })
        .eq("id", nextTask.id),
    ),
  );

  await supabase.from("kanban_boards").update({ updated_at: new Date().toISOString() }).eq("id", (board as any).id);

  revalidatePath("/kanban");
  return listKanbanBoards();
}
