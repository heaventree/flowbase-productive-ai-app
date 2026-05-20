"use server";

import { revalidatePath } from "next/cache";

import { supabase } from "@/db";
import {
  CategoryScope,
  categoryScopes,
  cleanCategoryName,
  cleanHexColor,
  cleanIconName,
  exportCurrentUserData,
  freePlanLimits,
  getCurrentDatabaseUser,
  getUserUsageSnapshot,
  isCategoryScope,
  isCurrentUserPro,
  toCategoryDTO,
  type UserCategoryDTO,
} from "@/lib/user-preferences";

const defaultCategories: Array<{ scope: CategoryScope; name: string; color: string; icon: string }> = [
  { scope: "calendar", name: "Work", color: "#5BAE91", icon: "BriefcaseBusiness" },
  { scope: "calendar", name: "Personal", color: "#EF806F", icon: "Heart" },
  { scope: "calendar", name: "Focus", color: "#4BA3C7", icon: "Focus" },
  { scope: "calendar", name: "Meeting", color: "#E6A23C", icon: "Users" },
  { scope: "reminder", name: "Reminder", color: "#8B7CF6", icon: "Bell" },
  { scope: "task", name: "Build", color: "#E6A23C", icon: "Hammer" },
  { scope: "task", name: "Review", color: "#4BA3C7", icon: "ListChecks" },
  { scope: "task", name: "Admin", color: "#8B7CF6", icon: "ClipboardList" },
  { scope: "note", name: "Ideas", color: "#EF806F", icon: "Lightbulb" },
  { scope: "note", name: "Research", color: "#5BAE91", icon: "BookOpen" },
  { scope: "note", name: "Meeting Notes", color: "#E6A23C", icon: "NotebookPen" },
];

const themeOptions = ["system", "light", "dark"] as const;
const calendarViews = ["month", "week"] as const;
const priorities = ["low", "medium", "high"] as const;
const aiModels = ["gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-2.5-pro"] as const;
const aiBehaviors = ["concise", "balanced", "detailed"] as const;
const aiTones = ["Friendly", "Professional", "Confident", "Casual"] as const;

export type UserSettingsDTO = {
  theme: string;
  notificationsEnabled: boolean;
  emailNotificationsEnabled: boolean;
  defaultCalendarView: string;
  defaultTaskPriority: string;
  autoSaveEnabled: boolean;
  privacyModeEnabled: boolean;
  twoFactorReminderDismissed: boolean;
  aiModel: string;
  aiBehavior: string;
  aiTone: string;
  aiRefineEnabled: boolean;
  aiAssistantEnabled: boolean;
  aiTemplateBuilderEnabled: boolean;
  aiDiagramEnabled: boolean;
  updatedAt: string;
};

export type SettingsPageData = {
  profile: {
    name: string | null;
    email: string;
    initials: string;
  };
  settings: UserSettingsDTO;
  categories: UserCategoryDTO[];
  usage: Awaited<ReturnType<typeof getUserUsageSnapshot>>;
  limits: typeof freePlanLimits;
  isPro: boolean;
};

export type UserSettingsInput = Partial<Omit<UserSettingsDTO, "updatedAt">>;

export type CategoryInput = {
  scope: string;
  name: string;
  color: string;
  icon: string;
};

function option<T extends readonly string[]>(value: unknown, options: T, fallback: T[number]) {
  return typeof value === "string" && options.includes(value as T[number]) ? value : fallback;
}

function toSettingsDTO(settings: any): UserSettingsDTO {
  return {
    theme: option(settings.theme, themeOptions, "system"),
    notificationsEnabled: settings.notifications_enabled,
    emailNotificationsEnabled: settings.email_notifications_enabled,
    defaultCalendarView: option(settings.default_calendar_view, calendarViews, "month"),
    defaultTaskPriority: option(settings.default_task_priority, priorities, "medium"),
    autoSaveEnabled: settings.auto_save_enabled,
    privacyModeEnabled: settings.privacy_mode_enabled,
    twoFactorReminderDismissed: settings.two_factor_reminder_dismissed,
    aiModel: option(settings.ai_model, aiModels, "gemini-3.1-flash-lite"),
    aiBehavior: option(settings.ai_behavior, aiBehaviors, "balanced"),
    aiTone: option(settings.ai_tone, aiTones, "Friendly"),
    aiRefineEnabled: settings.ai_refine_enabled,
    aiAssistantEnabled: settings.ai_assistant_enabled,
    aiTemplateBuilderEnabled: settings.ai_template_builder_enabled,
    aiDiagramEnabled: settings.ai_diagram_enabled,
    updatedAt: settings.updated_at,
  };
}

