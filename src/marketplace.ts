/**
 * Marketplace forum surface — listing cards, card buttons, and thread
 * creation. Lives in its own module because both commands.ts (interactions)
 * and ops.ts (the seed catalog) need it, and ops.ts is already imported by
 * commands.ts — this leaf has no project imports beyond types + config.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { CompanionListing, GuildDeployment, ListingPost } from "./types.js";
import type { MemoryStore } from "./database.js";
import { inc } from "./metrics.js";
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

/** The tag taxonomy a deployed partner forum is created with (v59): curated
 *  badges moderated (bot-only), genre tags open for creators. Names are the
 *  sync currency across mirrors — tag ids differ per forum. */
export const PARTNER_TAG_SET: Array<{ name: string; moderated: boolean }> = [
  { name: CURATED_TAGS.new, moderated: true },
  { name: CURATED_TAGS.topRated, moderated: true },
  { name: CURATED_TAGS.trending, moderated: true },
  { name: CURATED_TAGS.staffPick, moderated: true },
  { name: "Companion", moderated: false },
  { name: "Slice of Life", moderated: false },
  { name: "RPG", moderated: false },
  { name: "Fantasy", moderated: false },
  { name: "Adventure", moderated: false },
  { name: "Anime", moderated: false },
  { name: "Games", moderated: false },
  { name: "OC", moderated: false },
  { name: "Romance", moderated: false },
  { name: "Horror", moderated: false },
  { name: "Sci-Fi", moderated: false },
  { name: "Helpers", moderated: false },
  { name: "Historical", moderated: false },
  { name: "Comedy", moderated: false },
];

/** Resolve a committed cover asset under assets/marketplace/. The filename is
 *  basename'd so a persona can't path-traverse out of the asset dir. Returns
 *  null when the file isn't on disk — callers degrade to a coverless card
 *  rather than failing the post. */
export function marketplaceAssetPath(file: string): string | null {
  const safe = file.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe || safe !== file) return null;
  const p = fileURLToPath(new URL(`../assets/marketplace/${safe}`, import.meta.url));
  return existsSync(p) ? p : null;
}

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
  // Imported personas say so on the card — the community seeing the provenance
  // is what makes "stolen card" reports meaningful.
  if (listing.personaSource === "card_import") {
    embed.addFields({ name: "Provenance", value: "Imported character card", inline: true });
  }
  // Alternate openings are a quiet signal on the card — a count, not
  // previews; the openings themselves reveal themselves at Meet time.
  if (listing.openings?.length) {
    embed.addFields({ name: "Ways to meet", value: `${listing.openings.length + 1} openings`, inline: true });
  }
  // The LARGE image, not the thumbnail: Discord derives a forum post's Gallery
  // cover from the OP message's embed image / attachments — thumbnails don't
  // count. So a creator's avatar URL doubles as the cover art.
  if (listing.avatarUrl) embed.setImage(listing.avatarUrl);
  return embed;
}

export function buildListingComponents(listingId: number): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`market:add:${listingId}`).setLabel("Add to your companions").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`market:rate:${listingId}`).setLabel("Rate").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`market:tags:${listingId}`).setLabel("Tags").setStyle(ButtonStyle.Secondary),
      // Creator-only at click (same gate as Tags) — the URL-modal cover setter.
      new ButtonBuilder().setCustomId(`market:cover:${listingId}`).setLabel("Cover image").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`market:report:${listingId}`).setLabel("Report").setStyle(ButtonStyle.Secondary),
    ),
    // Creator manage row — same click-gate as Tags/Cover. Gives freehand and
    // import-published listings a persistent edit path (their only one; the
    // post-publish manage row is ephemeral).
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`market:editmodal:${listingId}`).setLabel("Edit persona").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`market:scenes:${listingId}`).setLabel("Scenes").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

interface ForumLike {
  id: string;
  type: number;
  guild?: { id?: string };
  availableTags?: Array<{ id: string; name: string; moderated?: boolean | null }>;
  threads?: { create(o: unknown): Promise<{ id: string } | null> };
}

/** Anything that resolves a channel id — discord.js `client.channels.fetch`
 *  in interactions, `deps.fetchChannel` in ops sweeps. */
export type ChannelFetcher = (id: string) => Promise<unknown>;

/** Create the listing thread inside ONE forum channel — the per-mirror unit
 *  the fan-out drives. `opts.tagNames` are forum tag NAMES (genre picks for
 *  seeds, creator picks for re-posts) resolved live against `availableTags`;
 *  `opts.coverFile` attaches a committed asset from assets/marketplace/ — the
 *  attachment doubles as the thread's Gallery View cover. Returns the new
 *  thread id, or null on failure — the caller decides whether to roll the
 *  listing row back. */
export async function postListingInForum(
  fetchChannel: ChannelFetcher,
  forumChannelId: string,
  creatorName: string,
  listing: CompanionListing,
  store: MemoryStore,
  opts: { tagNames?: string[]; coverFile?: string } = {},
): Promise<string | null> {
  const channel = (await fetchChannel(forumChannelId).catch(() => null)) as ForumLike | null;
  if (!channel || channel.type !== ChannelType.GuildForum || typeof channel.threads?.create !== "function") return null;
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
  // The cover rides as a plain attachment on the OP message — it displays
  // under the card in-thread AND becomes the Gallery View cover. Missing art
  // degrades to a coverless post (never fails the listing).
  const coverPath = opts.coverFile ? marketplaceAssetPath(opts.coverFile) : null;
  const thread = await channel.threads.create({
    name: `${listing.name} — ${listing.tagline}`.slice(0, 100),
    appliedTags: appliedTags.length ? appliedTags : undefined,
    message: {
      embeds: [buildListingCard(listing, creatorName, stats)],
      components: buildListingComponents(listing.id),
      ...(coverPath ? { files: [new AttachmentBuilder(coverPath, { name: opts.coverFile! })] } : {}),
    },
  }).catch(() => null);
  return thread?.id ?? null;
}

