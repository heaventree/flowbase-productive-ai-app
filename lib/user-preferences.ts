import "server-only";

import { auth, currentUser } from "@clerk/nextjs/server";

import { supabase } from "@/db";
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
    createdAt: category.created_at,
    updatedAt: category.updated_at,
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

  const { data, error } = await supabase
    .from("users")
    .upsert(
      { clerk_id: clerkId, email: normalizedEmail, liveblocks_id: liveblocksId, name },
      { onConflict: "clerk_id" },
    )
    .select("id, email, name, clerk_id")
    .single();

  if (error) throw new Error(error.message);

  return {
    id: data.id,
    email: data.email,
    name: data.name,
    clerkId: data.clerk_id,
  };
}

export async function isCurrentUserPro() {
  const session = await auth();
  if (!session.userId) return false;

  return session.has({ plan: "user:pro" }) || session.has({ plan: "pro" });
}

export async function listUserCategories(scopes: CategoryScope[] = [...categoryScopes]) {
  const user = await getCurrentDatabaseUser();
  const { data: rows } = await supabase
    .from("user_categories")
    .select("*")
    .eq("user_id", user.id)
    .in("scope", scopes);

  return (rows ?? [])
    .map(toCategoryDTO)
    .sort((left, right) => left.scope.localeCompare(right.scope) || left.name.localeCompare(right.name));
}

export async function getUserUsageSnapshot(userId: number) {
  const today = new Date().toISOString().slice(0, 10);

  const [
    { count: boardCount },
    { data: taskCountData },
    { count: noteCount },
    { count: spaceCount },
    { count: whiteboardCount },
    { data: usageData },
  ] = await Promise.all([
    supabase.from("kanban_boards").select("*", { count: "exact", head: true }).eq("user_id", userId),
    supabase
      .from("kanban_tasks")
      .select("kanban_columns!inner(kanban_boards!inner(user_id))")
      .eq("kanban_columns.kanban_boards.user_id", userId),
    supabase.from("notes").select("*", { count: "exact", head: true }).eq("user_id", userId),
    supabase.from("spaces").select("*", { count: "exact", head: true }).eq("user_id", userId),
    supabase.from("whiteboards").select("*", { count: "exact", head: true }).eq("user_id", userId),
    supabase
      .from("user_ai_usage")
      .select("action_count")
      .eq("user_id", userId)
      .eq("usage_date", today)
      .maybeSingle(),
  ]);

  return {
    boards: boardCount ?? 0,
    tasks: taskCountData?.length ?? 0,
    notes: noteCount ?? 0,
    spaces: spaceCount ?? 0,
    whiteboards: whiteboardCount ?? 0,
    aiActionsToday: (usageData as any)?.action_count ?? 0,
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
  const featureMap: Record<string, string> = {
    aiRefineEnabled: "ai_refine_enabled",
    aiTemplateBuilderEnabled: "ai_template_builder_enabled",
    aiDiagramEnabled: "ai_diagram_enabled",
    aiAssistantEnabled: "ai_assistant_enabled",
  };
  const { data: settings } = await supabase
    .from("user_settings")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (settings && !settings[featureMap[feature]]) {
    throw new Error("This AI feature is disabled in Settings.");
  }
}

export async function recordAiAction() {
  if (await isCurrentUserPro()) return;

  const user = await getCurrentDatabaseUser();
  const today = new Date().toISOString().slice(0, 10);

  const { data: existing } = await supabase
    .from("user_ai_usage")
    .select("action_count")
    .eq("user_id", user.id)
    .eq("usage_date", today)
    .maybeSingle();

  const newCount = (existing?.action_count ?? 0) + 1;

  await supabase
    .from("user_ai_usage")
    .upsert(
      { user_id: user.id, usage_date: today, action_count: newCount, updated_at: new Date().toISOString() },
      { onConflict: "user_id,usage_date" },
    );

  if (newCount > freePlanLimits.aiActionsPerDay) {
    throw new Error(`Free plan limit reached: ${freePlanLimits.aiActionsPerDay} AI actions per day. Upgrade to Pro for unlimited AI.`);
  }
}

export async function exportCurrentUserData() {
  const user = await getCurrentDatabaseUser();

  const [
    { data: settings },
    { data: categories },
    { data: calendar },
    { data: boards },
    { data: userNotes },
    { data: userSpaces },
    { data: userWhiteboards },
    { data: apps },
  ] = await Promise.all([
    supabase.from("user_settings").select("*").eq("user_id", user.id).maybeSingle(),
    supabase.from("user_categories").select("*").eq("user_id", user.id),
    supabase.from("calendar_items").select("*").eq("user_id", user.id),
    supabase.from("kanban_boards").select("*").eq("user_id", user.id),
    supabase.from("notes").select("*").eq("user_id", user.id),
    supabase.from("spaces").select("*").eq("user_id", user.id),
    supabase.from("whiteboards").select("*").eq("user_id", user.id),
    supabase.from("generated_apps").select("*").eq("user_id", user.id),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    user: { email: user.email, name: user.name },
    settings,
    categories,
    calendar,
    kanbanBoards: boards,
    notes: userNotes,
    spaces: userSpaces,
    whiteboards: userWhiteboards,
    generatedApps: apps,
  };
}
