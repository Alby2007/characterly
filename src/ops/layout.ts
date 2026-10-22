import { ChannelType, EmbedBuilder, ForumLayoutType, GuildOnboardingMode, GuildOnboardingPromptType, PermissionFlagsBits, type GuildOnboardingEditOptions } from "discord.js";
import { config } from "../config.js";
import { inc } from "../metrics.js";
import { logError } from "../secrets.js";
import { PARTNER_TAG_SET } from "../marketplace.js";
import {
  isHouse, normName, safeTrunc, PRIVACY_URL,
  type GuildChannelLike, type GuildLike, type OpsDeps,
} from "./shared.js";

// ── Channel ops ──────────────────────────────────────────────────────────────
// The wanted layout mirrors the live hub server. Matching is name-only after
// NFKC+lowercase normalization (channel names may carry emoji, categories may
// be styled) — a mis-parented channel is adopted, never duplicated.

export const WANTED_LAYOUT: Array<{
  category: string;
  /** readOnly: true/"member" denies typing for the Member role at the category
   *  level (synced children inherit); "everyone" instead writes @everyone
   *  ViewChannel-allow + typing denies — a category the unverified can read
   *  but nobody posts in. */
  readOnly?: boolean | "member" | "everyone";
  /** Channel readOnly: "member" (default when true) denies the Member role;
   *  "everyone" denies @everyone — for channels the unverified can see (lobby,
   *  and #faqs: the channel overwrite allows ViewChannel where the category
   *  denies it); "openthreads" is "everyone" except SendMessagesInThreads is
   *  allowed — private ticket threads stay typeable by their members while
   *  the channel itself stays silent; "staff" is "everyone" plus send-access
   *  for the Mod/Admin
   *  roles. `hidden` is the inverse: @everyone loses ViewChannel on that
   *  channel — used to keep select channels gated inside a visible category.
   *  `staffModerate` layers staff ManageThreads onto a channel — for
   *  private-thread surfaces (#support-ticket) where staff must see + join
   *  threads they aren't members of. `true` grants all house staff roles; a
   *  string[] narrows the grant (unlisted staff roles get the bits revoked).
   *  `memberThreads` lets the Member role SEND inside threads while every
   *  create stays denied — #adoptees, where adopters chat in private
   *  threads only the bot opens. `memberPosts` is the forum version —
   *  Members can create + reply to posts (pair it with `hidden` to gate the
   *  board behind verify). `forumTags` seeds/merges the taxonomy by name —
   *  the same set partner deployments get — so a bot-created forum never
   *  ends up tagless (badges and creator picks silently no-op without it). */
  channels: Array<{ name: string; type: ChannelType; readOnly?: true | "member" | "everyone" | "openthreads" | "staff"; hidden?: true; staffModerate?: true | string[]; memberThreads?: true; memberPosts?: true; forumTags?: ReadonlyArray<{ name: string; moderated: boolean }> }>;
}> = [
  {
    category: "SYSTEM",
    channels: [
      { name: "welcome", type: ChannelType.GuildText, readOnly: "everyone" },
      { name: "announcements", type: ChannelType.GuildAnnouncement, readOnly: true },
      // rules + log-in are lobby channels everyone can read but nobody posts
      // in — a writable gate channel buries the verify card under chatter,
      // and the card reconcile only scans the last 20 messages.
      { name: "rules", type: ChannelType.GuildText, readOnly: "everyone" },
      { name: "log-in", type: ChannelType.GuildText, readOnly: "everyone" }, // the verify gate lives here
      { name: "updates", type: ChannelType.GuildText, readOnly: true },
      { name: "events", type: ChannelType.GuildText, readOnly: true },
      // Staff-posted billboard — everyone reads, Mods/Admins write.
      { name: "characterly-web", type: ChannelType.GuildText, readOnly: "staff" },
    ],
  },
  {
    category: "characterly marketplace",
    channels: [
      { name: "characters", type: ChannelType.GuildForum, forumTags: PARTNER_TAG_SET },
      // Adopted companions' private chat threads — gated until verify
      // (hidden: @everyone loses ViewChannel; the memberThreads grant keeps
      // verified Members viewing + typing inside bot-opened threads).
      { name: "adoptees", type: ChannelType.GuildText, hidden: true, staffModerate: ["Admin"], memberThreads: true },
    ],
  },
  {
    // Visible pre-verify — the shelf tour prospective members read before
    // linking. get-companionly + how-to-publish-bots stay gated (post-verify).
    category: "RESOURCES",
    readOnly: "everyone",
    channels: [
      { name: "what-is-characterly", type: ChannelType.GuildText },
      { name: "what-is-companionly", type: ChannelType.GuildText },
      { name: "get-companionly", type: ChannelType.GuildText, hidden: true },
      { name: "privacy-policy", type: ChannelType.GuildText },
      { name: "how-to-publish-bots", type: ChannelType.GuildText, hidden: true },
    ],
  },
  {
    category: "HELP",
    readOnly: true,
    channels: [
      { name: "faqs", type: ChannelType.GuildText, readOnly: "everyone" },
      // The ticket desk — visible pre-verify so "can't log in" cases can
      // still reach staff; the panel card is the only thing in it since
      // @everyone can't post or create threads. Conversation lives in
      // private threads: openers type via the openthreads send-allow (thread
      // membership already hides everyone else's tickets).
      { name: "support-ticket", type: ChannelType.GuildText, readOnly: "openthreads", staffModerate: true },
      // The suggestion board — a forum hidden until verify; Members post,
      // reply, and vote, staff pin/close. Gallery view so screenshot
      // attachments render as covers.
      { name: "suggest-a-feature", type: ChannelType.GuildForum, hidden: true, memberPosts: true, staffModerate: true },
    ],
  },
  {
    category: "SERVICES",
    channels: [
      { name: "admins-chat", type: ChannelType.GuildText },
      { name: "mods-chat", type: ChannelType.GuildText },
    ],
  },
];

