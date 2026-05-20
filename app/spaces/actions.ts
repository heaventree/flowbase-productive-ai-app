"use server";

import { GoogleGenAI } from "@google/genai";
import { currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

import { supabase } from "@/db";
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
    .from("space_shares")
    .update({ accepted_user_id: databaseUser.id, updated_at: new Date().toISOString() })
    .eq("email", normalizedEmail)
    .eq("role", "editor");

  return { id: databaseUser.id, email: normalizedEmail, liveblocksId, name: databaseUser.name };
}

async function assertSpaceOwner(spaceId: number, userId: number) {
  const { data: space } = await supabase.from("spaces").select("*").eq("id", spaceId).eq("user_id", userId).maybeSingle();
  if (!space) throw new Error("Space not found.");
  return space;
}

async function assertSpaceAccess(spaceId: number, user: Awaited<ReturnType<typeof getCurrentDatabaseUser>>) {
  const { data: space } = await supabase.from("spaces").select("*").eq("id", spaceId).maybeSingle();
  if (!space) throw new Error("Space not found.");
  if (space.user_id === user.id) return { space, canManage: true };

  const { data: share } = await supabase
    .from("space_shares")
    .select("*")
    .eq("space_id", spaceId)
    .eq("email", user.email)
    .eq("role", "editor")
    .maybeSingle();

  if (!share) throw new Error("Space not found.");
  return { space, canManage: false };
}

async function assertPageAccess(pageId: number, user: Awaited<ReturnType<typeof getCurrentDatabaseUser>>) {
  const { data: page } = await supabase.from("space_pages").select("*").eq("id", pageId).maybeSingle();
  if (!page) throw new Error("Page not found.");
  const access = await assertSpaceAccess(page.space_id, user);
  return { page, ...access };
}

async function listAccessibleTaskIds(user: Awaited<ReturnType<typeof getCurrentDatabaseUser>>) {
  const { data: rows } = await supabase
    .from("kanban_tasks")
    .select("id, kanban_columns!inner(kanban_boards!inner(user_id))")
    .eq("kanban_columns.kanban_boards.user_id", user.id);

  return Array.from(new Set((rows ?? []).map((row: any) => row.id)));
}

