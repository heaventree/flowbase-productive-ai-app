"use server";

import { currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

import { supabase } from "@/db";
import { assertFreePlanLimit } from "@/lib/user-preferences";

const itemTypes = ["task", "reminder"] as const;

export type CalendarItemType = (typeof itemTypes)[number];
export type CalendarCategory = string;

export type CalendarItemDTO = {
  id: number;
  title: string;
  description: string | null;
  itemType: CalendarItemType;
  category: CalendarCategory;
  scheduledDate: string | null;
  scheduledTime: string | null;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CalendarItemInput = {
  title: string;
  description?: string;
  itemType: string;
  category: string;
  scheduledDate?: string | null;
  scheduledTime?: string | null;
};

function normalizeType(value: string): CalendarItemType {
  return itemTypes.includes(value as CalendarItemType) ? (value as CalendarItemType) : "task";
}

function normalizeCategory(value: string): CalendarCategory {
  return value.trim().replace(/\s+/g, " ").slice(0, 36) || "Work";
}

function cleanOptionalText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toDTO(item: any): CalendarItemDTO {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    itemType: normalizeType(item.item_type),
    category: normalizeCategory(item.category),
    scheduledDate: item.scheduled_date,
    scheduledTime: item.scheduled_time,
    isDraft: item.is_draft,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

async function getCurrentDatabaseUserId() {
  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress;
  const clerkId = user?.id;

  if (!email || !clerkId) {
    throw new Error("You must be signed in to manage calendar items.");
  }

  const name = user.fullName || user.username || email.split("@")[0] || null;

  const { data, error } = await supabase
    .from("users")
    .upsert({ clerk_id: clerkId, email, name }, { onConflict: "clerk_id" })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  return data.id;
}

export async function listCalendarItems() {
  const userId = await getCurrentDatabaseUserId();
  const { data: items } = await supabase.from("calendar_items").select("*").eq("user_id", userId);
  return (items ?? []).map(toDTO);
}

export async function createCalendarItem(input: CalendarItemInput, asDraft = false) {
  await assertFreePlanLimit("tasks");
  const userId = await getCurrentDatabaseUserId();
  const title = input.title.trim();

  if (!title) {
    throw new Error("Task title is required.");
  }

  const scheduledDate = asDraft ? null : cleanOptionalText(input.scheduledDate);

  if (!asDraft && !scheduledDate) {
    throw new Error("Choose a date before scheduling this item.");
  }

  const { data, error } = await supabase
    .from("calendar_items")
    .insert({
      user_id: userId,
      title,
      description: cleanOptionalText(input.description),
      item_type: normalizeType(input.itemType),
      category: normalizeCategory(input.category),
      scheduled_date: scheduledDate,
      scheduled_time: cleanOptionalText(input.scheduledTime),
      is_draft: asDraft,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  revalidatePath("/calendar");
  return toDTO(data);
}

export async function updateCalendarItem(id: number, input: CalendarItemInput, asDraft = false) {
  const userId = await getCurrentDatabaseUserId();
  const title = input.title.trim();

  if (!title) {
    throw new Error("Task title is required.");
  }

  const scheduledDate = asDraft ? null : cleanOptionalText(input.scheduledDate);

  if (!asDraft && !scheduledDate) {
    throw new Error("Choose a date before scheduling this item.");
  }

  const { data, error } = await supabase
    .from("calendar_items")
    .update({
      title,
      description: cleanOptionalText(input.description),
      item_type: normalizeType(input.itemType),
      category: normalizeCategory(input.category),
      scheduled_date: scheduledDate,
      scheduled_time: cleanOptionalText(input.scheduledTime),
      is_draft: asDraft,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", userId)
    .select()
    .single();

  if (error || !data) {
    throw new Error("Calendar item not found.");
  }

  revalidatePath("/calendar");
  return toDTO(data);
}

export async function scheduleCalendarItem(id: number, scheduledDate: string) {
  const userId = await getCurrentDatabaseUserId();
  const date = cleanOptionalText(scheduledDate);

  if (!date) {
    throw new Error("Choose a date before scheduling this item.");
  }

  const { data, error } = await supabase
    .from("calendar_items")
    .update({
      scheduled_date: date,
      is_draft: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", userId)
    .select()
    .single();

  if (error || !data) {
    throw new Error("Calendar item not found.");
  }

  revalidatePath("/calendar");
  return toDTO(data);
}

export async function moveCalendarItemToDraft(id: number) {
  const userId = await getCurrentDatabaseUserId();

  const { data, error } = await supabase
    .from("calendar_items")
    .update({
      scheduled_date: null,
      is_draft: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", userId)
    .select()
    .single();

  if (error || !data) {
    throw new Error("Calendar item not found.");
  }

  revalidatePath("/calendar");
  return toDTO(data);
}

export async function deleteCalendarItem(id: number) {
  const userId = await getCurrentDatabaseUserId();

  const { data, error } = await supabase
    .from("calendar_items")
    .delete()
    .eq("id", id)
    .eq("user_id", userId)
    .select("id")
    .single();

  if (error || !data) {
    throw new Error("Calendar item not found.");
  }

  revalidatePath("/calendar");
  return data.id;
}