/** Typing perms denied on read-only surfaces — messages, thread replies, and
 *  forum-post/thread creation. ViewChannel stays allowed. */
const READONLY_DENY_BITS = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
] as const;
const READONLY_DENY_PERMS = {
  SendMessages: false,
  SendMessagesInThreads: false,
  CreatePublicThreads: false,
  CreatePrivateThreads: false,
};

export function permHas(perms: unknown, bit: bigint): boolean {
  if (typeof perms === "bigint") return (perms & bit) === bit;
  const d = perms as { has?(b: bigint): boolean } | null | undefined;
  return typeof d?.has === "function" && d.has(bit);
}

/** Normalize a permissionOverwrites cache to overwrite objects — discord.js
 *  Collections iterate [id, overwrite] tuples, test fakes pass bare arrays. */
function overwriteEntries(overwrites: GuildChannelLike["permissionOverwrites"]): Array<{ id: string; allow: unknown; deny: unknown }> {
  return [...(overwrites?.cache ?? [])].map(o => {
    const t = o as unknown[];
    return (Array.isArray(t) ? t[1] : o) as { id: string; allow: unknown; deny: unknown };
  });
}

/** Deny a role's typing perms on a channel/category while keeping
 *  ViewChannel. Member-scoped denies leave mods/admins/the bot posting —
 *  member-facing announcements go through the bot (`/ops announce`) anyway.
 *  @everyone-scoped denies are for lobby channels the unverified can see;
 *  there only Administrator holders (the bot, admin role) can still post. */
async function ensureReadOnly(ch: GuildChannelLike, created: string[], label: string, roleId: string | undefined): Promise<void> {
  const overwrites = ch.permissionOverwrites;
  if (!roleId || typeof overwrites?.edit !== "function") return;
  const cur = overwriteEntries(overwrites).find(o => o.id === roleId);
  // Requires the ViewChannel allow too — a deny-all overwrite (e.g. a synced
  // category's @everyone hide) must still get ViewChannel written, or a
  // "everyone" readOnly channel stays invisible instead of visible-silent.
  if (cur && READONLY_DENY_BITS.every(b => permHas(cur.deny, b)) && permHas(cur.allow, PermissionFlagsBits.ViewChannel)) return;
  await overwrites.edit(roleId, { ViewChannel: true, ...READONLY_DENY_PERMS })
    .then(() => { created.push(`🔒 ${label}`); })
    .catch(() => {});
}

/** "openthreads" read-only — the ticket desk. @everyone reads the channel and
 *  can't post or open threads, but SendMessagesInThreads stays allowed so the
 *  opener (and staff) can actually talk inside the private ticket thread —
 *  thread membership is already the visibility gate, so nothing else leaks. */
export async function ensureOpenThreads(ch: GuildChannelLike, created: string[], label: string, roleId: string | undefined): Promise<void> {
  const overwrites = ch.permissionOverwrites;
  if (!roleId || typeof overwrites?.edit !== "function") return;
  const cur = overwriteEntries(overwrites).find(o => o.id === roleId);
  const denyBits = READONLY_DENY_BITS.filter(b => b !== PermissionFlagsBits.SendMessagesInThreads);
  if (cur && denyBits.every(b => permHas(cur.deny, b))
    && permHas(cur.allow, PermissionFlagsBits.ViewChannel)
    && permHas(cur.allow, PermissionFlagsBits.SendMessagesInThreads)) return;
  await overwrites.edit(roleId, {
    ViewChannel: true,
    SendMessagesInThreads: true,
    SendMessages: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
  }).then(() => { created.push(`🎫 ${label}`); })
    .catch(() => {});
}

/** Inverse of ensureReadOnly for visible categories: deny @everyone
 *  ViewChannel (+ typing — an invisible channel can't be posted in anyway,
 *  and it stays silent if a stray allow ever re-exposes it). */