async function buildSpacesData(user: Awaited<ReturnType<typeof getCurrentDatabaseUser>>): Promise<SpacesDataDTO> {
  const [{ data: ownedSpaces }, { data: sharedRows }] = await Promise.all([
    supabase.from("spaces").select("*").eq("user_id", user.id).order("created_at").order("id"),
    supabase
      .from("space_shares")
      .select("*, spaces!inner(*)")
      .eq("email", user.email)
      .eq("role", "editor"),
  ]);

  const accessibleSpaces = Array.from(
    new Map(
      [...(ownedSpaces ?? []), ...(sharedRows ?? []).map((row: any) => row.spaces)].map((space) => [space.id, space]),
    ).values(),
  ).sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime() || left.id - right.id);

  const tasksResult = await listLinkedTasks(user);

  if (accessibleSpaces.length === 0) {
    return { spaces: [], tasks: tasksResult };
  }

  const spaceIds = accessibleSpaces.map((space) => space.id);
  const ownerIds = Array.from(new Set(accessibleSpaces.map((space) => space.user_id)));

  const [
    { data: owners },
    { data: shares },
    { data: pages },
  ] = await Promise.all([
    supabase.from("users").select("*").in("id", ownerIds),
    supabase.from("space_shares").select("*").in("space_id", spaceIds).order("created_at").order("id"),
    supabase.from("space_pages").select("*").in("space_id", spaceIds).order("created_at").order("id"),
  ]);

  const ownerById = new Map((owners ?? []).map((owner: any) => [owner.id, owner]));
  const acceptedUserIds = (shares ?? []).map((share: any) => share.accepted_user_id).filter(Boolean);
  const { data: acceptedUsers } = acceptedUserIds.length > 0
    ? await supabase.from("users").select("*").in("id", acceptedUserIds)
    : { data: [] };
  const acceptedUserById = new Map((acceptedUsers ?? []).map((u: any) => [u.id, u]));

  const sharesBySpace = (shares ?? []).reduce<Record<number, SpaceCollaboratorDTO[]>>((grouped, share: any) => {
    const acceptedUser = share.accepted_user_id ? acceptedUserById.get(share.accepted_user_id) : null;
    grouped[share.space_id] = [
      ...(grouped[share.space_id] || []),
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

  const pageIds = (pages ?? []).map((page: any) => page.id);
  const updaterIds = (pages ?? []).map((page: any) => page.updated_by_user_id).filter(Boolean);
  const { data: updaters } = updaterIds.length > 0
    ? await supabase.from("users").select("*").in("id", updaterIds)
    : { data: [] };
  const updaterById = new Map((updaters ?? []).map((u: any) => [u.id, u]));

  const [{ data: comments }, { data: links }] = await Promise.all([
    pageIds.length > 0
      ? supabase.from("page_comments").select("page_id").in("page_id", pageIds)
      : Promise.resolve({ data: [] }),
    pageIds.length > 0
      ? supabase.from("page_task_links").select("page_id, task_id").in("page_id", pageIds)
      : Promise.resolve({ data: [] }),
  ]);

  const commentsByPage = (comments ?? []).reduce<Record<number, number>>((grouped, comment: any) => {
    grouped[comment.page_id] = (grouped[comment.page_id] || 0) + 1;
    return grouped;
  }, {});
  const linksByPage = (links ?? []).reduce<Record<number, number[]>>((grouped, link: any) => {
    grouped[link.page_id] = [...(grouped[link.page_id] || []), link.task_id];
    return grouped;
  }, {});

  const pagesBySpace = (pages ?? []).reduce<Record<number, SpacePageDTO[]>>((grouped, page: any) => {
    const updater = page.updated_by_user_id ? updaterById.get(page.updated_by_user_id) : null;
    grouped[page.space_id] = [
      ...(grouped[page.space_id] || []),
      {
        id: page.id,
        spaceId: page.space_id,
        title: page.title,
        template: normalizePageTemplate(page.template),
        pageType: page.page_type,
        description: page.description,
        content: page.content,
        plainText: page.plain_text,
        wordCount: page.word_count,
        isFavorite: page.is_favorite,
        isArchived: page.is_archived,
        commentsCount: commentsByPage[page.id] || 0,
        linkedTasksCount: linksByPage[page.id]?.length || 0,
        linkedTaskIds: linksByPage[page.id] || [],
        updatedBy: updater
          ? toCollaboratorDTO({
              id: (updater as any).id,
              name: (updater as any).name,
              email: (updater as any).email,
              liveblocksId: (updater as any).liveblocks_id,
              role: "editor",
            })
          : null,
        createdAt: page.created_at,
        updatedAt: page.updated_at,
      },
    ];
    return grouped;
  }, {});

  const data = accessibleSpaces.map<SpaceDTO>((space) => ({
    id: space.id,
    name: space.name,
    description: space.description,
    color: normalizeSpaceColor(space.color),
    isFavorite: space.is_favorite,
    isArchived: space.is_archived,
    owner: toCollaboratorDTO({
      id: space.user_id,
      name: (ownerById.get(space.user_id) as any)?.name ?? null,
      email: (ownerById.get(space.user_id) as any)?.email ?? user.email,
      liveblocksId: (ownerById.get(space.user_id) as any)?.liveblocks_id,
      role: "owner",
    }),
    shares: sharesBySpace[space.id] || [],
    canManage: space.user_id === user.id,
    pages: pagesBySpace[space.id] || [],
    pageCount: (pagesBySpace[space.id] || []).filter((page) => !page.isArchived).length,
    createdAt: space.created_at,
    updatedAt: space.updated_at,
  }));

  return { spaces: data, tasks: tasksResult };
}

async function listLinkedTasks(user: Awaited<ReturnType<typeof getCurrentDatabaseUser>>) {
  const { data: rows } = await supabase
    .from("kanban_tasks")
    .select("id, title, kanban_columns!inner(kanban_boards!inner(name, user_id))")
    .eq("kanban_columns.kanban_boards.user_id", user.id)
    .order("title");

  return (rows ?? []).map((row: any) => ({
    id: row.id,
    title: row.title,
    boardName: row.kanban_columns?.kanban_boards?.name ?? "Kanban board",
  }));
}

export async function listSpacesData() {
  const user = await getCurrentDatabaseUser();
  return buildSpacesData(user);
}

export async function createSpace(input: SpaceInput) {
  await assertFreePlanLimit("spaces");
  const user = await getCurrentDatabaseUser();
  const name = cleanTitle(input.name, "Untitled Space");

  await supabase.from("spaces").insert({
    user_id: user.id,
    name,
    description: cleanOptionalText(input.description),
    color: normalizeSpaceColor(input.color),
    updated_at: new Date().toISOString(),
  });

  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function updateSpace(spaceId: number, input: Partial<SpaceInput> & { isFavorite?: boolean; isArchived?: boolean }) {
  const user = await getCurrentDatabaseUser();
  const space = await assertSpaceOwner(spaceId, user.id);

  await supabase
    .from("spaces")
    .update({
      name: typeof input.name === "string" ? cleanTitle(input.name, "Untitled Space") : space.name,
      description: typeof input.description !== "undefined" ? cleanOptionalText(input.description) : space.description,
      color: typeof input.color === "string" ? normalizeSpaceColor(input.color) : normalizeSpaceColor(space.color),
      is_favorite: typeof input.isFavorite === "boolean" ? input.isFavorite : space.is_favorite,
      is_archived: typeof input.isArchived === "boolean" ? input.isArchived : space.is_archived,
      updated_at: new Date().toISOString(),
    })
    .eq("id", spaceId)
    .eq("user_id", user.id);

  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function deleteSpace(spaceId: number) {
  const user = await getCurrentDatabaseUser();
  await assertSpaceOwner(spaceId, user.id);
  await supabase.from("spaces").delete().eq("id", spaceId).eq("user_id", user.id);
  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function duplicateSpace(spaceId: number) {
  const user = await getCurrentDatabaseUser();
  const { space } = await assertSpaceAccess(spaceId, user);
  const { data: pages } = await supabase.from("space_pages").select("*").eq("space_id", space.id);
  const now = new Date().toISOString();

  const { data: copy, error } = await supabase
    .from("spaces")
    .insert({
      user_id: user.id,
      name: `${space.name} copy`,
      description: space.description,
      color: normalizeSpaceColor(space.color),
      updated_at: now,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  if ((pages ?? []).length > 0) {
    await supabase.from("space_pages").insert(
      (pages ?? []).map((page: any) => ({
        space_id: copy.id,
        title: page.title,
        template: page.template,
        page_type: page.page_type,
        description: page.description,
        content: page.content,
        plain_text: page.plain_text,
        word_count: page.word_count,
        updated_by_user_id: user.id,
        updated_at: now,
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

  const { data: acceptedUser } = await supabase.from("users").select("id").eq("email", email).maybeSingle();

  await supabase
    .from("space_shares")
    .upsert(
      {
        space_id: space.id,
        email,
        role: "editor",
        invited_by_user_id: user.id,
        accepted_user_id: (acceptedUser as any)?.id ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "space_id,email" },
    );

  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function createPage(input: PageInput) {
  const user = await getCurrentDatabaseUser();
  await assertSpaceAccess(input.spaceId, user);
  const template = normalizePageTemplate(input.template);
  const title = cleanTitle(input.title, "Untitled Page");
  const now = new Date().toISOString();

  await supabase.from("space_pages").insert({
    space_id: input.spaceId,
    title,
    template,
    page_type: pageTypeForTemplate(template),
    description: cleanOptionalText(input.description),
    content: templateContent(title, template),
    plain_text: "",
    word_count: 0,
    updated_by_user_id: user.id,
    updated_at: now,
  });

  await supabase.from("spaces").update({ updated_at: now }).eq("id", input.spaceId);

  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function updatePage(pageId: number, input: Partial<PageInput> & { isFavorite?: boolean; isArchived?: boolean }) {
  const user = await getCurrentDatabaseUser();
  const { page } = await assertPageAccess(pageId, user);
  const template = typeof input.template === "string" ? normalizePageTemplate(input.template) : normalizePageTemplate(page.template);
  const nextSpaceId = typeof input.spaceId === "number" ? input.spaceId : page.space_id;

  if (nextSpaceId !== page.space_id) {
    await assertSpaceAccess(nextSpaceId, user);
  }

  const now = new Date().toISOString();
  await supabase
    .from("space_pages")
    .update({
      space_id: nextSpaceId,
      title: typeof input.title === "string" ? cleanTitle(input.title, "Untitled Page") : page.title,
      template,
      page_type: pageTypeForTemplate(template),
      description: typeof input.description !== "undefined" ? cleanOptionalText(input.description) : page.description,
      is_favorite: typeof input.isFavorite === "boolean" ? input.isFavorite : page.is_favorite,
      is_archived: typeof input.isArchived === "boolean" ? input.isArchived : page.is_archived,
      updated_by_user_id: user.id,
      updated_at: now,
    })
    .eq("id", pageId);

  const spaceIdsToTouch = Array.from(new Set([page.space_id, nextSpaceId]));
  await Promise.all(spaceIdsToTouch.map((id) => supabase.from("spaces").update({ updated_at: now }).eq("id", id)));

  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function updatePageContent(pageId: number, input: PageContentInput) {
  const user = await getCurrentDatabaseUser();
  const { page } = await assertPageAccess(pageId, user);
  const plainText = cleanPlainText(input.plainText);
  const now = new Date().toISOString();

  await supabase
    .from("space_pages")
    .update({
      content: input.content,
      plain_text: plainText,
      word_count: Math.max(0, Number.isFinite(input.wordCount) ? input.wordCount : countWords(plainText)),
      updated_by_user_id: user.id,
      updated_at: now,
    })
    .eq("id", pageId)
    .eq("is_archived", false);

  await supabase.from("spaces").update({ updated_at: now }).eq("id", page.space_id);

  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function duplicatePage(pageId: number) {
  const user = await getCurrentDatabaseUser();
  const { page } = await assertPageAccess(pageId, user);
  const now = new Date().toISOString();

  await supabase.from("space_pages").insert({
    space_id: page.space_id,
    title: `${page.title} copy`,
    template: page.template,
    page_type: page.page_type,
    description: page.description,
    content: page.content,
    plain_text: page.plain_text,
    word_count: page.word_count,
    updated_by_user_id: user.id,
    updated_at: now,
  });

  await supabase.from("spaces").update({ updated_at: now }).eq("id", page.space_id);

  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function deletePage(pageId: number) {
  const user = await getCurrentDatabaseUser();
  const { page } = await assertPageAccess(pageId, user);
  await supabase.from("space_pages").delete().eq("id", pageId);
  await supabase.from("spaces").update({ updated_at: new Date().toISOString() }).eq("id", page.space_id);
  revalidatePath("/spaces");
  return buildSpacesData(user);
}

export async function updatePageTaskLinks(pageId: number, taskIds: number[]) {
  const user = await getCurrentDatabaseUser();
  await assertPageAccess(pageId, user);
  const allowedTaskIds = await listAccessibleTaskIds(user);
  const cleanIds = Array.from(new Set(taskIds.filter((id) => allowedTaskIds.includes(id)))).slice(0, 20);

  await supabase.from("page_task_links").delete().eq("page_id", pageId);
  if (cleanIds.length > 0) {
    await supabase.from("page_task_links").insert(cleanIds.map((taskId) => ({ page_id: pageId, task_id: taskId })));
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