/** Single-forum posting for the pre-v59 call sites: the house marketplace
 *  channel from env. Kept as a thin wrapper — new code should prefer
 *  postListingToDeployments so partner mirrors stay in step. */
export async function postListingThread(
  interaction: { client: ChatInputCommandInteraction["client"]; user: { username?: string; globalName?: string | null } },
  listing: CompanionListing,
  store: MemoryStore,
  opts: { tagNames?: string[]; coverFile?: string } = {},
): Promise<string | null> {
  if (!config.marketplaceChannelId) return null;
  const creatorName = interaction.user.globalName ?? interaction.user.username ?? "a creator";
  return postListingInForum(id => interaction.client.channels.fetch(id), config.marketplaceChannelId, creatorName, listing, store, opts);
}

/** Fan-out: post a listing's card into EVERY active deployment's forum and
 *  record a listing_posts row per guild — the mirrored catalog. Partner
 *  failures are recorded (`status='failed'`) for the sync sweep to retry and
 *  never block the publish; the caller only rolls back when ZERO posts
 *  succeeded. Returns the live posts written plus per-guild failures. */
export async function postListingToDeployments(
  fetchChannel: ChannelFetcher,
  deployments: GuildDeployment[],
  creatorName: string,
  listing: CompanionListing,
  store: MemoryStore,
  opts: { tagNames?: string[]; coverFile?: string } = {},
): Promise<{ posted: ListingPost[]; failed: Array<{ guildId: string; error: string }> }> {
  const tagNames = opts.tagNames ?? listing.creatorTags ?? [];
  const posted: ListingPost[] = [];
  const failed: Array<{ guildId: string; error: string }> = [];
  for (const dep of deployments) {
    if (dep.status !== "active" || !dep.marketplaceChannelId) continue;
    const threadId = await postListingInForum(fetchChannel, dep.marketplaceChannelId, creatorName, listing, store, { ...opts, tagNames })
      .catch(e => { failed.push({ guildId: dep.guildId, error: String((e as Error)?.message ?? e).slice(0, 200) }); return null; });
    if (threadId) {
      await store.setListingPost(listing.id, dep.guildId, threadId, "live").catch(() => inc("market.post_registry_error"));
      posted.push({ listingId: listing.id, guildId: dep.guildId, threadId, status: "live", lastError: null });
    } else {
      if (!failed.some(f => f.guildId === dep.guildId)) failed.push({ guildId: dep.guildId, error: "post failed" });
      await store.setListingPostFailed(listing.id, dep.guildId, failed.find(f => f.guildId === dep.guildId)?.error ?? "post failed").catch(() => inc("market.post_registry_error"));
    }
  }
  return { posted, failed };
}

/** Catalog backfill: every active listing that lacks a live post in the
 *  given deployments gets one. Driven by `missingListingPosts` so retries of
 *  failed mirrors share the same queue as new-server seeds. Bounded by the
 *  SQL limit — the sweep re-runs to drain larger gaps. `creatorName` is used
 *  when the listing's creator can't be resolved. */
export async function postActiveListingsToDeployments(
  fetchChannel: ChannelFetcher,
  deployments: GuildDeployment[],
  store: MemoryStore,
  fetchCreator: (creatorId: string) => Promise<string | null>,
  limit = 10,
): Promise<{ posted: number; failed: number }> {
  const targets = new Set(deployments.filter(d => d.status === "active" && d.marketplaceChannelId).map(d => d.guildId));
  if (!targets.size) return { posted: 0, failed: 0 };
  const queue = (await store.missingListingPosts(limit).catch(() => []))
    .filter(q => targets.has(q.guildId));
  let posted = 0, failed = 0;
  for (const q of queue) {
    const listing = await store.listingById(q.listingId).catch(() => null);
    const dep = deployments.find(d => d.guildId === q.guildId);
    if (!listing || !dep) continue;
    const creatorName = (await fetchCreator(listing.creatorUserId).catch(() => null)) ?? "a Characterly creator";
    const threadId = await postListingInForum(fetchChannel, dep.marketplaceChannelId!, creatorName, listing, store, { tagNames: listing.creatorTags ?? [] })
      .catch(() => null);
    if (threadId) {
      await store.setListingPost(listing.id, dep.guildId, threadId, "live").catch(() => inc("market.post_registry_error"));
      posted++;
    } else {
      await store.setListingPostFailed(listing.id, dep.guildId, "backfill post failed").catch(() => inc("market.post_registry_error"));
      failed++;
    }
  }
  return { posted, failed };
}

/** Lock + archive every live mirror of a listing — delist/ban/disable paths.
 *  Threads are fetched per-post (thread ids are globally unique, so no forum
 *  resolution is needed). Returns the count actually archived. */
export async function archiveListingPosts(
  fetchChannel: ChannelFetcher,
  posts: ListingPost[],
  opts: { note?: string } = {},
): Promise<number> {
  let archived = 0;
  for (const post of posts) {
    if (!post.threadId) continue;
    const thread = await fetchChannel(post.threadId).catch(() => null) as
      { send?(o: unknown): Promise<unknown>; setLocked?(b: boolean): Promise<unknown>; setArchived?(b: boolean): Promise<unknown> } | null;
    if (!thread) continue;
    if (opts.note) await thread.send?.({ content: opts.note, allowedMentions: { parse: [] } }).catch(() => {});
    await thread.setLocked?.(true).catch(() => {});
    const ok = await thread.setArchived?.(true).then(() => true).catch(() => false) ?? false;
    if (ok) archived++;
  }
  return archived;
}