async function ensureHiddenFromEveryone(ch: GuildChannelLike, created: string[], label: string, roleId: string | undefined): Promise<void> {
  const overwrites = ch.permissionOverwrites;
  if (!roleId || typeof overwrites?.edit !== "function") return;
  const cur = overwriteEntries(overwrites).find(o => o.id === roleId);
  if (cur && permHas(cur.deny, PermissionFlagsBits.ViewChannel)
    && READONLY_DENY_BITS.every(b => permHas(cur.deny, b))) return;
  await overwrites.edit(roleId, { ViewChannel: false, ...READONLY_DENY_PERMS })
    .then(() => { created.push(`🙈 ${label}`); })
    .catch(() => {});
}

/** "Staff" surface — everyone reads, only Mod/Admin write: @everyone gets the
 *  visible-silent overwrite, then each staff role (looked up by name — the
 *  house's are canonical) gets an explicit send allow that overrides the deny. */
async function ensureStaffOnly(ch: GuildChannelLike, created: string[], label: string, guild: GuildLike): Promise<void> {
  await ensureReadOnly(ch, created, label, guild.id);
  const overwrites = ch.permissionOverwrites;
  if (typeof overwrites?.edit !== "function") return;
  for (const name of ["Mod", "Admin"]) {
    const role = guild.roles?.cache?.find(r => normName(r.name) === normName(name));
    if (!role) continue;
    const cur = overwriteEntries(overwrites).find(o => o.id === role.id);
    if (cur && permHas(cur.allow, PermissionFlagsBits.SendMessages)) continue;
    await overwrites.edit(role.id, { ViewChannel: true, SendMessages: true, SendMessagesInThreads: true })
      .then(() => { created.push(`✍️ ${label} → ${name}`); })
      .catch(() => {});
  }
}

/** Member gets SendMessagesInThreads on a thread-surface — adopters chat
 *  inside their own private threads. CreatePrivateThreads stays denied
 *  everywhere, so the bot is the only thread opener and every thread maps
 *  back to a registered adoption. */
async function ensureMemberThreadChat(ch: GuildChannelLike, created: string[], label: string, roleId: string | undefined): Promise<void> {
  const overwrites = ch.permissionOverwrites;
  if (!roleId || typeof overwrites?.edit !== "function") return;
  const cur = overwriteEntries(overwrites).find(o => o.id === roleId);
  if (cur && permHas(cur.allow, PermissionFlagsBits.SendMessagesInThreads)
    && permHas(cur.deny, PermissionFlagsBits.CreatePrivateThreads)) return;
  await overwrites.edit(roleId, {
    ViewChannel: true,
    SendMessagesInThreads: true,
    SendMessages: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
  }).then(() => { created.push(`🗨 ${label} → Member threads`); })
    .catch(() => {});
}

/** Forum surface the Member role fully uses: verified members create posts,
 *  reply inside them, and react — while `hidden` keeps @everyone out.
 *  CreatePublicThreads is allowed because in a forum, posts ARE threads;
 *  only private threads stay denied. Every bit is written explicitly so the
 *  overwrite converges even if a stale typing-deny (e.g. an inherited
 *  readOnly-member sync) is sitting on the role. */
async function ensureMemberPosts(ch: GuildChannelLike, created: string[], label: string, roleId: string | undefined): Promise<void> {
  const overwrites = ch.permissionOverwrites;
  if (!roleId || typeof overwrites?.edit !== "function") return;
  const cur = overwriteEntries(overwrites).find(o => o.id === roleId);
  if (cur
    && permHas(cur.allow, PermissionFlagsBits.ViewChannel)
    && permHas(cur.allow, PermissionFlagsBits.SendMessages)
    && permHas(cur.allow, PermissionFlagsBits.SendMessagesInThreads)
    && permHas(cur.allow, PermissionFlagsBits.CreatePublicThreads)
    && permHas(cur.deny, PermissionFlagsBits.CreatePrivateThreads)) return;
  await overwrites.edit(roleId, {
    ViewChannel: true,
    SendMessages: true,
    SendMessagesInThreads: true,
    CreatePublicThreads: true,
    CreatePrivateThreads: false,
  }).then(() => { created.push(`💡 ${label} → Member posts`); })
    .catch(() => {});
}

/** Granted staff roles get ManageThreads on a surface — private threads are
 *  only visible to members + ManageThreads holders, and the house roles may
 *  not carry the perm guild-wide. SendMessagesInThreads lets staff reply
 *  once joined; ViewChannel is already covered but cheap to restate. House
 *  staff roles NOT in grantNames get the managed bits denied — a convergent
 *  revoke, so narrowing a surface's grant list actually narrows it on the
 *  next reconcile (an explicit deny also wins over later stray allows). */