function initials(name: string | null, email: string) {
  const source = name || email;
  return source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

async function ensureSettings(userId: number) {
  const { data, error } = await supabase
    .from("user_settings")
    .upsert({ user_id: userId, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

async function ensureDefaultCategories(userId: number) {
  await supabase
    .from("user_categories")
    .upsert(
      defaultCategories.map((category) => ({
        user_id: userId,
        scope: category.scope,
        name: category.name,
        color: category.color,
        icon: category.icon,
      })),
      { ignoreDuplicates: true },
    );
}

export async function listSettingsPageData(): Promise<SettingsPageData> {
  const user = await getCurrentDatabaseUser();
  const [settings] = await Promise.all([ensureSettings(user.id), ensureDefaultCategories(user.id)]);
  const [{ data: categoriesRaw }, usage, isPro] = await Promise.all([
    supabase.from("user_categories").select("*").eq("user_id", user.id),
    getUserUsageSnapshot(user.id),
    isCurrentUserPro(),
  ]);

  return {
    profile: {
      name: user.name,
      email: user.email,
      initials: initials(user.name, user.email),
    },
    settings: toSettingsDTO(settings),
    categories: (categoriesRaw ?? []).map(toCategoryDTO),
    usage,
    limits: freePlanLimits,
    isPro,
  };
}

export async function updateUserSettings(input: UserSettingsInput) {
  const user = await getCurrentDatabaseUser();
  const values: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof input.theme === "string") values.theme = option(input.theme, themeOptions, "system");
  if (typeof input.notificationsEnabled === "boolean") values.notifications_enabled = input.notificationsEnabled;
  if (typeof input.emailNotificationsEnabled === "boolean") values.email_notifications_enabled = input.emailNotificationsEnabled;
  if (typeof input.defaultCalendarView === "string") values.default_calendar_view = option(input.defaultCalendarView, calendarViews, "month");
  if (typeof input.defaultTaskPriority === "string") values.default_task_priority = option(input.defaultTaskPriority, priorities, "medium");
  if (typeof input.autoSaveEnabled === "boolean") values.auto_save_enabled = input.autoSaveEnabled;
  if (typeof input.privacyModeEnabled === "boolean") values.privacy_mode_enabled = input.privacyModeEnabled;
  if (typeof input.twoFactorReminderDismissed === "boolean") values.two_factor_reminder_dismissed = input.twoFactorReminderDismissed;
  if (typeof input.aiModel === "string") values.ai_model = option(input.aiModel, aiModels, "gemini-3.1-flash-lite");
  if (typeof input.aiBehavior === "string") values.ai_behavior = option(input.aiBehavior, aiBehaviors, "balanced");
  if (typeof input.aiTone === "string") values.ai_tone = option(input.aiTone, aiTones, "Friendly");
  if (typeof input.aiRefineEnabled === "boolean") values.ai_refine_enabled = input.aiRefineEnabled;
  if (typeof input.aiAssistantEnabled === "boolean") values.ai_assistant_enabled = input.aiAssistantEnabled;
  if (typeof input.aiTemplateBuilderEnabled === "boolean") values.ai_template_builder_enabled = input.aiTemplateBuilderEnabled;
  if (typeof input.aiDiagramEnabled === "boolean") values.ai_diagram_enabled = input.aiDiagramEnabled;

  const { data, error } = await supabase
    .from("user_settings")
    .upsert({ user_id: user.id, ...values }, { onConflict: "user_id" })
    .select()
    .single();

  if (error) throw new Error(error.message);

  revalidatePath("/settings");
  return toSettingsDTO(data);
}

function cleanCategoryInput(input: CategoryInput) {
  const scope = isCategoryScope(input.scope) ? input.scope : null;
  const name = cleanCategoryName(input.name);

  if (!scope) throw new Error("Choose a valid category scope.");
  if (!name) throw new Error("Category name is required.");

  return {
    scope,
    name,
    color: cleanHexColor(input.color),
    icon: cleanIconName(input.icon),
  };
}

export async function createCategory(input: CategoryInput) {
  const user = await getCurrentDatabaseUser();
  const category = cleanCategoryInput(input);
  const { data, error } = await supabase
    .from("user_categories")
    .insert({ ...category, user_id: user.id, updated_at: new Date().toISOString() })
    .select()
    .single();

  if (error) throw new Error(error.message);

  revalidatePath("/settings");
  revalidatePath("/calendar");
  revalidatePath("/kanban");
  revalidatePath("/notes");
  return toCategoryDTO(data);
}

export async function updateCategory(id: number, input: CategoryInput) {
  const user = await getCurrentDatabaseUser();
  const category = cleanCategoryInput(input);
  const { data, error } = await supabase
    .from("user_categories")
    .update({ ...category, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error || !data) throw new Error("Category not found.");

  revalidatePath("/settings");
  revalidatePath("/calendar");
  revalidatePath("/kanban");
  revalidatePath("/notes");
  return toCategoryDTO(data);
}

export async function deleteCategory(id: number) {
  const user = await getCurrentDatabaseUser();
  const { data, error } = await supabase
    .from("user_categories")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error || !data) throw new Error("Category not found.");

  revalidatePath("/settings");
  revalidatePath("/calendar");
  revalidatePath("/kanban");
  revalidatePath("/notes");
  return toCategoryDTO(data);
}

export async function listCategoriesForScopes(scopes: CategoryScope[]) {
  const data = await listSettingsPageData();
  const allowed = new Set(scopes.length ? scopes : categoryScopes);
  return data.categories.filter((category) => allowed.has(category.scope));
}

export async function exportUserData() {
  return exportCurrentUserData();
}
