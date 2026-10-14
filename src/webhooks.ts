import { ChannelType, type Message, type TextChannel, type Webhook } from "discord.js";
import type { Companion } from "./types.js";
import { inc } from "./metrics.js";

const WEBHOOK_NAME = "Characterly Companions";
const webhookCache = new Map<string, Webhook>();

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
 * and avatar via a Discord channel webhook. If the bot lacks ManageWebhooks
 * permission (or the channel type doesn't support webhooks), falls back to a
 * standard bot reply prefixed with the companion's name so speech never drops.
 */
export async function sendAsCompanion(
  triggerMessage: Message,
  companion: Pick<Companion, "id" | "name" | "avatarUrl">,
  content: string,
  botUserId: string,
): Promise<{ id: string; createdAt: Date; viaWebhook: boolean }> {
  const { host, threadId } = resolveWebhookHostChannel(triggerMessage.channel);
  if (host) {
    const hook = await getOrCreateChannelWebhook(host, botUserId);
    if (hook) {
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
        // Stale or deleted webhook — evict and retry once before falling back.
        webhookCache.delete(host.id);
        inc("webhook.send_retry");
      }
    }
  }

  const fallback = await triggerMessage.reply({
    content: `**[${companion.name}]** ${content}`.slice(0, 2000),
    allowedMentions: { parse: [], repliedUser: false },
  });
  inc("webhook.fallback_sent");
  return {
    id: fallback.id,
    createdAt: fallback.createdAt ?? new Date(),
    viaWebhook: false,
  };
}
