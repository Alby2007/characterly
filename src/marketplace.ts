/**
 * Marketplace forum surface — listing cards, card buttons, and thread
 * creation. Lives in its own module because both commands.ts (interactions)
 * and ops.ts (the seed catalog) need it, and ops.ts is already imported by
 * commands.ts — this leaf has no project imports beyond types + config.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { CompanionListing } from "./types.js";
import type { MemoryStore } from "./database.js";
import { config } from "./config.js";

/** The four moderated forum tags the bot owns. Names are the contract —
 *  matched case-insensitively against the forum's live `availableTags`; a
 *  missing name skips its rule silently. */
export const CURATED_TAGS = {
  new: "New",
  topRated: "Top Rated",
  trending: "Trending",
  staffPick: "Staff Pick",
} as const;

export function buildListingCard(listing: CompanionListing, creatorName: string, stats?: { avg: number; count: number }): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(listing.name)
    .setDescription(listing.tagline || "A companion up for adoption")
    .addFields(
      { name: "Voice & Vibe", value: listing.voicePersona || "—" },
      { name: "Traits", value: listing.coreTraits.length ? listing.coreTraits.join(", ") : "—", inline: true },
      { name: "Adopted by", value: `${listing.addCount} user${listing.addCount === 1 ? "" : "s"}`, inline: true },
      { name: "Rating", value: stats && stats.count > 0 ? `★ ${stats.avg.toFixed(1)} · ${stats.count} rating${stats.count === 1 ? "" : "s"}` : "No ratings yet", inline: true },
    )
    .setFooter({ text: `by ${creatorName} · Characterly Marketplace · v${listing.version}` });
  if (listing.avatarUrl) embed.setThumbnail(listing.avatarUrl);
  return embed;
}

export function buildListingComponents(listingId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`market:add:${listingId}`).setLabel("Add to your companions").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`market:rate:${listingId}`).setLabel("Rate").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`market:tags:${listingId}`).setLabel("Tags").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`market:report:${listingId}`).setLabel("Report").setStyle(ButtonStyle.Secondary),
  );
}

/** Create the forum thread + listing card the bot owns (both publish paths,
 *  relist, and the seed catalog). `opts.tagNames` are additional forum tag
 *  names (genre picks for seeds) resolved live against `availableTags`.
 *  Returns the new thread id, or null on failure — the caller decides
 *  whether to roll the listing row back. */
export async function postListingThread(
  interaction: { client: ChatInputCommandInteraction["client"]; user: { username?: string; globalName?: string | null } },
  listing: CompanionListing,
  store: MemoryStore,
  opts: { tagNames?: string[] } = {},
): Promise<string | null> {
  const channel = await interaction.client.channels.fetch(config.marketplaceChannelId!).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildForum) return null;
  const creatorName = interaction.user.globalName ?? interaction.user.username ?? "a creator";
  const stats = await store.listingRatingStats(listing.id).catch(() => undefined);
  // Every fresh thread earns the curated "New" badge — the tag sweep strips
  // it once the thread ages past MARKET_NEW_TAG_DAYS. Genre tag names resolve
  // live; unknown/moderated names are dropped (creators never pick those).
  const available = channel.availableTags ?? [];
  const tagIds = new Map(available.filter(t => !t.moderated).map(t => [t.name.toLowerCase(), t.id] as const));
  const newTag = available.find(t => t.name.toLowerCase() === CURATED_TAGS.new.toLowerCase());
  const appliedTags = [
    ...(newTag ? [newTag.id] : []),
    ...(opts.tagNames ?? []).map(n => tagIds.get(n.toLowerCase())).filter((id): id is string => !!id),
  ].slice(0, 5);
  const thread = await channel.threads.create({
    name: `${listing.name} — ${listing.tagline}`.slice(0, 100),
    appliedTags: appliedTags.length ? appliedTags : undefined,
    message: {
      embeds: [buildListingCard(listing, creatorName, stats)],
      components: [buildListingComponents(listing.id)],
    },
  }).catch(() => null);
  return thread?.id ?? null;
}
