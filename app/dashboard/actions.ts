"use server";

import { supabase } from "@/db";
import { getCurrentDatabaseUser } from "@/lib/user-preferences";

type DashboardFeatureKey = "calendar" | "kanban" | "notes" | "whiteboard" | "ai-assistant" | "ai-template-builder";
type DashboardTone = "sage" | "clay" | "amber" | "sky" | "violet" | "rose";

export type DashboardFeatureStatus = {
  key: DashboardFeatureKey;
  name: string;
  status: "Active" | "Ready" | "Disabled";
  stat: string;
  detail: string;
  tone: DashboardTone;
};

export type DashboardQuickAction = {
  label: string;
  href: string;
  description: string;
  tone: DashboardTone;
};

export type DashboardActivityItem = {
  id: string;
  title: string;
  label: string;
  href: string;
  occurredAt: string;
  tone: DashboardTone;
};

export type DashboardUpcomingItem = {
  id: number;
  title: string;
  date: string;
  time: string | null;
  type: "task" | "reminder";
  category: string;
  color: string;
};

export type DashboardRecentPage = {
  id: string;
  title: string;
  type: "Note" | "Whiteboard" | "Kanban board" | "AI template";
  href: string;
  updatedAt: string;
  meta: string;
  tone: DashboardTone;
};

export type DashboardTaskSummary = {
  total: number;
  completed: number;
  pending: number;
  overdue: number;
  progress: number;
};

export type DashboardData = {
  userName: string;
  generatedAt: string;
  features: DashboardFeatureStatus[];
  quickActions: DashboardQuickAction[];
  recentActivity: DashboardActivityItem[];
  upcoming: DashboardUpcomingItem[];
  recentPages: DashboardRecentPage[];
  taskSummary: DashboardTaskSummary;
  insights: string[];
};

const quickActions: DashboardQuickAction[] = [
  { label: "Create Task", href: "/kanban", description: "Open your Kanban workspace.", tone: "amber" },
  { label: "Add Calendar Reminder", href: "/calendar", description: "Schedule a task or reminder.", tone: "sage" },
  { label: "Create Note", href: "/notes", description: "Capture a fresh thought.", tone: "sky" },
  { label: "Open Whiteboard", href: "/whiteboard", description: "Sketch ideas visually.", tone: "clay" },
  { label: "Ask AI Assistant", href: "/ai-assistant", description: "Plan or act across the app.", tone: "violet" },
  { label: "Generate AI Template", href: "/ai-template-builder", description: "Build a mini productivity app.", tone: "rose" },
];

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function isCompletedColumn(name: string) {
  const normalized = name.trim().toLowerCase();
  return normalized === "done" || normalized === "completed";
}

function activityLabel(createdAt: string, updatedAt: string, createdLabel: string, updatedLabel: string) {
  return new Date(updatedAt).getTime() - new Date(createdAt).getTime() > 60_000 ? updatedLabel : createdLabel;
}

function dateTimeKey(date: string | null, time: string | null) {
  return `${date || "9999-12-31"}T${time || "23:59"}`;
}

