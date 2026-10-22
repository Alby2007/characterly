import { ChannelType, type Message, type TextChannel, type Webhook } from "discord.js";
import type { Companion } from "./types.js";
import { inc } from "./metrics.js";

const WEBHOOK_NAME = "Characterly Companions";
const webhookCache = new Map<string, Webhook>();
const webhookPermissionNotices = new Set<string>();
// Keys carry a date suffix so they never expire — cap the set and evict
// insertion-oldest so a long-lived process doesn't grow it without bound.
const WEBHOOK_NOTICE_CAP = 512;

function webhookNoticeOnce(channelId: string): boolean {
  const key = `${channelId}:${new Date().toISOString().slice(0, 10)}`;
  if (webhookPermissionNotices.has(key)) return false;
  if (webhookPermissionNotices.size >= WEBHOOK_NOTICE_CAP) {
    webhookPermissionNotices.delete(webhookPermissionNotices.values().next().value!);
  }
  webhookPermissionNotices.add(key);
  return true;
}

function resolveWebhookHostChannel(channel: { type: ChannelType; parent?: { type: ChannelType } | null; id: string }): { host: TextChannel | null; threadId?: string } {
  if (channel.type === ChannelType.GuildText) {
    return { host: channel as TextChannel };
  }
  if (
    (channel.type === ChannelType.PublicThread ||
      channel.type === ChannelType.PrivateThread ||
      channel.type === ChannelType.AnnouncementThread) &&
    channel.parent &&
    channel.parent.type === ChannelType.GuildText
  ) {
    return { host: channel.parent as TextChannel, threadId: channel.id };
  }
  return { host: null };
}

async function getOrCreateChannelWebhook(host: TextChannel, botUserId: string): Promise<Webhook | null> {
  const cached = webhookCache.get(host.id);
  if (cached) return cached;
  try {
    const hooks = await host.fetchWebhooks();
    const existing = hooks.find(h => h.owner?.id === botUserId && Boolean(h.token));
    if (existing) {
      webhookCache.set(host.id, existing);
      return existing;
    }
    const created = await host.createWebhook({
      name: WEBHOOK_NAME,
      reason: "Per-companion identity for Characterly companions",
    });
    webhookCache.set(host.id, created);
    return created;
  } catch {
    inc("webhook.unavailable");
    return null;
  }
}

/**
 * Send a reply in a guild channel disguised with the speaking companion's name
 * and avatar via a Discord channel webhook. Characterly itself never roleplays
 * or speaks a companion's dialogue — if ManageWebhooks permission is missing,
 * it posts a one-time system notice and returns null.
 */
/** Persona send into any guild channel/thread — the shared core behind
 *  sendAsCompanion. Returns null when the webhook lane is unavailable;
 *  callers decide what the failure means (a notice, a plain fallback, …). */
export async function sendAsCompanionInChannel(
  channel: { type: ChannelType; parent?: { type: ChannelType } | null; id: string },
  companion: Pick<Companion, "id" | "name" | "avatarUrl">,
  content: string,
  botUserId: string,
): Promise<{ id: string; createdAt: Date; viaWebhook: boolean } | null> {
  const { host, threadId } = resolveWebhookHostChannel(channel);
  if (host) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const hook = await getOrCreateChannelWebhook(host, botUserId);
      if (!hook) break;
      try {
        const sent = await hook.send({
          content,
          username: companion.name.slice(0, 80) || "Companion",
          ...(companion.avatarUrl ? { avatarURL: companion.avatarUrl } : {}),
          allowedMentions: { parse: [] },
          ...(threadId ? { threadId } : {}),
        });
        inc("webhook.sent");
        return {
          id: sent.id,
          createdAt: sent.createdAt ?? new Date(),
          viaWebhook: true,
        };
      } catch {
        // Stale or deleted webhook — evict and retry once.
        webhookCache.delete(host.id);
        inc("webhook.send_retry");
      }
    }
  }
  inc("webhook.unavailable_blocked");
  return null;
}

/** Edit a companion's earlier webhook post in place — Regenerate swaps the
 *  reply text while the message keeps its id and position. A webhook can only
 *  edit its own messages (a bot token never can), so this rides the same
 *  per-host webhook the send path uses; false = the lane is gone. */
export async function editCompanionMessage(
  channel: { type: ChannelType; parent?: { type: ChannelType } | null; id: string },
  messageId: string,
  content: string,
  botUserId: string,
): Promise<boolean> {
  const { host, threadId } = resolveWebhookHostChannel(channel);
  if (!host) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const hook = await getOrCreateChannelWebhook(host, botUserId);
    if (!hook) break;
    try {
      await hook.editMessage(messageId, { content, ...(threadId ? { threadId } : {}) });
      return true;
    } catch {
      // Stale or deleted webhook — evict and retry once. A 404 on the message
      // itself just costs one extra call.
      webhookCache.delete(host.id);
      inc("webhook.edit_retry");
    }
  }
  inc("webhook.edit_unavailable");
  return false;
}

export async function sendAsCompanion(
  triggerMessage: Message,
  companion: Pick<Companion, "id" | "name" | "avatarUrl">,
  content: string,
  botUserId: string,
): Promise<{ id: string; createdAt: Date; viaWebhook: boolean } | null> {
  const sent = await sendAsCompanionInChannel(triggerMessage.channel, companion, content, botUserId);
  if (sent) return sent;
  if (webhookNoticeOnce(triggerMessage.channelId)) {
    await triggerMessage
      .reply({
        content: `*System: Characterly needs the **Manage Webhooks** permission in this channel so **${companion.name}** can speak here.*`,
        allowedMentions: { parse: [], repliedUser: false },
      })
      .catch(() => {});
  }
  return null;
}