const HOUSE_STAFF_ROLES = ["Mod", "Admin"] as const;
async function ensureStaffModerate(
  ch: GuildChannelLike, created: string[], label: string, guild: GuildLike,
  grantNames: readonly string[] = HOUSE_STAFF_ROLES,
): Promise<void> {
  const overwrites = ch.permissionOverwrites;
  if (typeof overwrites?.edit !== "function") return;
  for (const name of HOUSE_STAFF_ROLES) {
    const role = guild.roles?.cache?.find(r => normName(r.name) === normName(name));
    if (!role) continue;
    const cur = overwriteEntries(overwrites).find(o => o.id === role.id);
    if (!grantNames.some(n => normName(n) === normName(name))) {
      if (cur && (permHas(cur.allow, PermissionFlagsBits.ManageThreads) || permHas(cur.allow, PermissionFlagsBits.SendMessagesInThreads))) {
        await overwrites.edit(role.id, { ManageThreads: false, SendMessagesInThreads: false })
          .then(() => { created.push(`🔒 ${label} → ${name} thread perms revoked`); })
          .catch(() => {});
      }
      continue;
    }
    if (cur && permHas(cur.allow, PermissionFlagsBits.ManageThreads)) continue;
    await overwrites.edit(role.id, { ViewChannel: true, SendMessagesInThreads: true, ManageThreads: true })
      .then(() => { created.push(`🧵 ${label} → ${name} manages threads`); })
      .catch(() => {});
  }
}

/** Create missing categories + channels by name. Idempotent — returns the
 * names of what it created ([] when the layout is already complete). */
export async function ensureHouseLayout(guild: GuildLike): Promise<string[]> {
  if (!isHouse(guild.id)) return [];
  const created: string[] = [];
  for (const group of WANTED_LAYOUT) {
    let cat = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && normName(c.name) === normName(group.category),
    );
    if (!cat) {
      cat = await guild.channels.create({ name: group.category, type: ChannelType.GuildCategory });
      created.push(`📁 ${group.category}`);
    }
    // Read-only categories get the Member typing deny at the PARENT — synced
    // children inherit it, and writing channel-level overwrites would desync
    // them. Snapshot child sync-state BEFORE mutating the parent (discord.js
    // compares live overwrites, so the flag can flip false post-edit), and run
    // the parent edit before creates so children copy the denied set.
    const syncBefore = new Map<string, boolean>();
    if (group.readOnly) {
      for (const wanted of group.channels) {
        const ch = guild.channels.cache.find(c => normName(c.name) === normName(wanted.name));
        if (ch) syncBefore.set(normName(wanted.name), ch.permissionsLocked === true);
      }
      // "everyone" categories are unverified-readable: @everyone gets
      // ViewChannel + typing denies at the parent — one overwrite covers
      // unverified readers and members alike (no Member send-allow exists
      // anywhere that could override it).
      const readOnlyRoleId = group.readOnly === "everyone" ? guild.id : config.houseMemberRoleId;
      await ensureReadOnly(cat, created, `📁 ${group.category}`, readOnlyRoleId);
    }
    for (const wanted of group.channels) {
      // Prefer a name match whose TYPE matches too — a stale same-named
      // channel (e.g. a text channel later replaced by a forum) must not
      // absorb the reconcile's edits. Falls back to name-only so channels
      // created under an older declaration still reconcile.
      const exists = guild.channels.cache.find(c => normName(c.name) === normName(wanted.name) && c.type === wanted.type)
        ?? guild.channels.cache.find(c => normName(c.name) === normName(wanted.name));
      let target = exists;
      if (!exists) {
        // New channels inherit the category's overwrites — a fresh
        // mods/ops channel must not come up with default (public) perms.
        const overwrites = cat.permissionOverwrites?.cache
          ? overwriteEntries(cat.permissionOverwrites).map(o => ({ id: o.id, allow: o.allow, deny: o.deny }))
          : undefined;
        target = await guild.channels.create({
          name: wanted.name, type: wanted.type, parent: cat.id, permissionOverwrites: overwrites,
          // Forums land Gallery-first with their declared taxonomy — same
          // shape the partner deployment path creates.
          ...(wanted.type === ChannelType.GuildForum ? {
            defaultForumLayout: ForumLayoutType.GalleryView,
            ...(wanted.forumTags?.length ? { availableTags: wanted.forumTags.map(t => ({ name: t.name, moderated: t.moderated })) } : {}),
          } : {}),
        });
        created.push(`#${wanted.name}`);
      } else {
        if (
          wanted.type === ChannelType.GuildForum
          && exists.defaultForumLayout !== ForumLayoutType.GalleryView
          && typeof exists.edit === "function"
        ) {
          // Gallery View is what turns listing-card attachments into covers on
          // the forum's main page — reconcile it like the rest of the layout.
          await exists.edit({ defaultForumLayout: ForumLayoutType.GalleryView })
            .then(() => { created.push(`⚙ ${wanted.name} → gallery view`); })
            .catch(() => {});
        }
        // Declared forum taxonomy — merge missing names (existing tags pass
        // through with their ids; applied tags reference them). Tag names are
        // the contract everywhere tags are consumed.
        if (wanted.type === ChannelType.GuildForum && wanted.forumTags?.length && typeof exists.setAvailableTags === "function") {
          const live = (exists.availableTags ?? []).map(t => ({ id: t.id, name: t.name, moderated: t.moderated ?? false }));
          const missing = wanted.forumTags
            .filter(t => !live.some(e => e.name.toLowerCase() === t.name.toLowerCase()))
            .map(t => ({ name: t.name, moderated: t.moderated }));
          if (missing.length) {
            await exists.setAvailableTags([...live, ...missing])
              .then(() => { created.push(`🏷 #${wanted.name} → tags +${missing.length}`); })
              .catch(() => {});
          }
        }
      }
      // Explicit readOnly channels (mixed parents like SYSTEM) and children
      // that weren't synced to a readOnly parent need their own deny.
      // "everyone" targets the @everyone role — its id is the guild id.
      if (target && wanted.readOnly === "staff") {
        await ensureStaffOnly(target, created, `#${wanted.name}`, guild);
      } else if (target && wanted.readOnly === "openthreads") {
        await ensureOpenThreads(target, created, `#${wanted.name}`, guild.id);
        // Members need the same open-threads grant — a leftover Member deny
        // (from an older readOnly-member layout) would override the
        // @everyone allow and silence verified ticket openers.
        await ensureOpenThreads(target, created, `#${wanted.name} · Member`, config.houseMemberRoleId);
      } else if (target && (wanted.readOnly || (group.readOnly === true && syncBefore.get(normName(wanted.name)) !== true))) {
        const roleId = wanted.readOnly === "everyone" ? guild.id : config.houseMemberRoleId;
        await ensureReadOnly(target, created, `#${wanted.name}`, roleId);
      }
      // `hidden` overrides a visible category: the channel gets its own
      // @everyone ViewChannel deny (desyncing it), so it stays gated until
      // the Member role lands while its siblings stay readable.
      if (target && wanted.hidden) await ensureHiddenFromEveryone(target, created, `#${wanted.name}`, guild.id);
      if (target && wanted.staffModerate) await ensureStaffModerate(target, created, `#${wanted.name}`, guild, wanted.staffModerate === true ? undefined : wanted.staffModerate);
      if (target && wanted.memberThreads) await ensureMemberThreadChat(target, created, `#${wanted.name}`, config.houseMemberRoleId);
      if (target && wanted.memberPosts) await ensureMemberPosts(target, created, `#${wanted.name}`, config.houseMemberRoleId);
    }
  }
  return created;
}

