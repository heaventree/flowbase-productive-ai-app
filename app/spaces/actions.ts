"use server";

import { GoogleGenAI } from "@google/genai";
import { currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";

import {
  db,
  users,
  spaces,
  spaceShares,
  spacePages,
  pageComments,
  pageTaskLinks,
  kanbanBoards,
  kanbanColumns,
  kanbanTasks,
} from "@/db";
import { getAvatarColor, getInitials, getLiveblocksUserId, normalizeCollaborationEmail } from "@/lib/liveblocks";
import { assertAiFeatureEnabled, assertFreePlanLimit, recordAiAction } from "@/lib/user-preferences";

const spaceColors = ["violet", "sky", "sage", "amber", "clay", "rose"] as const;
const pageTemplates = ["Blank Page", "Project Plan", "Meeting Notes", "PRD", "Research Notes", "Task Plan"] as const;
const GEMINI_MODEL = "gemini-3.1-flash-lite";

export type SpaceColor = (typeof spaceColors)[number];
export type PageTemplate = (typeof pageTemplates)[number];
export type RefineAction = "grammar" | "rephrase" | "shorter" | "longer" | "simplify" | "tone";
export type RefineTone = "Friendly" | "Professional" | "Confident" | "Casual";
export type PageContent = Record<string, unknown>;

export type SpaceCollaboratorDTO = {
  id: number | null;
  name: string | null;
  email: string;
  liveblocksId: string;
  role: "owner" | "editor";
  color: string;
  initials: string;
};

export type SpacePageDTO = {
  id: number;
  spaceId: number;
  title: string;
  template: PageTemplate;
  pageType: string;
  description: string | null;
  content: PageContent;
  plainText: string;
  wordCount: number;
  isFavorite: boolean;
  isArchived: boolean;
  commentsCount: number;
  linkedTasksCount: number;
  linkedTaskIds: number[];
  updatedBy: SpaceCollaboratorDTO | null;
  createdAt: string;
  updatedAt: string;
};

export type SpaceDTO = {
  id: number;
  name: string;
  description: string | null;
  color: SpaceColor;
  isFavorite: boolean;
  isArchived: boolean;
  owner: SpaceCollaboratorDTO;
  shares: SpaceCollaboratorDTO[];
  canManage: boolean;
  pages: SpacePageDTO[];
  pageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type LinkedTaskDTO = {
  id: number;
  title: string;
  boardName: string;
};

export type SpacesDataDTO = {
  spaces: SpaceDTO[];
  tasks: LinkedTaskDTO[];
};

export type SpaceInput = {
  name: string;
  description?: string | null;
  color: string;
};

export type PageInput = {
  title: string;
  spaceId: number;
  template: string;
  description?: string | null;
};

export type PageContentInput = {
  content: PageContent;
  plainText: string;
  wordCount: number;
};

const emptyContent: PageContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

function normalizeSpaceColor(value?: string | null): SpaceColor {
  return spaceColors.includes(value as SpaceColor) ? (value as SpaceColor) : "violet";
}

function normalizePageTemplate(value?: string | null): PageTemplate {
  return pageTemplates.includes(value as PageTemplate) ? (value as PageTemplate) : "Blank Page";
}

function cleanTitle(value: string, fallback = "Untitled") {
  const title = value.trim();
  return title || fallback;
}

function cleanOptionalText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 20000) : null;
}

function cleanPlainText(value: string) {
  return value.trim().slice(0, 20000);
}

function countWords(value: string) {
  const words = value.trim().match(/\S+/g);
  return words?.length ?? 0;
}

function pageTypeForTemplate(template: PageTemplate) {
  if (template === "Project Plan") return "Project Plan";
  if (template === "Meeting Notes") return "Notes";
  if (template === "Research Notes") return "Reference";
  if (template === "Task Plan") return "Planning";
  return "Document";
}

