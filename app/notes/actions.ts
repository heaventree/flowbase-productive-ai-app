"use server";

import { GoogleGenAI } from "@google/genai";
import { currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

import { supabase } from "@/db";
import { assertAiFeatureEnabled, assertFreePlanLimit, recordAiAction } from "@/lib/user-preferences";

const noteColors = ["sage", "clay", "amber", "sky", "violet"] as const;
const noteIcons = ["FileText", "BookOpen", "Lightbulb", "Sparkles", "PenLine"] as const;
const GEMINI_MODEL = "gemini-3.1-flash-lite";

export type NoteColor = (typeof noteColors)[number];
export type NoteIcon = (typeof noteIcons)[number];
export type RefineAction = "grammar" | "rephrase" | "shorter" | "longer" | "simplify" | "tone";
export type RefineTone = "Friendly" | "Professional" | "Confident" | "Casual";
export type NoteContent = Record<string, unknown>;

export type NoteDTO = {
  id: number;
  title: string;
  icon: NoteIcon;
  color: NoteColor;
  category: string | null;
  content: NoteContent;
  plainText: string;
  wordCount: number;
  isPinned: boolean;
  isTrashed: boolean;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NoteContentInput = {
  content: NoteContent;
  plainText: string;
  wordCount: number;
};

export type NoteMetadataInput = {
  color?: string;
  icon?: string;
  category?: string | null;
  isPinned?: boolean;
};

const emptyContent: NoteContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

function normalizeColor(value?: string | null): NoteColor {
  return noteColors.includes(value as NoteColor) ? (value as NoteColor) : "sage";
}

function normalizeIcon(value?: string | null): NoteIcon {
  return noteIcons.includes(value as NoteIcon) ? (value as NoteIcon) : "FileText";
}

function cleanTitle(value: string) {
  const title = value.trim();
  return title || "Untitled";
}

function cleanPlainText(value: string) {
  return value.trim().slice(0, 20000);
}

function normalizeCategory(value?: string | null) {
  return value?.trim().replace(/\s+/g, " ").slice(0, 36) || null;
}

function countWords(value: string) {
  const words = value.trim().match(/\S+/g);
  return words?.length ?? 0;
}

function toDTO(note: any): NoteDTO {
  return {
    id: note.id,
    title: note.title,
    icon: normalizeIcon(note.icon),
    color: normalizeColor(note.color),
    category: normalizeCategory(note.category),
    content: note.content,
    plainText: note.plain_text,
    wordCount: note.word_count,
    isPinned: note.is_pinned,
    isTrashed: note.is_trashed,
    trashedAt: note.trashed_at ?? null,
    createdAt: note.created_at,
    updatedAt: note.updated_at,
  };
}

function sortNotes(left: NoteDTO, right: NoteDTO) {
  if (left.isTrashed !== right.isTrashed) return left.isTrashed ? 1 : -1;
  if (left.isPinned !== right.isPinned) return left.isPinned ? -1 : 1;
  return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime() || right.id - left.id;
}

async function getCurrentDatabaseUserId() {
  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress;
  const clerkId = user?.id;

  if (!email || !clerkId) {
    throw new Error("You must be signed in to manage notes.");
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

async function assertNoteAccess(noteId: number, userId: number) {
  const { data: note } = await supabase
    .from("notes")
    .select("*")
    .eq("id", noteId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!note) {
    throw new Error("Note not found.");
  }

  return note;
}

export async function listNotes() {
  const userId = await getCurrentDatabaseUserId();
  const { data: userNotes } = await supabase
    .from("notes")
    .select("*")
    .eq("user_id", userId);

  return (userNotes ?? []).map(toDTO).sort(sortNotes);
}

export async function createNote() {
  await assertFreePlanLimit("notes");
  const userId = await getCurrentDatabaseUserId();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("notes")
    .insert({
      user_id: userId,
      title: "Untitled",
      content: emptyContent,
      plain_text: "",
      word_count: 0,
      updated_at: now,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  revalidatePath("/notes");
  return toDTO(data);
}

export async function updateNoteTitle(noteId: number, title: string) {
  const userId = await getCurrentDatabaseUserId();
  await assertNoteAccess(noteId, userId);

  const { data, error } = await supabase
    .from("notes")
    .update({ title: cleanTitle(title), updated_at: new Date().toISOString() })
    .eq("id", noteId)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) throw new Error(error.message);

  revalidatePath("/notes");
  return toDTO(data);
}

export async function updateNoteMetadata(noteId: number, input: NoteMetadataInput) {
  const userId = await getCurrentDatabaseUserId();
  const note = await assertNoteAccess(noteId, userId);

  const { data, error } = await supabase
    .from("notes")
    .update({
      color: input.color ? normalizeColor(input.color) : note.color,
      icon: input.icon ? normalizeIcon(input.icon) : note.icon,
      category: typeof input.category !== "undefined" ? normalizeCategory(input.category) : note.category,
      is_pinned: typeof input.isPinned === "boolean" ? input.isPinned : note.is_pinned,
      updated_at: new Date().toISOString(),
    })
    .eq("id", noteId)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) throw new Error(error.message);

  revalidatePath("/notes");
  return toDTO(data);
}

export async function updateNoteContent(noteId: number, input: NoteContentInput) {
  const userId = await getCurrentDatabaseUserId();
  await assertNoteAccess(noteId, userId);
  const plainText = cleanPlainText(input.plainText);

  const { data, error } = await supabase
    .from("notes")
    .update({
      content: input.content,
      plain_text: plainText,
      word_count: Math.max(0, Number.isFinite(input.wordCount) ? input.wordCount : countWords(plainText)),
      updated_at: new Date().toISOString(),
    })
    .eq("id", noteId)
    .eq("user_id", userId)
    .eq("is_trashed", false)
    .select()
    .single();

  if (error || !data) {
    throw new Error("Note not found.");
  }

  revalidatePath("/notes");
  return toDTO(data);
}

export async function duplicateNote(noteId: number) {
  await assertFreePlanLimit("notes");
  const userId = await getCurrentDatabaseUserId();
  const source = await assertNoteAccess(noteId, userId);
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("notes")
    .insert({
      user_id: userId,
      title: `${source.title} copy`,
      icon: source.icon,
      color: source.color,
      category: source.category,
      content: source.content,
      plain_text: source.plain_text,
      word_count: source.word_count,
      is_pinned: false,
      is_trashed: false,
      trashed_at: null,
      updated_at: now,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  revalidatePath("/notes");
  return toDTO(data);
}

export async function trashNote(noteId: number) {
  const userId = await getCurrentDatabaseUserId();
  await assertNoteAccess(noteId, userId);

  await supabase
    .from("notes")
    .update({ is_trashed: true, is_pinned: false, trashed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", noteId)
    .eq("user_id", userId);

  revalidatePath("/notes");
  return listNotes();
}

export async function restoreNote(noteId: number) {
  const userId = await getCurrentDatabaseUserId();
  await assertNoteAccess(noteId, userId);

  const { data, error } = await supabase
    .from("notes")
    .update({ is_trashed: false, trashed_at: null, updated_at: new Date().toISOString() })
    .eq("id", noteId)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) throw new Error(error.message);

  revalidatePath("/notes");
  return toDTO(data);
}

export async function deleteNoteForever(noteId: number) {
  const userId = await getCurrentDatabaseUserId();
  await assertNoteAccess(noteId, userId);

  await supabase
    .from("notes")
    .delete()
    .eq("id", noteId)
    .eq("user_id", userId)
    .eq("is_trashed", true);

  revalidatePath("/notes");
  return listNotes();
}

function getRefineInstruction(action: RefineAction, tone?: RefineTone) {
  if (action === "grammar") return "Improve grammar and clarity without changing the meaning.";
  if (action === "rephrase") return "Rephrase the text while preserving the meaning.";
  if (action === "shorter") return "Make the text shorter while preserving the essential meaning.";
  if (action === "longer") return "Make the text more complete and expressive without adding unsupported facts.";
  if (action === "simplify") return "Simplify the language for easier reading.";
  return `Change the tone to ${tone || "Friendly"} while preserving the meaning.`;
}

export async function refineSelectedText(input: { text: string; action: RefineAction; tone?: RefineTone }) {
  await assertAiFeatureEnabled("aiRefineEnabled");
  await recordAiAction();
  await getCurrentDatabaseUserId();
  const selectedText = input.text.trim();

  if (!selectedText) {
    throw new Error("Select text to refine first.");
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Gemini is not configured. Add GEMINI_API_KEY to enable AI Refine.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      "You refine selected note text. Return only the replacement text, with no markdown fences, labels, or commentary.",
      `Instruction: ${getRefineInstruction(input.action, input.tone)}`,
      `Selected text:\n${selectedText}`,
    ].join("\n\n"),
  });
  const refinedText = response.text?.trim();

  if (!refinedText) {
    throw new Error("Gemini did not return refined text.");
  }

  return refinedText;
}