// ── Server guide ─────────────────────────────────────────────────────────────
// Discord's "Server Guide" page is the guild onboarding object: featured
// channels (default_channel_ids) plus join prompts whose options surface
// channels. Reconciled like the rest of the house layout — /ops guide applies
// this declared spec. Channels resolve by NAME so a rebuilt channel doesn't
// need an id update; verify-gated channels (get-companionly et al.) are
// featured deliberately — the guide doubles as the "verify to unlock" teaser.
// `enabled: true` + Advanced mode is what turns the guide on.

const GUIDE_FEATURED_CHANNELS = [
  "welcome", "log-in", "get-companionly", "characters", "the-hub", "what-is-characterly",
];

const GUIDE_DESCRIPTION =
  "AI companions with a memory you can actually inspect. " +
  "Bring your character card, meet them in your DMs, then hang out in the server.";

export const GUIDE_PROMPT = {
  title: "What brings you to Characterly?",
  singleSelect: true,
  required: false,
  inOnboarding: true,
  type: GuildOnboardingPromptType.MultipleChoice,
  options: [
    { emoji: "🌙", title: "Meet a companion", description: "Your own — it lives in your DMs", channels: ["get-companionly", "what-is-characterly"] },
    { emoji: "🛒", title: "Browse the shelf", description: "The community marketplace", channels: ["characters"] },
    { emoji: "🛠️", title: "Publish companions", description: "Build your own and list them", channels: ["how-to-publish-bots", "characters"] },
    { emoji: "🍸", title: "Just hanging out", description: "The social channels", channels: ["the-hub", "sitting at a bar"] },
  ],
};

export interface GuideOutcome {
  featuredCount: number;
  optionCount: number;
  missing: string[];
  described: boolean;
}

/** Apply the house Server Guide — featured channels, the join prompt, and the
 *  guild description — with every channel name resolved live against the
 *  guild cache. Idempotent: the onboarding PATCH is declarative, so re-runs
 *  re-assert the same spec. Unresolvable names are reported, not fatal. */
