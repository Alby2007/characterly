import { ChannelType, type Message, type TextChannel, type Webhook } from "discord.js";
import type { Companion } from "./types.js";
import { inc } from "./metrics.js";

const WEBHOOK_NAME = "Characterly Companions";
const webhookCache = new Map<string, Webhook>();
const webhookPermissionNotices = new Set<string>();

function webhookNoticeOnce(channelId: string): boolean {
  const key = `${channelId}:${new Date().toISOString().slice(0, 10)}`;
  if (webhookPermissionNotices.has(key)) return false;
  webhookPermissionNotices.add(key);
  return true;
}

function resolveWebhookHostChannel(channel: Message["channel"]): { host: TextChannel | null; threadId?: string } {
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
export async function sendAsCompanion(
  triggerMessage: Message,
  companion: Pick<Companion, "id" | "name" | "avatarUrl">,
  content: string,
  botUserId: string,
): Promise<{ id: string; createdAt: Date; viaWebhook: boolean } | null> {
  const { host, threadId } = resolveWebhookHostChannel(triggerMessage.channel);
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