function templateContent(title: string, template: PageTemplate): PageContent {
  if (template === "Blank Page") return emptyContent;

  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: title }] },
      {
        type: "paragraph",
        content: [{ type: "text", text: `Start shaping this ${template.toLowerCase()} with context, decisions, and next steps.` }],
      },
    ],
  };
}

function toCollaboratorDTO(input: {
  id: number | null;
  name: string | null;
  email: string;
  role: "owner" | "editor";
  liveblocksId?: string | null;
}): SpaceCollaboratorDTO {
  const email = normalizeCollaborationEmail(input.email);
  const display = input.name || email;

  return {
    id: input.id,
    name: input.name,
    email,
    role: input.role,
    liveblocksId: input.liveblocksId || getLiveblocksUserId(email),
    color: getAvatarColor(email),
    initials: getInitials(display),
  };
}

async function getCurrentDatabaseUser() {
  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress;
  const clerkId = user?.id;

  if (!email || !clerkId) {
    throw new Error("You must be signed in to manage spaces.");
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

  await db.update(spaceShares)
    .set({ acceptedUserId: databaseUser.id, updatedAt: new Date().toISOString() })
    .where(and(eq(spaceShares.email, normalizedEmail), eq(spaceShares.role, "editor")));

  return { id: databaseUser.id, email: normalizedEmail, liveblocksId, name: databaseUser.name };
}

async function assertSpaceOwner(spaceId: number, userId: number) {
  const rows = await db.select().from(spaces).where(and(eq(spaces.id, spaceId), eq(spaces.userId, userId))).limit(1);
  if (!rows[0]) throw new Error("Space not found.");
  return rows[0];
}

async function assertSpaceAccess(spaceId: number, user: Awaited<ReturnType<typeof getCurrentDatabaseUser>>) {
  const spaceRows = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!spaceRows[0]) throw new Error("Space not found.");
  const space = spaceRows[0];

  if (space.userId === user.id) return { space, canManage: true };

  const shareRows = await db.select().from(spaceShares)
    .where(and(eq(spaceShares.spaceId, spaceId), eq(spaceShares.email, user.email), eq(spaceShares.role, "editor")))
    .limit(1);

  if (!shareRows[0]) throw new Error("Space not found.");
  return { space, canManage: false };
}

async function assertPageAccess(pageId: number, user: Awaited<ReturnType<typeof getCurrentDatabaseUser>>) {
  const pageRows = await db.select().from(spacePages).where(eq(spacePages.id, pageId)).limit(1);
  if (!pageRows[0]) throw new Error("Page not found.");
  const page = pageRows[0];
  const access = await assertSpaceAccess(page.spaceId, user);
  return { page, ...access };
}

async function listAccessibleTaskIds(user: Awaited<ReturnType<typeof getCurrentDatabaseUser>>) {
  const boardRows = await db.select({ id: kanbanBoards.id }).from(kanbanBoards).where(eq(kanbanBoards.userId, user.id));
  if (boardRows.length === 0) return [];

  const columnRows = await db.select({ id: kanbanColumns.id }).from(kanbanColumns)
    .where(inArray(kanbanColumns.boardId, boardRows.map((b) => b.id)));
  if (columnRows.length === 0) return [];

  const taskRows = await db.select({ id: kanbanTasks.id }).from(kanbanTasks)
    .where(inArray(kanbanTasks.columnId, columnRows.map((c) => c.id)));

  return Array.from(new Set(taskRows.map((t) => t.id)));
}