export async function applyServerGuide(guild: GuildLike): Promise<GuideOutcome> {
  if (typeof guild.editOnboarding !== "function") throw new Error("guild can't edit onboarding");
  const missing = new Set<string>();
  const idsOf = (names: string[]) => names.flatMap(n => {
    const c = guild.channels.cache.find(ch => normName(ch.name) === normName(n));
    if (!c?.id) { missing.add(n); return []; }
    return [c.id];
  });
  const featuredIds = idsOf(GUIDE_FEATURED_CHANNELS);
  await guild.editOnboarding({
    defaultChannels: featuredIds,
    prompts: [{ ...GUIDE_PROMPT, options: GUIDE_PROMPT.options.map(o => ({ ...o, channels: idsOf(o.channels) })) }],
    enabled: true,
    mode: GuildOnboardingMode.OnboardingAdvanced,
    reason: "house server guide via /ops guide",
  });
  const described = await guild.setDescription?.(GUIDE_DESCRIPTION).then(() => true).catch(() => false) ?? false;
  return { featuredCount: featuredIds.length, optionCount: GUIDE_PROMPT.options.length, missing: [...missing], described };
}

// ── Resource posts ───────────────────────────────────────────────────────────
// Static explainer embeds — mostly RESOURCES channels, plus #adoptees' pinned
// orientation post. Every post's footer carries
// `Char.ly resources · <channel> · vN` — the reconcile keeps exactly
// one marked message per channel: extras are deleted, a stale version is
// edited in place (no repost spam), and a missing one is posted fresh.

const RESOURCE_MARKER = "Char.ly resources";

function markedEmbeds(post: { channel: string; version: number; embeds(): EmbedBuilder[] }): ReturnType<EmbedBuilder["toJSON"]>[] {
  return post.embeds().map(e =>
    e.setFooter({ text: `${RESOURCE_MARKER} · ${post.channel} · v${post.version}` }).toJSON());
}

