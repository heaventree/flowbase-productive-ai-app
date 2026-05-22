import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name"),
  email: text("email").notNull().unique(),
  liveblocksId: text("liveblocks_id").unique(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  clerkId: text("clerk_id").notNull().unique(),
});

export const calendarItems = sqliteTable("calendar_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  itemType: text("item_type").notNull().default("task"),
  category: text("category").notNull().default("work"),
  scheduledDate: text("scheduled_date"),
  scheduledTime: text("scheduled_time"),
  isDraft: integer("is_draft", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

export const kanbanBoards = sqliteTable("kanban_boards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull().default("sage"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

export const kanbanColumns = sqliteTable("kanban_columns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  boardId: integer("board_id")
    .notNull()
    .references(() => kanbanBoards.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

export const kanbanTasks = sqliteTable("kanban_tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  columnId: integer("column_id")
    .notNull()
    .references(() => kanbanColumns.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  dueDate: text("due_date").notNull(),
  priority: text("priority").notNull().default("medium"),
  category: text("category"),
  labels: text("labels", { mode: "json" }).$type<{ name: string; color: string }[]>().notNull().default([]),
  syncCalendar: integer("sync_calendar", { mode: "boolean" }).notNull().default(false),
  linkNotes: integer("link_notes", { mode: "boolean" }).notNull().default(false),
  calendarItemId: integer("calendar_item_id").references(() => calendarItems.id, { onDelete: "set null" }),
  position: integer("position").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

export const kanbanBoardShares = sqliteTable(
  "kanban_board_shares",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    boardId: integer("board_id")
      .notNull()
      .references(() => kanbanBoards.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("editor"),
    invitedByUserId: integer("invited_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    acceptedUserId: integer("accepted_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  },
  (table) => [uniqueIndex("kanban_board_shares_board_email_unique").on(table.boardId, table.email)],
);

export const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  icon: text("icon").notNull().default("FileText"),
  color: text("color").notNull().default("sage"),
  category: text("category"),
  content: text("content", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  plainText: text("plain_text").notNull().default(""),
  wordCount: integer("word_count").notNull().default(0),
  isPinned: integer("is_pinned", { mode: "boolean" }).notNull().default(false),
  isTrashed: integer("is_trashed", { mode: "boolean" }).notNull().default(false),
  trashedAt: text("trashed_at"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

export const whiteboards = sqliteTable("whiteboards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull().default("sage"),
  scene: text("scene", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  files: text("files", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

export const generatedApps = sqliteTable("generated_apps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  appName: text("app_name").notNull(),
  description: text("description").notNull(),
  icon: text("icon").notNull().default("LayoutTemplate"),
  color: text("color").notNull().default("#F97316"),
  layout: text("layout").notNull().default("single-page"),
  definition: text("definition", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  appState: text("app_state", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  isInSidebar: integer("is_in_sidebar", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

export const spaces = sqliteTable("spaces", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color").notNull().default("violet"),
  isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(false),
  isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

export const spaceShares = sqliteTable(
  "space_shares",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    spaceId: integer("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("editor"),
    invitedByUserId: integer("invited_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    acceptedUserId: integer("accepted_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  },
  (table) => [uniqueIndex("space_shares_space_email_unique").on(table.spaceId, table.email)],
);

export const spacePages = sqliteTable("space_pages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  spaceId: integer("space_id")
    .notNull()
    .references(() => spaces.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  template: text("template").notNull().default("Blank Page"),
  pageType: text("page_type").notNull().default("Document"),
  description: text("description"),
  content: text("content", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  plainText: text("plain_text").notNull().default(""),
  wordCount: integer("word_count").notNull().default(0),
  isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(false),
  isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
  updatedByUserId: integer("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

export const pageTaskLinks = sqliteTable(
  "page_task_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    pageId: integer("page_id")
      .notNull()
      .references(() => spacePages.id, { onDelete: "cascade" }),
    taskId: integer("task_id")
      .notNull()
      .references(() => kanbanTasks.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  },
  (table) => [uniqueIndex("page_task_links_page_task_unique").on(table.pageId, table.taskId)],
);

export const pageComments = sqliteTable("page_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pageId: integer("page_id")
    .notNull()
    .references(() => spacePages.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

export const userSettings = sqliteTable("user_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" })
    .unique(),
  theme: text("theme").notNull().default("system"),
  notificationsEnabled: integer("notifications_enabled", { mode: "boolean" }).notNull().default(true),
  emailNotificationsEnabled: integer("email_notifications_enabled", { mode: "boolean" }).notNull().default(false),
  defaultCalendarView: text("default_calendar_view").notNull().default("month"),
  defaultTaskPriority: text("default_task_priority").notNull().default("medium"),
  autoSaveEnabled: integer("auto_save_enabled", { mode: "boolean" }).notNull().default(true),
  privacyModeEnabled: integer("privacy_mode_enabled", { mode: "boolean" }).notNull().default(false),
  twoFactorReminderDismissed: integer("two_factor_reminder_dismissed", { mode: "boolean" }).notNull().default(false),
  aiModel: text("ai_model").notNull().default("gemini-3.1-flash-lite"),
  aiBehavior: text("ai_behavior").notNull().default("balanced"),
  aiTone: text("ai_tone").notNull().default("Friendly"),
  aiRefineEnabled: integer("ai_refine_enabled", { mode: "boolean" }).notNull().default(true),
  aiAssistantEnabled: integer("ai_assistant_enabled", { mode: "boolean" }).notNull().default(true),
  aiTemplateBuilderEnabled: integer("ai_template_builder_enabled", { mode: "boolean" }).notNull().default(true),
  aiDiagramEnabled: integer("ai_diagram_enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

export const userCategories = sqliteTable(
  "user_categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull().default("#5BAE91"),
    icon: text("icon").notNull().default("Tag"),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  },
  (table) => [uniqueIndex("user_categories_user_scope_name_unique").on(table.userId, table.scope, table.name)],
);

export const userAiUsage = sqliteTable(
  "user_ai_usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    usageDate: text("usage_date").notNull(),
    actionCount: integer("action_count").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  },
  (table) => [uniqueIndex("user_ai_usage_user_date_unique").on(table.userId, table.usageDate)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type CalendarItem = typeof calendarItems.$inferSelect;
export type NewCalendarItem = typeof calendarItems.$inferInsert;
export type KanbanBoard = typeof kanbanBoards.$inferSelect;
export type NewKanbanBoard = typeof kanbanBoards.$inferInsert;
export type KanbanColumn = typeof kanbanColumns.$inferSelect;
export type NewKanbanColumn = typeof kanbanColumns.$inferInsert;
export type KanbanTask = typeof kanbanTasks.$inferSelect;
export type NewKanbanTask = typeof kanbanTasks.$inferInsert;
export type KanbanBoardShare = typeof kanbanBoardShares.$inferSelect;
export type NewKanbanBoardShare = typeof kanbanBoardShares.$inferInsert;
export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
export type Whiteboard = typeof whiteboards.$inferSelect;
export type NewWhiteboard = typeof whiteboards.$inferInsert;
export type GeneratedApp = typeof generatedApps.$inferSelect;
export type NewGeneratedApp = typeof generatedApps.$inferInsert;
export type Space = typeof spaces.$inferSelect;
export type NewSpace = typeof spaces.$inferInsert;
export type SpaceShare = typeof spaceShares.$inferSelect;
export type NewSpaceShare = typeof spaceShares.$inferInsert;
export type SpacePage = typeof spacePages.$inferSelect;
export type NewSpacePage = typeof spacePages.$inferInsert;
export type PageTaskLink = typeof pageTaskLinks.$inferSelect;
export type NewPageTaskLink = typeof pageTaskLinks.$inferInsert;
export type PageComment = typeof pageComments.$inferSelect;
export type NewPageComment = typeof pageComments.$inferInsert;
export type UserSettings = typeof userSettings.$inferSelect;
export type NewUserSettings = typeof userSettings.$inferInsert;
export type UserCategory = typeof userCategories.$inferSelect;
export type NewUserCategory = typeof userCategories.$inferInsert;
export type UserAiUsage = typeof userAiUsage.$inferSelect;
export type NewUserAiUsage = typeof userAiUsage.$inferInsert;
