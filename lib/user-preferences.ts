import "server-only";

import { auth, currentUser } from "@clerk/nextjs/server";
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  db,
  userAiUsage,
  userCategories,
  userSettings,
  users,
  kanbanBoards,
  kanbanColumns,
  kanbanTasks,
  notes,
  spaces,
  whiteboards,
  generatedApps,
  calendarItems,
} from "@/db";
import { getLiveblocksUserId, normalizeCollaborationEmail } from "@/lib/liveblocks";

export const categoryScopes = ["calendar", "task", "note", "reminder"] as const;
export type CategoryScope = (typeof categoryScopes)[number];

export const freePlanLimits = {
  boards: 3,
  tasks: 25,
  notes: 10,
  spaces: 2,
  whiteboards: 2,
  aiActionsPerDay: 50,
} as const;

export type UserCategoryDTO = {
  id: number;
  scope: CategoryScope;
  name: string;
  color: string;
  icon: string;
  createdAt: string;
  updatedAt: string;
};

export function isCategoryScope(value: string): value is CategoryScope {
  return categoryScopes.includes(value as CategoryScope);
}

export function cleanCategoryName(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 36);
}

export function cleanHexColor(value: string) {
  const color = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : "#5BAE91";
}

export function cleanIconName(value: string) {
  const icon = value.trim().replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
  return icon || "Tag";
}

export function toCategoryDTO(category: any): UserCategoryDTO {
  return {
    id: category.id,
    scope: isCategoryScope(category.scope) ? category.scope : "calendar",
    name: category.name,
    color: cleanHexColor(category.color),
    icon: cleanIconName(category.icon),
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };
}

export async function getCurrentDatabaseUser() {
  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress;
  const clerkId = user?.id;

  if (!email || !clerkId) {
    throw new Error("You must be signed in.");
  }

  const normalizedEmail = normalizeCollaborationEmail(email);
  const name = user.fullName || user.username || normalizedEmail.split("@")[0] || null;
  const liveblocksId = getLiveblocksUserId(normalizedEmail);

  const result = await db.insert(users)
    .values({ clerkId, email: normalizedEmail, liveblocksId, name })
    .onConflictDoUpdate({
      target: users.clerkId,
      set: { email: normalizedEmail, liveblocksId, name },
    })
    .returning({ id: users.id, email: users.email, name: users.name, clerkId: users.clerkId });

  const data = result[0];
  if (!data) throw new Error("Failed to upsert user.");

  return {
    id: data.id,
    email: data.email,
    name: data.name,
    clerkId: data.clerkId,
  };
}

export async function isCurrentUserPro() {
  const session = await auth();
  if (!session.userId) return false;

  return session.has({ plan: "user:pro" }) || session.has({ plan: "pro" });
}

export async function listUserCategories(scopes: CategoryScope[] = [...categoryScopes]) {
  const user = await getCurrentDatabaseUser();
  const rows = await db.select().from(userCategories)
    .where(and(eq(userCategories.userId, user.id), inArray(userCategories.scope, scopes)));

  return rows
    .map(toCategoryDTO)
    .sort((left, right) => left.scope.localeCompare(right.scope) || left.name.localeCompare(right.name));
}