export const RESOURCE_POSTS: Array<{ channel: string; version: number; embeds(): EmbedBuilder[] }> = [
  {
    channel: "what-is-characterly",
    version: 2,
    embeds: () => [new EmbedBuilder()
      .setTitle("What is Characterly?")
      .setDescription(
        "Characterly is a marketplace of AI companions that lives inside Discord.\n\n" +
        `Browse **#characters**, pick someone you like, and hit **Add** — they get their own private thread under **#adoptees** just for the two of you, and you can summon them into your servers too. Every companion keeps its own private memory of *you*, so your version of a character is yours alone.\n\n` +
        "**For everyone**\n" +
        "• Browse a gallery of characters — cover art, genre tags, ratings, and community picks\n" +
        "• One click to adopt — a private thread opens for the two of you in **#adoptees**\n" +
        "• Ratings and comments keep the shelf honest\n\n" +
        "**For creators**\n" +
        "• Publish your own characters — your name stays on the card\n" +
        "• Up to 3 genre tags, a gallery cover, an editable persona\n" +
        "• Reports, flags, and staff review keep the shelf clean",
      )],
  },
  {
    channel: "what-is-companionly",
    version: 2,
    embeds: () => [new EmbedBuilder()
      .setTitle("What is Companionly?")
      .setDescription(
        "Companionly is *your* companion — not picked off a shelf, but awakened by you.\n\n" +
        "DM me and we'll have a short conversation about who they should be. They wake up with a name, a voice, and a bond that starts with you — and from then on they're permanent and yours.\n\n" +
        "• **Awakened, not adopted** — their personality comes from your first conversation\n" +
        "• **Lives in your DMs** — talk anytime; they remember your history together\n" +
        "• **Bring them anywhere** — summon them into servers running Characterly\n" +
        "• **One per account** — a bond, not a collection\n" +
        "• **Publishable** — `/companion publish` puts them on the shelf as a character others can adopt",
      )],
  },
  {
    channel: "get-companionly",
    version: 2,
    embeds: () => [new EmbedBuilder()
      .setTitle("Get Companionly")
      .setDescription(
        "Everything starts in DMs — here's the five-minute path.\n\n" +
        `**1. Verify** — click **Verify** in ${config.houseVerifyChannelId ? `<#${config.houseVerifyChannelId}>` : "**#log-in**"}. It links your free Characterly account (that's what moderation and your data controls hang off) and unlocks the server.\n` +
        "**2. Say hi** — DM me and talk. The first conversation awakens your Companion.\n" +
        `**3. Browse the shelf** — ${config.marketplaceChannelId ? `<#${config.marketplaceChannelId}>` : "**#characters**"} is the marketplace. **Add** any character you want alongside yours.\n` +
        "**4. Bring them to a server** — where the bot's installed, `/companion summon` pulls them into the channel.\n" +
        "**5. Publish** — `/companion publish` or `/companion create` when you have a character worth sharing.",
      )],
  },
  {
    channel: "privacy-policy",
    version: 6,
    embeds: () => [new EmbedBuilder()
      .setTitle("Privacy — the short version")
      .setDescription(
        (config.siteUrl
          ? `The full policy is at [${config.siteUrl.replace(/\/+$/, "").replace(/^https?:\/\//, "")}/privacy](${PRIVACY_URL}). `
          : "") +
        "The day-to-day version:\n\n" +
        "• **Servers see nothing until enabled** — no messages are archived until a server admin runs `/server resume`\n" +
        "• **Personal memory is opt-in** — derived facts, profile attributes, and relationship notes only exist for members who run `/profile-build` or `/opt-in`\n" +
        "• **Retention is bounded** — raw messages are held 30 days, then permanently deleted\n" +
        "• **Companion memory is yours** — your bond memories stay private to you and never leak into servers or other users' companions\n" +
        "• **Story stays with the story** — companions keep a running recap of your chat plus *story facts* scoped to themselves; roleplay never becomes a real fact about you and never reaches your other companions\n" +
        "• **Your facts don't travel unless you say so** — a companion's private DM digest to its owner carries server lore and the owner's own data only; facts about you cross only if you enable `/memory share-facts`\n" +
        "• **Adoptee chats are private, not staff-blind** — companions you adopt chat in private `#adoptees` threads; unlike DMs, Discord private threads are also visible to server admins (safety + support only, no automod inside — mods can't see them)\n" +
        "• **You hold the delete key** — `/opt-out` wipes derived data, `/memory forget` removes one memory, `/memory remember` pins one, `/companion story` edits the recap, `/memory export` shows everything held — and the dashboard's memory panel does the same on the web\n" +
        "• **Removing the bot wipes the server** — every row it stored there goes with it",
      )],
  },
  {
    channel: "how-to-publish-bots",
    version: 2,
    embeds: () => [new EmbedBuilder()
      .setTitle("Publish a character")
      .setDescription(
        "Two ways onto the shelf:\n\n" +
        "**`/companion publish`** — publish your awakened companion as a character others can adopt. The modal takes a display name, tagline, greeting, and an optional cover image URL — the cover becomes its gallery art.\n\n" +
        "**`/companion create`** — author a character from scratch, no awakened companion needed.\n\n" +
        "**After it's live**\n" +
        "• **Edit persona** on the card — voice, traits, bond, backstory\n" +
        "• **Cover image** on the card — set or clear the gallery art anytime\n" +
        "• **Tags** on the card — up to 3 genre tags so browsers find it\n" +
        "• Adopters get independent copies — their memories and journals are theirs; your card keeps your name\n\n" +
        "**The rules** — keep it SFW. Personas are screened on publish; listings can be flagged and moderators can delist. A linked account is required so creators own what they ship.",
      )],
  },
  {
    channel: "adoptees",
    version: 2,
    embeds: () => [new EmbedBuilder()
      .setTitle("Where your adopted companions live")
      .setDescription(
        "Every character you adopt from **#characters** gets a private thread right here — only you, them, and our Admin team can see it.\n\n" +
        "**How the chats work**\n" +
        "• Talk normally — it's a real conversation. Your companion keeps a private memory of *you*, so they always pick up where you left off.\n" +
        "• One thread per adoption — adopt another character, get another thread.\n" +
        "• Thread privacy is enforced by Discord, not just politeness — other members can't see yours at all.\n\n" +
        "**Useful commands**\n" +
        "• `/companion list` — your roster (adopted + your awakened companion)\n" +
        "• `/companion homes` — jump back into a companion's thread\n" +
        "• `/companion summon` — bring one along to other servers with the bot\n" +
        "• `/companion drop` — release one (12h cooldown before re-adopting the same character)",
      )],
  },
  {
    channel: "faqs",
    version: 4,
    embeds: () => [
      new EmbedBuilder()
        .setTitle("Getting started")
        .setDescription(
          "**How do I get a companion?**\n" +
          "DM me and just talk — that first conversation awakens your personal companion, with a name, a voice, and a bond that's yours. Or grab someone off the shelf: hit **Add** on any listing in " + (config.marketplaceChannelId ? `<#${config.marketplaceChannelId}>` : "**#characters**") + ".\n\n" +
          "**Why did Add tell me to verify first?**\n" +
          `Adopting needs a linked Characterly account — it's what ties your companions, tokens, and data controls to you. Click **Verify** in ${config.houseVerifyChannelId ? `<#${config.houseVerifyChannelId}>` : "**#log-in**"}, it takes about 30 seconds, then come back and Add away.\n\n` +
          "**Do I have to pay?**\n" +
          "Nope — every account gets **30 free tokens a day**, no card, no setup. If you start running out, **Premium ($7.99/mo)** makes them present — memory writes live instead of on the hour, they can look things up mid-reply, they answer first when it's busy — plus 150 tokens a day, unlimited adoptions, and token packs in the dashboard. (Tinkerers can plug in their own API key with `/companion key`, but you never need to.)\n\n" +
          "**How many companions can I have?**\n" +
          "One awakened companion — that bond is permanent. On top of that, free accounts keep one adopted character at a time; Premium removes the cap.\n\n" +
          "**Where do they hang out?**\n" +
          "In your DMs, always. To bring one into a server where I'm installed, run `/companion summon` — they'll chat with everyone there, not just you.",
        ),
      new EmbedBuilder()
        .setTitle("Characters & the marketplace")
        .setDescription(
          "**Can I make my own character?**\n" +
          "Three ways: `/companion publish` turns your awakened companion into a listing, `/companion create` builds one from scratch, and `/companion import` pulls in a character card file you already have.\n\n" +
          "**How do I edit a listing?**\n" +
          "Right on its card — the buttons let you rewrite the persona, swap the cover art (that's the pretty picture in gallery view), and tag up to 3 genres so browsers can find it.\n\n" +
          "**Why is a companion ignoring me?**\n" +
          "A few possibilities: an admin may have quieted the channel (`/server quiet` silences them but they still observe), paused companions server-wide, or ignored the channel entirely — or you're out of tokens. The dashboard shows your balance.\n\n" +
          "**What do the stars and comments do?**\n" +
          "They keep the shelf honest — rate the ones you've adopted, comment on the listing thread, and the good ones bubble up as **Top Rated**. Report anything off and staff takes a look.\n\n" +
          "**What happens if I drop one?**\n" +
          "Dropping frees your adoption slot but starts a **12-hour cooldown** before you can re-adopt that same character — so don't rage-quit on a bad day.",
        ),
      new EmbedBuilder()
        .setTitle("Privacy & your account")
        .setDescription(
          "**Can it read my messages?**\n" +
          "Only where admins allow it. Servers see nothing until someone runs `/server resume`, facts about *you* only form after you opt in (`/profile-build` or `/opt-in`), and raw messages are deleted after 30 days anyway.\n\n" +
          "**Who sees my companion's memories?**\n" +
          "Just you. Whatever your companion learns in your DMs or your private **#adoptees** thread stays scoped to that conversation — it never leaks into servers or to other people's versions of the same character.\n\n" +
          "**How do I delete my data?**\n" +
          "`/opt-out` wipes everything derived about you, `/memory forget` removes one specific memory, and the dashboard's Delete section closes the whole account if you want a clean break.\n\n" +
          "**Something broken?**\n" +
          "**#support-ticket** gets a human. Got an idea instead? **#suggest-a-feature** — we actually read it.",
        ),
    ],
  },
  {
    channel: "characterly-web",
    version: 3,
    embeds: () => [new EmbedBuilder()
      .setTitle("Characterly on the web")
      .setDescription(
        `Everything your account does lives at **[${config.siteUrl.replace(/\/+$/, "").replace(/^https?:\/\//, "")}](${config.siteUrl})** —\n\n` +
        "• **Dashboard** — token balance, Premium, token packs\n" +
        "• **What X remembers** — every memory, journal entry, and story recap your companion holds, with pin / edit / forget controls\n" +
        "• **Imports** — upload a character card or a chat transcript and your companion becomes them / remembers it\n" +
        "• **Settings** — memory preferences, consent, your linked Discord\n" +
        "• **Delete** — your data, gone on request\n\n" +
        "Your Discord ↔ web link is what ties it together — `/link` in my DMs if you haven't yet.",
      )],
  },
];