function formatCount(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function categoryColor(category: string, colors: Map<string, string>) {
  return colors.get(category.trim().toLowerCase()) || "#5BAE91";
}

export async function getDashboardData(): Promise<DashboardData> {
  const user = await getCurrentDatabaseUser();
  const today = todayKey();

  const [
    { data: calendar },
    { data: ownedBoards },
    { data: sharedBoardRows },
    { data: userNotes },
    { data: boardsOnly },
    { data: apps },
    { data: categories },
    { data: settings },
    { data: aiUsage },
  ] = await Promise.all([
    supabase.from("calendar_items").select("*").eq("user_id", user.id),
    supabase.from("kanban_boards").select("*").eq("user_id", user.id).order("created_at").order("id"),
    supabase
      .from("kanban_board_shares")
      .select("*, kanban_boards!inner(*)")
      .eq("email", user.email)
      .eq("role", "editor"),
    supabase.from("notes").select("*").eq("user_id", user.id),
    supabase.from("whiteboards").select("*").eq("user_id", user.id),
    supabase.from("generated_apps").select("*").eq("user_id", user.id),
    supabase
      .from("user_categories")
      .select("*")
      .eq("user_id", user.id)
      .in("scope", ["calendar", "reminder", "task", "note"]),
    supabase.from("user_settings").select("*").eq("user_id", user.id).maybeSingle(),
    supabase.from("user_ai_usage").select("*").eq("user_id", user.id).eq("usage_date", today).maybeSingle(),
  ]);

  const boardsById = new Map(
    [...(ownedBoards ?? []), ...(sharedBoardRows ?? []).map((row: any) => row.kanban_boards)].map((board) => [board.id, board]),
  );
  const boards = Array.from(boardsById.values());
  const boardIds = boards.map((board) => board.id);

  const { data: columns } = boardIds.length
    ? await supabase.from("kanban_columns").select("*").in("board_id", boardIds).order("position").order("id")
    : { data: [] };

  const columnIds = (columns ?? []).map((col: any) => col.id);

  const { data: tasks } = columnIds.length
    ? await supabase.from("kanban_tasks").select("*").in("column_id", columnIds).order("position").order("id")
    : { data: [] };

  const columnById = new Map((columns ?? []).map((col: any) => [col.id, col]));
  const boardById = new Map(boards.map((board) => [board.id, board]));
  const categoryColors = new Map((categories ?? []).map((cat: any) => [cat.name.trim().toLowerCase(), cat.color]));

  const enrichedTasks = (tasks ?? []).map((task: any) => {
    const column = columnById.get(task.column_id);
    const board = column ? boardById.get((column as any).board_id) : null;
    return {
      ...task,
      columnName: (column as any)?.name ?? "Todo",
      boardName: (board as any)?.name ?? "Kanban board",
      boardId: (board as any)?.id ?? null,
      isCompleted: isCompletedColumn((column as any)?.name ?? ""),
    };
  });

  const totalTasks = enrichedTasks.length;
  const completedTasks = enrichedTasks.filter((task) => task.isCompleted).length;
  const pendingTasks = totalTasks - completedTasks;
  const overdueTasks = enrichedTasks.filter((task) => !task.isCompleted && task.due_date < today).length;
  const taskSummary: DashboardTaskSummary = {
    total: totalTasks,
    completed: completedTasks,
    pending: pendingTasks,
    overdue: overdueTasks,
    progress: totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0,
  };

  const upcoming: DashboardUpcomingItem[] = (calendar ?? [])
    .filter((item: any) => !item.is_draft && item.scheduled_date && item.scheduled_date >= today)
    .sort((left: any, right: any) =>
      dateTimeKey(left.scheduled_date, left.scheduled_time).localeCompare(dateTimeKey(right.scheduled_date, right.scheduled_time)),
    )
    .slice(0, 6)
    .map((item: any) => ({
      id: item.id,
      title: item.title,
      date: item.scheduled_date!,
      time: item.scheduled_time,
      type: item.item_type === "reminder" ? "reminder" : "task",
      category: item.category,
      color: categoryColor(item.category, categoryColors),
    }));

  const recentPages: DashboardRecentPage[] = [
    ...(userNotes ?? [])
      .filter((note: any) => !note.is_trashed)
      .map((note: any): DashboardRecentPage => ({
        id: `note-${note.id}`,
        title: note.title,
        type: "Note",
        href: "/notes",
        updatedAt: note.updated_at,
        meta: formatCount(note.word_count, "word"),
        tone: "sky",
      })),
    ...(boardsOnly ?? []).map((board: any): DashboardRecentPage => ({
      id: `whiteboard-${board.id}`,
      title: board.name,
      type: "Whiteboard",
      href: "/whiteboard",
      updatedAt: board.updated_at,
      meta: "Visual workspace",
      tone: "clay",
    })),
    ...boards.map((board: any): DashboardRecentPage => ({
      id: `board-${board.id}`,
      title: board.name,
      type: "Kanban board",
      href: "/kanban",
      updatedAt: board.updated_at,
      meta: formatCount(enrichedTasks.filter((task) => task.boardId === board.id).length, "task"),
      tone: "amber",
    })),
    ...(apps ?? []).map((app: any): DashboardRecentPage => ({
      id: `template-${app.id}`,
      title: app.app_name,
      type: "AI template",
      href: `/ai-template-builder/${app.id}`,
      updatedAt: app.updated_at,
      meta: app.description,
      tone: "rose",
    })),
  ]
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, 8);

  const recentActivity: DashboardActivityItem[] = [
    ...(calendar ?? []).map((item: any): DashboardActivityItem => ({
      id: `calendar-${item.id}`,
      title: item.title,
      label: activityLabel(
        item.created_at,
        item.updated_at,
        item.item_type === "reminder" ? "Added reminder" : "Created calendar task",
        "Updated calendar item",
      ),
      href: "/calendar",
      occurredAt: item.updated_at,
      tone: item.item_type === "reminder" ? "violet" : "sage",
    })),
    ...enrichedTasks.map((task): DashboardActivityItem => ({
      id: `task-${task.id}`,
      title: task.title,
      label: activityLabel(task.created_at, task.updated_at, "Created task", "Updated task"),
      href: "/kanban",
      occurredAt: task.updated_at,
      tone: "amber",
    })),
    ...(userNotes ?? [])
      .filter((note: any) => !note.is_trashed)
      .map((note: any): DashboardActivityItem => ({
        id: `note-${note.id}`,
        title: note.title,
        label: activityLabel(note.created_at, note.updated_at, "Created note", "Updated note"),
        href: "/notes",
        occurredAt: note.updated_at,
        tone: "sky",
      })),
    ...(boardsOnly ?? []).map((board: any): DashboardActivityItem => ({
      id: `whiteboard-${board.id}`,
      title: board.name,
      label: activityLabel(board.created_at, board.updated_at, "Created whiteboard", "Updated whiteboard"),
      href: "/whiteboard",
      occurredAt: board.updated_at,
      tone: "clay",
    })),
    ...(apps ?? []).map((app: any): DashboardActivityItem => ({
      id: `template-${app.id}`,
      title: app.app_name,
      label: activityLabel(app.created_at, app.updated_at, "Generated AI template", "Updated AI template"),
      href: `/ai-template-builder/${app.id}`,
      occurredAt: app.updated_at,
      tone: "rose",
    })),
    ...((aiUsage as any)?.action_count > 0
      ? [
          {
            id: `ai-usage-${(aiUsage as any).usage_date}`,
            title: formatCount((aiUsage as any).action_count, "AI action"),
            label: "AI assistant activity",
            href: "/ai-assistant",
            occurredAt: (aiUsage as any).updated_at,
            tone: "violet" as DashboardTone,
          },
        ]
      : []),
  ]
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
    .slice(0, 8);

  const calendarReady = (calendar ?? []).length > 0;
  const aiAssistantEnabled = (settings as any)?.ai_assistant_enabled ?? true;
  const aiTemplateBuilderEnabled = (settings as any)?.ai_template_builder_enabled ?? true;
  const todayReminders = upcoming.filter((item) => item.date === today && item.type === "reminder").length;
  const workspaceCounts = [
    { name: "Notes", count: (userNotes ?? []).filter((note: any) => !note.is_trashed).length },
    { name: "Tasks", count: totalTasks },
    { name: "Calendar", count: (calendar ?? []).length },
    { name: "Whiteboard", count: (boardsOnly ?? []).length },
    { name: "AI templates", count: (apps ?? []).length },
  ];
  const mostActiveWorkspace = workspaceCounts.sort((left, right) => right.count - left.count)[0];

  const features: DashboardFeatureStatus[] = [
    {
      key: "calendar",
      name: "Calendar",
      status: calendarReady ? "Active" : "Ready",
      stat: formatCount(upcoming.length, "upcoming item"),
      detail: `${formatCount((calendar ?? []).filter((item: any) => item.is_draft).length, "draft")} saved`,
      tone: "sage",
    },
    {
      key: "kanban",
      name: "Kanban / Tasks",
      status: totalTasks > 0 ? "Active" : "Ready",
      stat: formatCount(totalTasks, "task"),
      detail: `${formatCount(completedTasks, "completed")} across ${formatCount(boards.length, "board")}`,
      tone: "amber",
    },
    {
      key: "notes",
      name: "Notes",
      status: (userNotes ?? []).some((note: any) => !note.is_trashed) ? "Active" : "Ready",
      stat: formatCount((userNotes ?? []).filter((note: any) => !note.is_trashed).length, "note"),
      detail: `${formatCount((userNotes ?? []).filter((note: any) => note.is_pinned && !note.is_trashed).length, "pinned note")} ready`,
      tone: "sky",
    },
    {
      key: "whiteboard",
      name: "Whiteboard",
      status: (boardsOnly ?? []).length > 0 ? "Active" : "Ready",
      stat: formatCount((boardsOnly ?? []).length, "board"),
      detail:
        (boardsOnly ?? []).length > 0
          ? `Latest: ${[...(boardsOnly ?? [])].sort((left: any, right: any) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())[0].name}`
          : "Canvas ready",
      tone: "clay",
    },
    {
      key: "ai-assistant",
      name: "AI Assistant",
      status: aiAssistantEnabled ? ((aiUsage as any)?.action_count ? "Active" : "Ready") : "Disabled",
      stat: formatCount((aiUsage as any)?.action_count ?? 0, "action"),
      detail: "Today",
      tone: "violet",
    },
    {
      key: "ai-template-builder",
      name: "AI Template Builder",
      status: aiTemplateBuilderEnabled ? ((apps ?? []).length ? "Active" : "Ready") : "Disabled",
      stat: formatCount((apps ?? []).length, "template"),
      detail: `${formatCount((apps ?? []).filter((app: any) => app.is_in_sidebar).length, "sidebar app")} pinned`,
      tone: "rose",
    },
  ];

  const insights = [
    overdueTasks > 0 ? `You have ${formatCount(overdueTasks, "overdue task")}.` : "No overdue tasks right now.",
    mostActiveWorkspace.count > 0 ? `Your most active workspace is ${mostActiveWorkspace.name}.` : "Your workspace is ready for its first activity.",
    totalTasks > 0 ? `You completed ${taskSummary.progress}% of tracked tasks.` : "Create a task to start tracking progress.",
    todayReminders > 0 ? `You have ${formatCount(todayReminders, "reminder")} today.` : "No reminders scheduled for today.",
    overdueTasks > 0 ? "Suggested focus: finish overdue work before adding new tasks." : "Suggested focus: plan the next clear task.",
  ];

  return {
    userName: user.name || user.email.split("@")[0] || "there",
    generatedAt: new Date().toISOString(),
    features,
    quickActions,
    recentActivity,
    upcoming,
    recentPages,
    taskSummary,
    insights,
  };
}
