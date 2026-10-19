import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits, type Guild, type GuildBasedChannel, type TextChannel } from "discord.js";
import { config } from "./config.js";
import type { MemoryStore } from "./database.js";
import { pauseGuildClaims } from "./jobs.js";

// Guild lifecycle — announce-then-wait-for-consent: new guilds start dormant
// (v16 defaults memory_enabled=0/reply_enabled=0), get a disclosure card, and
// every row is purged if the bot is kicked. announced_at is the idempotency
// marker — discord.js fires GuildCreate for every cached guild on connect AND
// on real joins, so the first deploy announces once to existing guilds
// (desirable). Lives outside index.ts so it can be unit-tested.

/** Post the join disclosure card once per guild. Stamps announced_at only
 * after a successful send — failure leaves it NULL so the next GuildCreate
 * retries. Returns true when an announcement was posted. */
export async function announceIfNeeded(guild: Guild, store: MemoryStore): Promise<boolean> {
  const s = await store.settings(guild.id, config.rawMessageRetentionDays); // creates the row with dormant defaults
  if (s.announcedAt) return false;
  const me = guild.members.me;
  // systemChannel goes through the SAME permission check as the fallback scan —
  // an unsendable system channel must fall through, or the card retries forever.
  const sendable = (c: GuildBasedChannel | null | undefined): c is TextChannel =>
    c?.type === ChannelType.GuildText &&
    (!me || !!c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]));
  const channel = (sendable(guild.systemChannel) ? guild.systemChannel : null)
    ?? guild.channels.cache.find(sendable) ?? null;
  if (!channel) {
    console.warn(`[announce] no sendable channel in ${guild.name} — will retry on next connect`);
    return false;
  }
  const embed = new EmbedBuilder()
    .setTitle("Characterly is here — Personal Companions & Shared Memory")
    .setDescription(
      "Characterly is the server host that lets members bring their personal AI companions into channels via webhooks and builds opt-in shared lore. **Right now this server is dormant — an admin can enable Characterly in one click below.**"
    )
    .addFields(
      { name: "Admins — 1-Click Activation (No Server Key Needed)", value: "Click **Enable Characterly** below (or run `/server resume`). No server API key is required — each member's companion runs on their own personal key." },
      { name: "Personal Companions (1 per Account)", value: "Click **Awaken Your Companion** below (or DM the bot) to connect your personal AI key and create your permanent companion — each account gets one character, locked in once awakened — then run `/companion summon` to bring them into this server." },
      { name: "Hosted mode & tokens", value: `No API key? Link a free Characterly account — sign up at ${config.siteUrl} then run \`/link\` here — and your companion runs on daily hosted tokens. Bring your own key anytime with \`/companion key\` for unlimited chat.` },
      { name: "What it stores (when enabled)", value: `Raw messages for **${s.rawRetentionDays} days**, then deleted. Derived memories, profiles, and relationship notes form **only for members who opt in**.` },
      { name: "Your controls", value: "`/companion` — manage, summon, or set your personal API key · `/privacy` — see what's stored · `/opt-in` `/opt-out` — control your derived data · `/memory export` — export your data · admins: `/server` for every setting" },
      { name: "Privacy policy", value: `[${config.siteUrl.replace(/\/+$/, "").replace(/^https?:\/\//, "")}/privacy](${config.siteUrl.replace(/\/+$/, "")}/privacy) — kick the bot and every row it stored here is deleted.` },
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("server:enable")
      .setLabel("Enable Characterly (Admins)")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("onboard:start")
      .setLabel("Awaken Your Companion")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("server:decline")
      .setLabel("Remove Characterly (Admins)")
      .setStyle(ButtonStyle.Danger),
  );
  await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
  const announced = await store.markAnnounced(guild.id);
  // announced_at dedupes GuildCreate (connect + real joins) — this fires once
  // per guild ever, which is exactly "first join".
  if (announced) void store.trackEvent(null, "guild_added", guild.id);
  return announced;
}

/** GuildDelete semantics — returns true when a purge ran. `unavailable` means
 * a Discord outage took the guild offline, NOT a kick: never purge on it;
 * the rows come back when Discord recovers. */
export async function handleGuildDelete(
  guild: { id: string; name: string; unavailable?: boolean },
  store: MemoryStore,
): Promise<boolean> {
  if (guild.unavailable) return false;
  // Stop new job claims for the dead guild first — a worker claiming an
  // extract job mid-purge would re-insert derived rows after it commits.
  // In-flight jobs still finish; the guildsNotIn sweep catches their residue.
  pauseGuildClaims(guild.id);
  await store.purgeGuild(guild.id);
  return true;
}