/** Reconcile the RESOURCES explainer posts — one marked message per channel,
 *  stale versions edited in place, extras deleted, missing posted. Returns
 *  what it did ([] when everything's current). */
export async function ensureResourcePosts(deps: OpsDeps, guild: GuildLike): Promise<string[]> {
  if (!isHouse(guild.id) || !deps.botId) return [];
  const out: string[] = [];
  for (const post of RESOURCE_POSTS) {
    const found = guild.channels.cache.find(c => normName(c.name) === normName(post.channel));
    if (!found) continue;
    const ch = await deps.fetchChannel(found.id).catch(() => null);
    if (!ch) continue;
    const markerRe = new RegExp(`${RESOURCE_MARKER} · ${post.channel} · v(\\d+)`);
    const recent = await ch.messages?.fetch({ limit: 20 }).catch(() => null);
    let kept = false;
    if (recent) {
      for (const entry of recent) {
        const m = (Array.isArray(entry) ? entry[1] : entry) as {
          author?: { id?: string }; embeds?: unknown[];
          edit?(o: { embeds: unknown[] }): Promise<unknown>; delete?(): Promise<unknown>;
        };
        if (m.author?.id !== deps.botId) continue;
        const match = JSON.stringify(m.embeds ?? []).match(markerRe);
        if (!match) continue;
        if (kept) { await m.delete?.().catch(() => {}); continue; }
        kept = true;
        if (Number(match[1]) < post.version && typeof m.edit === "function") {
          await m.edit({ embeds: markedEmbeds(post) })
            .then(() => { out.push(`✏️ #${post.channel} → v${post.version}`); })
            .catch(() => {});
        }
      }
    }
    if (!kept) {
      const embeds = markedEmbeds(post);
      await ch.send({ embeds, allowedMentions: { parse: [] } })
        .then(() => { out.push(`📝 #${post.channel}`); })
        .catch(() => {});
    }
  }
  return out;
}