async function listLinkedTasks(user: Awaited<ReturnType<typeof getCurrentDatabaseUser>>): Promise<LinkedTaskDTO[]> {
  const boardRows = await db.select({ id: kanbanBoards.id, name: kanbanBoards.name }).from(kanbanBoards)
    .where(eq(kanbanBoards.userId, user.id));
  if (boardRows.length === 0) return [];

  const columnRows = await db.select({ id: kanbanColumns.id, boardId: kanbanColumns.boardId }).from(kanbanColumns)
    .where(inArray(kanbanColumns.boardId, boardRows.map((b) => b.id)));
  if (columnRows.length === 0) return [];

  const taskRows = await db.select({ id: kanbanTasks.id, title: kanbanTasks.title, columnId: kanbanTasks.columnId }).from(kanbanTasks)
    .where(inArray(kanbanTasks.columnId, columnRows.map((c) => c.id)))
    .orderBy(kanbanTasks.title);

  const boardById = new Map(boardRows.map((b) => [b.id, b]));
  const columnById = new Map(columnRows.map((c) => [c.id, c]));

  return taskRows.map((task) => {
    const column = columnById.get(task.columnId);
    const board = column ? boardById.get(column.boardId) : null;
    return { id: task.id, title: task.title, boardName: board?.name ?? "Kanban board" };
  });
}

