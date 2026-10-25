// Web chat client (v73). Thin typed wrappers over the RPCs in
// docs/web-chat-frontend.md — the server resolves the caller from the session,
// so nothing here passes a user id. Every RPC returns one json value; failures
// are {ok:false, reason} and `reason` is the only thing the UI switches on.
import { supabase } from "./supabase";

export type MsgRole = "user" | "companion" | "system";
export type MsgStatus = "pending" | "generating" | "done" | "failed";
export type Message = {
  id: number; role: MsgRole; content: string; status: MsgStatus;
  fail_reason?: string | null; client_msg_id?: string | null; created_at: string;
};
export type Adoption = {
  adoption_id: number; companion_id: number; listing_id: number | null; name: string;
  avatar_url: string | null; tagline: string | null; listing_status: string | null;
  origin: "web" | "discord" | string; adopted_at: string; open_conversation_id: number | null;
};
export type Conversation = {
  id: number; companion_id: number; adoption_id: number; name: string; avatar_url: string | null;
  scope: string; archived: boolean; created_at: string; last_activity_at: string; pending: boolean;
  last_message: { id: number; role: MsgRole; content: string; status: MsgStatus; created_at: string } | null;
};
type Fail = { ok: false; reason: string; [k: string]: unknown };

/** Unwrap a PostgREST rpc: a transport/SQL error becomes {ok:false, reason}.
 *  "not authenticated" is raised as an exception server-side. */
async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T | Fail> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    const m = String(error.message ?? "");
    return { ok: false, reason: /not authenticated/i.test(m) ? "signed_out" : error.code === "PGRST202" ? "unavailable" : "network" };
  }
  return data as T;
}

export const adoptListing = (listingId: number) =>
  call<{ ok: true; adoption_id: number; companion_id: number; conversation_id: number; name: string; reused: boolean; revived: boolean } | Fail>(
    "web_adopt_listing", { p_listing_id: listingId });
export const myAdoptions = () => call<Adoption[]>("web_my_adoptions");
export const openConversation = (adoptionId: number) =>
  call<{ ok: true; conversation_id: number; created: boolean } | Fail>("web_open_conversation", { p_adoption_id: adoptionId });
export const myConversations = () => call<Conversation[]>("web_my_conversations");
export const sendMessage = (conversationId: number, text: string, clientMsgId: string) =>
  call<{ ok: true; user_message_id: number; companion_message_id: number; reused: boolean } | Fail>(
    "web_send_message", { p_conversation_id: conversationId, p_text: text, p_client_msg_id: clientMsgId });
export const conversationMessages = (conversationId: number, afterId = 0, limit = 200) =>
  call<Message[]>("web_conversation_messages", { p_conversation_id: conversationId, p_after_id: afterId, p_limit: limit });
export const archiveConversation = (conversationId: number, archived = true) =>
  call<{ ok: true } | Fail>("web_archive_conversation", { p_conversation_id: conversationId, p_archived: archived });
export const dropAdoption = (adoptionId: number) => call<{ ok: true } | Fail>("web_drop_adoption", { p_adoption_id: adoptionId });
export const reportListing = (listingId: number, category: string, reason = "") =>
  call<{ ok: true; count: number; flagged: boolean } | Fail>("web_report_listing", { p_listing_id: listingId, p_category: category, p_reason: reason });

export const isFail = (v: unknown): v is Fail =>
  !!v && typeof v === "object" && !Array.isArray(v) && (v as { ok?: unknown }).ok === false;

/** Report taxonomy — mirrors src/safety.ts REPORT_CATEGORIES and the
 *  web_report_listing server allowlist. */
export const REPORT_CATEGORIES: ReadonlyArray<readonly [string, string]> = [
  ["minor", "Minor safety concern"],
  ["sexual", "Sexual or explicit"],
  ["harmful", "Harmful or dangerous"],
  ["hate", "Hate or harassment"],
  ["spam", "Spam or low effort"],
  ["theft", "Stolen persona"],
  ["other", "Something else"],
];

export const MAX_MESSAGE = 4000;

/** Subscribe to the account's private broadcast channel. Returns an
 *  unsubscribe function; `onState` reports whether the channel is live so the
 *  caller can lean on polling when it isn't. Realtime is best-effort: the
 *  contract's polling fallback always runs underneath. */
export async function subscribeMessages(
  userId: string,
  onMessage: (m: Message & { conversation_id: number }) => void,
  onState: (live: boolean) => void,
): Promise<() => void> {
  try { await supabase.realtime.setAuth(); } catch { /* falls back to polling */ }
  const ch = supabase
    .channel(`web-messages:${userId}`, { config: { private: true } })
    .on("broadcast", { event: "message" }, ({ payload }) => {
      const p = payload as Message & { conversation_id: number; type?: string };
      if (p && typeof p.id === "number" && typeof p.conversation_id === "number") onMessage(p);
    })
    .subscribe(status => onState(status === "SUBSCRIBED"));
  return () => { supabase.removeChannel(ch); };
}

// ── Rendering helpers (text only: every string here is user/model authored) ──

/** "*stage direction* speech" → nodes, the same convention the shelf uses for
 *  greetings. Line breaks are kept by CSS (white-space: pre-wrap). */
export function formatMessage(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const part of text.split(/(\*[^*\n]+\*)/g)) {
    if (!part) continue;
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
      const em = document.createElement("em");
      em.textContent = part.slice(1, -1);
      frag.append(em);
    } else frag.append(document.createTextNode(part));
  }
  return frag;
}

/** One line of preview text with stage directions dropped. */
export const previewLine = (text: string) =>
  text.replace(/\*[^*\n]+\*/g, "").replace(/\s+/g, " ").trim() || text.replace(/\*/g, "").trim();

const rtf = typeof Intl !== "undefined" && "RelativeTimeFormat" in Intl ? new Intl.RelativeTimeFormat("en", { numeric: "auto" }) : null;
export function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.round((t - Date.now()) / 1000);
  const a = Math.abs(s);
  if (a < 45) return "Just now";
  if (!rtf) return new Date(t).toLocaleDateString();
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (a < 604800) return rtf.format(Math.round(s / 86400), "day");
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export const newClientId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