export async function getUserUsageSnapshot(userId: number) {
  const today = new Date().toISOString().slice(0, 10);

  const boardRows = await db.select({ count: sql<number>`count(*)` }).from(kanbanBoards).where(eq(kanbanBoards.userId, userId));
  const boardCount = Number(boardRows[0]?.count ?? 0);

  const userBoardIds = await db.select({ id: kanbanBoards.id }).from(kanbanBoards).where(eq(kanbanBoards.userId, userId));
  let taskCount = 0;
  if (userBoardIds.length > 0) {
    const columnRows = await db.select({ id: kanbanColumns.id }).from(kanbanColumns)
      .where(inArray(kanbanColumns.boardId, userBoardIds.map((b) => b.id)));
    if (columnRows.length > 0) {
      const taskRows = await db.select({ count: sql<number>`count(*)` }).from(kanbanTasks)
        .where(inArray(kanbanTasks.columnId, columnRows.map((c) => c.id)));
      taskCount = Number(taskRows[0]?.count ?? 0);
    }
  }

  const [noteRows, spaceRows, whiteboardRows, usageRows] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(notes).where(eq(notes.userId, userId)),
    db.select({ count: sql<number>`count(*)` }).from(spaces).where(eq(spaces.userId, userId)),
    db.select({ count: sql<number>`count(*)` }).from(whiteboards).where(eq(whiteboards.userId, userId)),
    db.select({ actionCount: userAiUsage.actionCount }).from(userAiUsage)
      .where(and(eq(userAiUsage.userId, userId), eq(userAiUsage.usageDate, today)))
      .limit(1),
  ]);

  return {
    boards: boardCount,
    tasks: taskCount,
    notes: Number(noteRows[0]?.count ?? 0),
    spaces: Number(spaceRows[0]?.count ?? 0),
    whiteboards: Number(whiteboardRows[0]?.count ?? 0),
    aiActionsToday: usageRows[0]?.actionCount ?? 0,
    aiUsageDate: today,
  };
}

export async function assertFreePlanLimit(kind: keyof Omit<typeof freePlanLimits, "aiActionsPerDay">) {
  if (await isCurrentUserPro()) return;

  const user = await getCurrentDatabaseUser();
  const usage = await getUserUsageSnapshot(user.id);
  const current = usage[kind];
  const limit = freePlanLimits[kind];

  if (current >= limit) {
    throw new Error(`Free plan limit reached: ${limit} ${kind}. Upgrade to Pro for unlimited access.`);
  }
}

export async function assertAiFeatureEnabled(feature: "aiRefineEnabled" | "aiTemplateBuilderEnabled" | "aiDiagramEnabled" | "aiAssistantEnabled") {
  const user = await getCurrentDatabaseUser();
  const rows = await db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1);
  const settings = rows[0];

  if (settings && !settings[feature]) {
    throw new Error("This AI feature is disabled in Settings.");
  }
}

export async function recordAiAction() {
  if (await isCurrentUserPro()) return;

  const user = await getCurrentDatabaseUser();
  const today = new Date().toISOString().slice(0, 10);

  const existing = await db.select({ actionCount: userAiUsage.actionCount })
    .from(userAiUsage)
    .where(and(eq(userAiUsage.userId, user.id), eq(userAiUsage.usageDate, today)))
    .limit(1);

  const newCount = (existing[0]?.actionCount ?? 0) + 1;

  await db.insert(userAiUsage)
    .values({ userId: user.id, usageDate: today, actionCount: newCount, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: [userAiUsage.userId, userAiUsage.usageDate],
      set: { actionCount: newCount, updatedAt: new Date().toISOString() },
    });

  if (newCount > freePlanLimits.aiActionsPerDay) {
    throw new Error(`Free plan limit reached: ${freePlanLimits.aiActionsPerDay} AI actions per day. Upgrade to Pro for unlimited AI.`);
  }
}

export async function exportCurrentUserData() {
  const user = await getCurrentDatabaseUser();

  const [settingsRows, categoriesRows, calendarRows, boardRows, noteRows, spaceRows, whiteboardRows, appRows] = await Promise.all([
    db.select().from(userSettings).where(eq(userSettings.userId, user.id)).limit(1),
    db.select().from(userCategories).where(eq(userCategories.userId, user.id)),
    db.select().from(calendarItems).where(eq(calendarItems.userId, user.id)),
    db.select().from(kanbanBoards).where(eq(kanbanBoards.userId, user.id)),
    db.select().from(notes).where(eq(notes.userId, user.id)),
    db.select().from(spaces).where(eq(spaces.userId, user.id)),
    db.select().from(whiteboards).where(eq(whiteboards.userId, user.id)),
    db.select().from(generatedApps).where(eq(generatedApps.userId, user.id)),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    user: { email: user.email, name: user.name },
    settings: settingsRows[0] ?? null,
    categories: categoriesRows,
    calendar: calendarRows,
    kanbanBoards: boardRows,
    notes: noteRows,
    spaces: spaceRows,
    whiteboards: whiteboardRows,
    generatedApps: appRows,
  };
}