async function buildSpacesData(user: Awaited<ReturnType<typeof getCurrentDatabaseUser>>): Promise<SpacesDataDTO> {
  const [ownedSpaces, sharedRows] = await Promise.all([
    db.select().from(spaces).where(eq(spaces.userId, user.id)).orderBy(spaces.createdAt, spaces.id),
    db.select().from(spaceShares).where(and(eq(spaceShares.email, user.email), eq(spaceShares.role, "editor"))),
  ]);

  const sharedSpaceIds = sharedRows.map((row) => row.spaceId);
  const sharedSpaces = sharedSpaceIds.length > 0
    ? await db.select().from(spaces).where(inArray(spaces.id, sharedSpaceIds))
    : [];

  const accessibleSpaces = Array.from(
    new Map([...ownedSpaces, ...sharedSpaces].map((space) => [space.id, space])).values(),
  ).sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() || left.id - right.id);

  const tasksResult = await listLinkedTasks(user);

  if (accessibleSpaces.length === 0) {
    return { spaces: [], tasks: tasksResult };
  }

  const spaceIds = accessibleSpaces.map((space) => space.id);
  const ownerIds = Array.from(new Set(accessibleSpaces.map((space) => space.userId)));

  const [owners, shares, pages] = await Promise.all([
    db.select().from(users).where(inArray(users.id, ownerIds)),
    db.select().from(spaceShares).where(inArray(spaceShares.spaceId, spaceIds)).orderBy(spaceShares.createdAt, spaceShares.id),
    db.select().from(spacePages).where(inArray(spacePages.spaceId, spaceIds)).orderBy(spacePages.createdAt, spacePages.id),
  ]);

  const ownerById = new Map(owners.map((owner) => [owner.id, owner]));
  const acceptedUserIds = shares.map((share) => share.acceptedUserId).filter(Boolean) as number[];
  const acceptedUsers = acceptedUserIds.length > 0
    ? await db.select().from(users).where(inArray(users.id, acceptedUserIds))
    : [];
  const acceptedUserById = new Map(acceptedUsers.map((u) => [u.id, u]));

  const sharesBySpace = shares.reduce<Record<number, SpaceCollaboratorDTO[]>>((grouped, share) => {
    const acceptedUser = share.acceptedUserId ? acceptedUserById.get(share.acceptedUserId) : null;
    grouped[share.spaceId] = [
      ...(grouped[share.spaceId] || []),
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

  const pageIds = pages.map((page) => page.id);
  const updaterIds = pages.map((page) => page.updatedByUserId).filter(Boolean) as number[];
  const updaters = updaterIds.length > 0
    ? await db.select().from(users).where(inArray(users.id, updaterIds))
    : [];
  const updaterById = new Map(updaters.map((u) => [u.id, u]));

  const [comments, links] = await Promise.all([
    pageIds.length > 0 ? db.select({ pageId: pageComments.pageId }).from(pageComments).where(inArray(pageComments.pageId, pageIds)) : [],
    pageIds.length > 0 ? db.select({ pageId: pageTaskLinks.pageId, taskId: pageTaskLinks.taskId }).from(pageTaskLinks).where(inArray(pageTaskLinks.pageId, pageIds)) : [],
  ]);

  const commentsByPage = (comments as { pageId: number }[]).reduce<Record<number, number>>((grouped, comment) => {
    grouped[comment.pageId] = (grouped[comment.pageId] || 0) + 1;
    return grouped;
  }, {});
  const linksByPage = (links as { pageId: number; taskId: number }[]).reduce<Record<number, number[]>>((grouped, link) => {
    grouped[link.pageId] = [...(grouped[link.pageId] || []), link.taskId];
    return grouped;
  }, {});

  const pagesBySpace = pages.reduce<Record<number, SpacePageDTO[]>>((grouped, page) => {
    const updater = page.updatedByUserId ? updaterById.get(page.updatedByUserId) : null;
    grouped[page.spaceId] = [
      ...(grouped[page.spaceId] || []),
      {
        id: page.id,
        spaceId: page.spaceId,
        title: page.title,
        template: normalizePageTemplate(page.template),
        pageType: page.pageType,
        description: page.description,
        content: page.content as PageContent,
        plainText: page.plainText,
        wordCount: page.wordCount,
        isFavorite: page.isFavorite,
        isArchived: page.isArchived,
        commentsCount: commentsByPage[page.id] || 0,
        linkedTasksCount: linksByPage[page.id]?.length || 0,
        linkedTaskIds: linksByPage[page.id] || [],
        updatedBy: updater
          ? toCollaboratorDTO({
              id: updater.id,
              name: updater.name,
              email: updater.email,
              liveblocksId: updater.liveblocksId,
              role: "editor",
            })
          : null,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
      },
    ];
    return grouped;
  }, {});

  const data = accessibleSpaces.map<SpaceDTO>((space) => ({
    id: space.id,
    name: space.name,
    description: space.description,
    color: normalizeSpaceColor(space.color),
    isFavorite: space.isFavorite,
    isArchived: space.isArchived,
    owner: toCollaboratorDTO({
      id: space.userId,
      name: ownerById.get(space.userId)?.name ?? null,
      email: ownerById.get(space.userId)?.email ?? user.email,
      liveblocksId: ownerById.get(space.userId)?.liveblocksId,
      role: "owner",
    }),
    shares: sharesBySpace[space.id] || [],
    canManage: space.userId === user.id,
    pages: pagesBySpace[space.id] || [],
    pageCount: (pagesBySpace[space.id] || []).filter((page) => !page.isArchived).length,
    createdAt: space.createdAt,
    updatedAt: space.updatedAt,
  }));

  return { spaces: data, tasks: tasksResult };
}

export async function listSpacesData() {
  const user = await getCurrentDatabaseUser();
  return buildSpacesData(user);
}

export async function createSpace(input: SpaceInput) {
  await assertFreePlanLimit("spaces");
  const user = await getCurrentDatabaseUser();
  const name = cleanTitle(input.name, "Untitled Space");

  await db.insert(spaces).values({
    userId: user.id,
    name,
    description: cleanOptionalText(input.description),
    color: normalizeSpaceColor(input.color),
    updatedAt: new Date().toISOString(),
  });

  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function updateSpace(spaceId: number, input: Partial<SpaceInput> & { isFavorite?: boolean; isArchived?: boolean }) {
  const user = await getCurrentDatabaseUser();
  const space = await assertSpaceOwner(spaceId, user.id);

  await db.update(spaces)
    .set({
      name: typeof input.name === "string" ? cleanTitle(input.name, "Untitled Space") : space.name,
      description: typeof input.description !== "undefined" ? cleanOptionalText(input.description) : space.description,
      color: typeof input.color === "string" ? normalizeSpaceColor(input.color) : normalizeSpaceColor(space.color),
      isFavorite: typeof input.isFavorite === "boolean" ? input.isFavorite : space.isFavorite,
      isArchived: typeof input.isArchived === "boolean" ? input.isArchived : space.isArchived,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(spaces.id, spaceId), eq(spaces.userId, user.id)));

  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function deleteSpace(spaceId: number) {
  const user = await getCurrentDatabaseUser();
  await assertSpaceOwner(spaceId, user.id);
  await db.delete(spaces).where(and(eq(spaces.id, spaceId), eq(spaces.userId, user.id)));
  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function duplicateSpace(spaceId: number) {
  const user = await getCurrentDatabaseUser();
  const { space } = await assertSpaceAccess(spaceId, user);
  const pages = await db.select().from(spacePages).where(eq(spacePages.spaceId, space.id));
  const now = new Date().toISOString();

  const copyResult = await db.insert(spaces)
    .values({
      userId: user.id,
      name: `${space.name} copy`,
      description: space.description,
      color: normalizeSpaceColor(space.color),
      updatedAt: now,
    })
    .returning({ id: spaces.id });

  if (!copyResult[0]) throw new Error("Failed to duplicate space.");
  const copyId = copyResult[0].id;

  if (pages.length > 0) {
    await db.insert(spacePages).values(
      pages.map((page) => ({
        spaceId: copyId,
        title: page.title,
        template: page.template,
        pageType: page.pageType,
        description: page.description,
        content: page.content as Record<string, unknown>,
        plainText: page.plainText,
        wordCount: page.wordCount,
        updatedByUserId: user.id,
        updatedAt: now,
      })),
    );
  }

  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function inviteSpaceCollaborator(input: { spaceId: number; email: string }) {
  const user = await getCurrentDatabaseUser();
  const space = await assertSpaceOwner(input.spaceId, user.id);
  const email = normalizeCollaborationEmail(input.email);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid collaborator email.");
  if (email === user.email) throw new Error("You already own this space.");

  const acceptedUserRows = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

  await db.insert(spaceShares)
    .values({
      spaceId: space.id,
      email,
      role: "editor",
      invitedByUserId: user.id,
      acceptedUserId: acceptedUserRows[0]?.id ?? null,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [spaceShares.spaceId, spaceShares.email],
      set: { role: "editor", invitedByUserId: user.id, acceptedUserId: acceptedUserRows[0]?.id ?? null, updatedAt: new Date().toISOString() },
    });

  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function createPage(input: PageInput) {
  const user = await getCurrentDatabaseUser();
  await assertSpaceAccess(input.spaceId, user);
  const template = normalizePageTemplate(input.template);
  const title = cleanTitle(input.title, "Untitled Page");
  const now = new Date().toISOString();

  await db.insert(spacePages).values({
    spaceId: input.spaceId,
    title,
    template,
    pageType: pageTypeForTemplate(template),
    description: cleanOptionalText(input.description),
    content: templateContent(title, template),
    plainText: "",
    wordCount: 0,
    updatedByUserId: user.id,
    updatedAt: now,
  });

  await db.update(spaces).set({ updatedAt: now }).where(eq(spaces.id, input.spaceId));

  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function updatePage(pageId: number, input: Partial<PageInput> & { isFavorite?: boolean; isArchived?: boolean }) {
  const user = await getCurrentDatabaseUser();
  const { page } = await assertPageAccess(pageId, user);
  const template = typeof input.template === "string" ? normalizePageTemplate(input.template) : normalizePageTemplate(page.template);
  const nextSpaceId = typeof input.spaceId === "number" ? input.spaceId : page.spaceId;

  if (nextSpaceId !== page.spaceId) {
    await assertSpaceAccess(nextSpaceId, user);
  }

  const now = new Date().toISOString();
  await db.update(spacePages)
    .set({
      spaceId: nextSpaceId,
      title: typeof input.title === "string" ? cleanTitle(input.title, "Untitled Page") : page.title,
      template,
      pageType: pageTypeForTemplate(template),
      description: typeof input.description !== "undefined" ? cleanOptionalText(input.description) : page.description,
      isFavorite: typeof input.isFavorite === "boolean" ? input.isFavorite : page.isFavorite,
      isArchived: typeof input.isArchived === "boolean" ? input.isArchived : page.isArchived,
      updatedByUserId: user.id,
      updatedAt: now,
    })
    .where(eq(spacePages.id, pageId));

  const spaceIdsToTouch = Array.from(new Set([page.spaceId, nextSpaceId]));
  await Promise.all(spaceIdsToTouch.map((id) => db.update(spaces).set({ updatedAt: now }).where(eq(spaces.id, id))));

  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function updatePageContent(pageId: number, input: PageContentInput) {
  const user = await getCurrentDatabaseUser();
  const { page } = await assertPageAccess(pageId, user);
  const plainText = cleanPlainText(input.plainText);
  const now = new Date().toISOString();

  await db.update(spacePages)
    .set({
      content: input.content,
      plainText,
      wordCount: Math.max(0, Number.isFinite(input.wordCount) ? input.wordCount : countWords(plainText)),
      updatedByUserId: user.id,
      updatedAt: now,
    })
    .where(and(eq(spacePages.id, pageId), eq(spacePages.isArchived, false)));

  await db.update(spaces).set({ updatedAt: now }).where(eq(spaces.id, page.spaceId));

  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function duplicatePage(pageId: number) {
  const user = await getCurrentDatabaseUser();
  const { page } = await assertPageAccess(pageId, user);
  const now = new Date().toISOString();

  await db.insert(spacePages).values({
    spaceId: page.spaceId,
    title: `${page.title} copy`,
    template: page.template,
    pageType: page.pageType,
    description: page.description,
    content: page.content as Record<string, unknown>,
    plainText: page.plainText,
    wordCount: page.wordCount,
    updatedByUserId: user.id,
    updatedAt: now,
  });

  await db.update(spaces).set({ updatedAt: now }).where(eq(spaces.id, page.spaceId));

  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function deletePage(pageId: number) {
  const user = await getCurrentDatabaseUser();
  const { page } = await assertPageAccess(pageId, user);
  await db.delete(spacePages).where(eq(spacePages.id, pageId));
  await db.update(spaces).set({ updatedAt: new Date().toISOString() }).where(eq(spaces.id, page.spaceId));
  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function updatePageTaskLinks(pageId: number, taskIds: number[]) {
  const user = await getCurrentDatabaseUser();
  await assertPageAccess(pageId, user);
  const allowedTaskIds = await listAccessibleTaskIds(user);
  const cleanIds = Array.from(new Set(taskIds.filter((id) => allowedTaskIds.includes(id)))).slice(0, 20);

  await db.delete(pageTaskLinks).where(eq(pageTaskLinks.pageId, pageId));
  if (cleanIds.length > 0) {
    await db.insert(pageTaskLinks).values(cleanIds.map((taskId) => ({ pageId, taskId })));
  }

  revalidatePath("/spaces");
  return buildSpacesData(user);
}

function getRefineInstruction(action: RefineAction, tone?: RefineTone) {
  if (action === "grammar") return "Improve grammar and clarity without changing the meaning.";
  if (action === "rephrase") return "Rephrase the text while preserving the meaning.";
  if (action === "shorter") return "Make the text shorter while preserving the essential meaning.";
  if (action === "longer") return "Make the text more complete and expressive without adding unsupported facts.";
  if (action === "simplify") return "Simplify the language for easier reading.";
  return `Change the tone to ${tone || "Friendly"} while preserving the meaning.`;
}

export async function refineSelectedPageText(input: { text: string; action: RefineAction; tone?: RefineTone }) {
  await assertAiFeatureEnabled("aiRefineEnabled");
  await recordAiAction();
  await getCurrentDatabaseUser();
  const selectedText = input.text.trim();

  if (!selectedText) throw new Error("Select text to refine first.");

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini is not configured. Add GEMINI_API_KEY to enable AI Refine.");

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      "You refine selected workspace page text. Return only the replacement text, with no markdown fences, labels, or commentary.",
      `Instruction: ${getRefineInstruction(input.action, input.tone)}`,
      `Selected text:\n${selectedText}`,
    ].join("\n\n"),
  });
  const refinedText = response.text?.trim();

  if (!refinedText) throw new Error("Gemini did not return refined text.");
  return refinedText;
}
