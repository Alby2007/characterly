import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, ChannelType, ChatInputCommandInteraction, EmbedBuilder, ModalBuilder, ModalSubmitInteraction, PermissionFlagsBits, TextInputBuilder, TextInputStyle, type TextChannel } from "discord.js";
import type { Brain } from "./brain.js";
import { MemoryStore, type Memory } from "./database.js";
import { EventStore } from "./events.js";
import { EventPipeline } from "./event-detection.js";
import { ProfileStore } from "./profiles.js";
import { encryptSecret, logError, maskKey, validateLlmKey } from "./secrets.js";
import { isSafeUrl, resolvesToPrivateAddress } from "./tools.js";
import { detectProviderFromKey, guardedLlmFetch } from "./brains.js";
import { runProfileBuild, PROFILE_BUILD_COOLDOWN_MS } from "./profile-build.js";
import { runServerIngest } from "./server-ingest.js";
import { pauseGuildClaims, resumeGuildClaims, waitForGuildIdle } from "./jobs.js";
import { inc, metricsSnapshot } from "./metrics.js";
import type { Companion, CompanionListing, CompanionSpec, MessageEvent } from "./types.js";
import { config } from "./config.js";

export const ONBOARDING_ARCHETYPES: Record<
  string,
  { label: string; prompt: string; allowImmediateComplete?: boolean }
> = {
  surprise: {
    label: "Surprise Me",
    prompt:
      "Surprise me with a complete companion draft! Invent a memorable name, a distinct voice and vibe, core traits, and a fun dynamic for us so I can review it before locking it in.",
    allowImmediateComplete: false,
  },
  co_conspirator: {
    label: "Chaotic Co-Conspirator",
    prompt:
      "I want a chaotic co-conspirator vibe — sharp, witty, a little mischievous, always down to scheme with me. Suggest a fitting name and lock in the vibe.",
  },
  deadpan: {
    label: "Dry & Deadpan",
    prompt:
      "I want a dry, deadpan, observant best friend — understated humor, zero fluff, sees right through me. Suggest a fitting name and lock in the vibe.",
  },
  ride_or_die: {
    label: "Ride-or-Die Hype",
    prompt:
      "I want a warm, ride-or-die hype friend — fiercely loyal, high energy, always in my corner. Suggest a fitting name and lock in the vibe.",
  },
};

export function buildOnboardingWelcomePayload(userId: string) {
  const embed = new EmbedBuilder()
    .setTitle("Awaken Your Personal Companion")
    .setDescription(
      "Tell me who you want me to be in your own words — or pick a starting archetype below and we'll customize from there.\n\n" +
        "**One Companion Per Account (Permanent):** Take your time shaping your draft. Once you awaken your companion, their identity is **permanently locked** to your account.",
    )
    .addFields(
      {
        name: "1. Name & Vibe",
        value:
          "What should we call me, and how do I talk? *(e.g. dry & deadpan, chaotic co-conspirator, blunt roaster)*",
      },
      {
        name: "2. Our Dynamic",
        value:
          "What's our bond? *(e.g. ride-or-die best friend, scheming partner-in-crime, protective sibling energy)*",
      },
      {
        name: "3. Avatar (Optional)",
        value:
          "Attach an image in this DM anytime to give me a face, or use `/companion action:avatar` later.",
      },
    )
    .setFooter({
      text: "One character per account — freely tweak your draft before awakening!",
    });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`onboard:preset:surprise:${userId}`)
      .setLabel("Surprise Me")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`onboard:preset:co_conspirator:${userId}`)
      .setLabel("Chaotic Co-Conspirator")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`onboard:preset:deadpan:${userId}`)
      .setLabel("Dry & Deadpan")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`onboard:preset:ride_or_die:${userId}`)
      .setLabel("Ride-or-Die")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`onboard:edit:${userId}`)
      .setLabel("Fill Form Instead")
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

export function buildOnboardingDraftEmbed(spec: Partial<CompanionSpec>, turnCount: number): EmbedBuilder {
  const isReady = Boolean(spec.name?.trim() && spec.voicePersona?.trim() && spec.ownerDynamic?.trim());
  const embed = new EmbedBuilder()
    .setTitle(spec.name?.trim() ? `Companion Draft — ${spec.name.trim()}` : `Companion Draft (Step ${turnCount + 1})`)
    .setDescription(
      isReady
        ? "All core details are drafted! Keep replying (or click **Edit Draft**) to tweak anything. When you're completely happy, click **Awaken & Lock In** — **each account gets one permanent companion, and awakening cannot be undone.**"
        : "Reply in chat to fill in or tweak any detail before locking in your permanent companion.",
    )
    .addFields(
      { name: "Name", value: spec.name?.trim() || "*(tell me a name or ask me to pick)*", inline: true },
      { name: "Bond / Dynamic", value: spec.ownerDynamic?.trim() || "*(tell me our dynamic)*", inline: true },
      { name: "Voice & Vibe", value: spec.voicePersona?.trim() || "*(tell me how I should talk)*", inline: false },
      {
        name: "Core Traits",
        value: spec.coreTraits?.length ? spec.coreTraits.join(", ") : "*(forming...)*",
        inline: false,
      },
    )
    .setFooter({
      text: spec.avatarUrl
        ? "Avatar attached · Permanent once awakened (1 companion per account)"
        : "Tip: Attach an image to set an avatar · Permanent once awakened (1 companion per account)",
    });
  if (spec.backstory?.trim()) {
    embed.addFields({ name: "Backstory", value: spec.backstory.trim(), inline: false });
  }
  if (spec.avatarUrl) embed.setThumbnail(spec.avatarUrl);
  return embed;
}

export function buildOnboardingDraftComponents(
  userId: string,
  spec: Partial<CompanionSpec>,
): ActionRowBuilder<ButtonBuilder> {
  const isReady = Boolean(spec.name?.trim() && spec.voicePersona?.trim() && spec.ownerDynamic?.trim());
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (isReady) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`onboard:awaken:${userId}`)
        .setLabel(`Awaken & Lock In ${(spec.name ?? "Companion").trim().slice(0, 16)}`)
        .setStyle(ButtonStyle.Success),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`onboard:edit:${userId}`)
      .setLabel("Edit Draft")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`onboard:preset:surprise:${userId}`)
      .setLabel("Surprise Draft")
      .setStyle(ButtonStyle.Primary),
  );
  return row;
}

export function buildAwakenedCompanionPayload(
  companion: Companion,
  ownerName: string,
  mutualGuilds: Array<{ id: string; name: string }> = [],
) {
  const embed = new EmbedBuilder()
    .setTitle(`${companion.name} — Awakened & Locked In`)
    .setDescription(
      `**${companion.name}** is now permanently bound to your account! Keep chatting right here in DMs, or summon them into a server.\n\n` +
        (companion.backstory ? `${companion.backstory}\n\n` : "") +
        `*Use \`/companion action:summon\` in any server to bring them into the hangout, or \`/companion action:avatar\` to update their avatar.*`,
    )
    .addFields(
      { name: "Voice & Vibe", value: companion.voicePersona || "—", inline: false },
      { name: "Core Traits", value: companion.coreTraits.length ? companion.coreTraits.join(", ") : "—", inline: true },
      { name: `Bond with ${ownerName}`, value: companion.ownerDynamic || "—", inline: true },
    )
    .setFooter({ text: "Permanently bound to your account (1 companion per account)" });
  if (companion.avatarUrl) embed.setThumbnail(companion.avatarUrl);

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (mutualGuilds.length > 0) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const g of mutualGuilds.slice(0, 3)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`onboard:summon:${g.id}:${companion.ownerUserId}`)
          .setLabel(`Summon to ${g.name.slice(0, 22)}`)
          .setStyle(ButtonStyle.Primary),
      );
    }
    components.push(row);
  }
  return { embeds: [embed], components };
}

export async function sendCompanionSystemMessage(
  channelOrGuild: unknown,
  companion: Companion,
  ownerName: string,
  event: "joined" | "left",
): Promise<boolean> {
  if (!channelOrGuild || typeof channelOrGuild !== "object") return false;
  let sendFn: ((payload: unknown) => Promise<unknown>) | undefined;
  const candidate = channelOrGuild as {
    send?: (payload: unknown) => Promise<unknown>;
    systemChannel?: { send?: (payload: unknown) => Promise<unknown> };
  };
  // A channel is used directly; a bare Guild falls back to its system channel
  // only — picking an arbitrary cached text channel could announce a companion
  // in a private channel the owner can't see, which is worse than silence.
  if (typeof candidate.send === "function") {
    sendFn = candidate.send.bind(candidate);
  } else if (typeof candidate.systemChannel?.send === "function") {
    sendFn = candidate.systemChannel.send.bind(candidate.systemChannel);
  }
  if (!sendFn) return false;

  if (event === "left") {
    const embed = new EmbedBuilder()
      .setTitle(`System · ${companion.name} left the chat`)
      .setDescription(`**${companion.name}** (${ownerName}'s companion) has stepped out of this server.`);
    if (companion.avatarUrl) embed.setThumbnail(companion.avatarUrl);
    try { await sendFn({ embeds: [embed], allowedMentions: { parse: [] } }); return true; }
    catch { return false; }
  }

  const embed = new EmbedBuilder()
    .setTitle(`System · ${companion.name} joined the chat`)
    .setDescription(
      `**${companion.name}** (${ownerName}'s companion) is now hanging out in this server.\n\n` +
        `**Vibe:** ${companion.voicePersona || "Observant and candid"}\n` +
        `**Traits:** ${companion.coreTraits.length ? companion.coreTraits.join(", ") : "—"}\n` +
        `**Bond with ${ownerName}:** ${companion.ownerDynamic || "Close confidant"}`,
    )
    .setFooter({ text: `Say "${companion.name}" in chat to talk to them, or awaken your own companion below.` });
  if (companion.avatarUrl) embed.setThumbnail(companion.avatarUrl);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("onboard:start")
      .setLabel("Awaken Your Own Companion")
      .setStyle(ButtonStyle.Primary),
  );
  try { await sendFn({ embeds: [embed], components: [row], allowedMentions: { parse: [] } }); return true; }
  catch { return false; }
}

export function findMutualGuilds(
  client: { guilds?: { cache?: Iterable<[string, any]> | Map<string, any> } } | undefined,
  userId: string,
): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  const cache = client?.guilds?.cache;
  if (!cache || typeof (cache as any).values !== "function") return out;
  for (const g of (cache as Map<string, any>).values()) {
    if (g?.ownerId === userId || g?.members?.cache?.has?.(userId)) {
      out.push({ id: g.id, name: g.name ?? g.id });
    }
  }
  return out;
}

export function buildApiKeyOnboardingPayload(userId: string) {
  const embed = new EmbedBuilder()
    .setTitle("Connect Your Personal AI Key")
    .setDescription(
      "Your companion runs on your own AI key across DMs and every Characterly server you summon them into.\n\n" +
        "**Just paste your API key — leave the Base URL field completely blank and Characterly will auto-detect everything and work fine!**",
    )
    .addFields(
      {
        name: "1. Get a Free Key (30 seconds)",
        value:
          "Grab a free key at **[console.groq.com/keys](https://console.groq.com/keys)** (starts with `gsk_...`), or use OpenRouter (`sk-or-...`), OpenAI (`sk-...`), or xAI (`xai-...`).",
      },
      {
        name: "2. Paste & Go (Leave Base URL Blank)",
        value:
          "Click **Paste API Key** below, paste your key into the first box, and **leave the Base URL field blank** — provider and model are configured automatically.",
      },
    )
    .setFooter({
      text: "Your key is encrypted with AES-256-GCM and powers your personal companion everywhere.",
    });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`onboard:key:${userId}`)
      .setLabel("Paste API Key")
      .setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

export function buildUserApiKeyModal(customId: "user-key" | "setup-key" = "user-key"): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle("Connect Your AI Key");
  const keyInput = new TextInputBuilder()
    .setCustomId("api-key")
    .setLabel("API Key (Groq, OpenRouter, OpenAI, or xAI)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(200)
    .setPlaceholder("gsk_… or sk-or-… or sk-…");
  const urlInput = new TextInputBuilder()
    .setCustomId("base-url")
    .setLabel("Base URL (Leave blank — auto-detected!)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(200)
    .setPlaceholder("Leave blank! Everything works automatically.");
  const modelInput = new TextInputBuilder()
    .setCustomId("model")
    .setLabel("Model (blank = provider default)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(120)
    .setPlaceholder("e.g. llama-3.3-70b — required for custom endpoints");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(keyInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(urlInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(modelInput),
  );
  return modal;
}

export function buildCompanionEditModal(existing: Companion | null): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId("companion-edit")
    .setTitle("Awaken & Lock In Companion");

  const nameInput = new TextInputBuilder()
    .setCustomId("companion-name")
    .setLabel("Companion Name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(64)
    .setPlaceholder("e.g. Nyx, Kael, Echo");
  if (existing?.name) nameInput.setValue(existing.name.slice(0, 64));

  const vibeInput = new TextInputBuilder()
    .setCustomId("voice-persona")
    .setLabel("Voice & Vibe (how they talk and act)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(500)
    .setPlaceholder("e.g. Dry, deadpan, sharp humor, observant and unbothered");
  if (existing?.voicePersona) vibeInput.setValue(existing.voicePersona.slice(0, 500));

  const traitsInput = new TextInputBuilder()
    .setCustomId("core-traits")
    .setLabel("Core Traits (comma-separated)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(200)
    .setPlaceholder("e.g. deadpan, loyal, perceptive, chaotic");
  if (existing?.coreTraits?.length) traitsInput.setValue(existing.coreTraits.join(", ").slice(0, 200));

  const dynamicInput = new TextInputBuilder()
    .setCustomId("owner-dynamic")
    .setLabel("Dynamic / Bond with You")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(300)
    .setPlaceholder("e.g. Chaotic co-conspirator and ride-or-die best friend");
  if (existing?.ownerDynamic) dynamicInput.setValue(existing.ownerDynamic.slice(0, 300));

  const backstoryInput = new TextInputBuilder()
    .setCustomId("backstory")
    .setLabel("Backstory / Lore (optional)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(600)
    .setPlaceholder("Any background details or shared lore");
  if (existing?.backstory) backstoryInput.setValue(existing.backstory.slice(0, 600));

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(vibeInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(traitsInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(dynamicInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(backstoryInput),
  );
  return modal;
}

// ── Marketplace ──────────────────────────────────────────────────────────────

export function buildPublishModal(companion: Companion, listing: CompanionListing | null): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`market_publish:${companion.id}`)
    .setTitle(listing ? "Update Marketplace Listing" : "Publish to Marketplace");

  const nameInput = new TextInputBuilder()
    .setCustomId("listing-name")
    .setLabel("Display name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(64)
    .setValue((listing?.name || companion.name).slice(0, 64));
  const taglineInput = new TextInputBuilder()
    .setCustomId("listing-tagline")
    .setLabel("Tagline (shown on the listing card)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(120)
    .setPlaceholder("e.g. A vampire who remembers every reader");
  if (listing?.tagline) taglineInput.setValue(listing.tagline.slice(0, 120));
  const greetingInput = new TextInputBuilder()
    .setCustomId("listing-greeting")
    .setLabel("Greeting — first DM the character sends")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000)
    .setPlaceholder("The character opens the conversation, in their voice");
  if (listing?.greeting) greetingInput.setValue(listing.greeting.slice(0, 1000));

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(taglineInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(greetingInput),
  );
  return modal;
}

export function buildMarketPersonaModal(listing: CompanionListing): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`market_edit:${listing.id}`)
    .setTitle("Edit Listing Persona");
  const nameInput = new TextInputBuilder()
    .setCustomId("companion-name").setLabel("Name").setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(64).setValue(listing.name.slice(0, 64));
  const vibeInput = new TextInputBuilder()
    .setCustomId("voice-persona").setLabel("Voice & Vibe").setStyle(TextInputStyle.Paragraph)
    .setRequired(true).setMaxLength(500).setValue(listing.voicePersona.slice(0, 500));
  const traitsInput = new TextInputBuilder()
    .setCustomId("core-traits").setLabel("Core Traits (comma-separated)").setStyle(TextInputStyle.Short)
    .setRequired(false).setMaxLength(200).setValue(listing.coreTraits.join(", ").slice(0, 200));
  const dynamicInput = new TextInputBuilder()
    .setCustomId("owner-dynamic").setLabel("Bond with adopter").setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(300).setValue(listing.ownerDynamic.slice(0, 300));
  const backstoryInput = new TextInputBuilder()
    .setCustomId("backstory").setLabel("Backstory / Lore").setStyle(TextInputStyle.Paragraph)
    .setRequired(false).setMaxLength(600).setValue(listing.backstory.slice(0, 600));
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(vibeInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(traitsInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(dynamicInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(backstoryInput),
  );
  return modal;
}

export function buildListingCard(listing: CompanionListing, creatorName: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(listing.name)
    .setDescription(listing.tagline || "A companion up for adoption")
    .addFields(
      { name: "Voice & Vibe", value: listing.voicePersona || "—" },
      { name: "Traits", value: listing.coreTraits.length ? listing.coreTraits.join(", ") : "—", inline: true },
      { name: "Adopted by", value: `${listing.addCount} user${listing.addCount === 1 ? "" : "s"}`, inline: true },
    )
    .setFooter({ text: `by ${creatorName} · Characterly Marketplace · v${listing.version}` });
  if (listing.avatarUrl) embed.setThumbnail(listing.avatarUrl);
  return embed;
}

export function buildListingComponents(listingId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`market:add:${listingId}`).setLabel("Add to your companions").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`market:report:${listingId}`).setLabel("Report").setStyle(ButtonStyle.Secondary),
  );
}

export function buildCreateModal(): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId("market_create")
    .setTitle("Create a Marketplace Character");
  const nameInput = new TextInputBuilder()
    .setCustomId("listing-name").setLabel("Name").setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(64).setPlaceholder("e.g. Count Dracula, Moth, Nyx");
  const taglineInput = new TextInputBuilder()
    .setCustomId("listing-tagline").setLabel("Tagline (shown on the listing card)").setStyle(TextInputStyle.Short)
    .setRequired(true).setMaxLength(120).setPlaceholder("e.g. A vampire who remembers every reader");
  const greetingInput = new TextInputBuilder()
    .setCustomId("listing-greeting").setLabel("Greeting — first DM they send").setStyle(TextInputStyle.Paragraph)
    .setRequired(true).setMaxLength(1000).setPlaceholder("The character opens the conversation, in their voice");
  const vibeInput = new TextInputBuilder()
    .setCustomId("listing-voice").setLabel("Voice & Vibe").setStyle(TextInputStyle.Paragraph)
    .setRequired(true).setMaxLength(500).setPlaceholder("e.g. Archaic, theatrical, quietly menacing but oddly polite");
  const backstoryInput = new TextInputBuilder()
    .setCustomId("listing-backstory").setLabel("Backstory / Lore (optional)").setStyle(TextInputStyle.Paragraph)
    .setRequired(false).setMaxLength(600).setPlaceholder("Any background or lore");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(taglineInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(greetingInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(vibeInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(backstoryInput),
  );
  return modal;
}

/** The caller's live-listing ceiling: premium and the unmetered self-host
 *  lane are uncapped, everyone else gets FREE_LISTING_SLOTS. */
function listingCapFor(store: MemoryStore, account: { plan: string } | null): number {
  return !store.creditsSupported || account?.plan === "premium"
    ? Number.MAX_SAFE_INTEGER
    : config.freeListingSlots;
}

const LISTING_CAP_MSG = `You can run **${config.freeListingSlots} live listing${config.freeListingSlots === 1 ? "" : "s"}** on the free plan — \`/companion action:unpublish\` one first, or go Premium for unlimited: ${config.siteUrl}/dashboard#billing`;

/** Returns an error message if the user is at their live-listing cap, else
 *  null. Advisory UX check only — the store methods enforce the cap
 *  atomically at write time. */
async function listingSlotError(
  store: MemoryStore,
  userId: string,
  account: { plan: string } | null,
): Promise<string | null> {
  const count = await store.activeListingCount(userId);
  if (count < listingCapFor(store, account)) return null;
  return LISTING_CAP_MSG;
}

/** Create the forum thread + listing card the bot owns (both publish paths,
 *  plus relist). Returns the new thread id, or null on failure — the caller
 *  decides whether to roll the listing row back. */
async function postListingThread(
  interaction: { client: ChatInputCommandInteraction["client"]; user: { username?: string; globalName?: string | null } },
  listing: CompanionListing,
): Promise<string | null> {
  const channel = await interaction.client.channels.fetch(config.marketplaceChannelId!).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildForum) return null;
  const creatorName = interaction.user.globalName ?? interaction.user.username ?? "a creator";
  const thread = await channel.threads.create({
    name: `${listing.name} — ${listing.tagline}`.slice(0, 100),
    message: {
      embeds: [buildListingCard(listing, creatorName)],
      components: [buildListingComponents(listing.id)],
    },
  }).catch(() => null);
  return thread?.id ?? null;
}

async function unlistListing(interaction: ChatInputCommandInteraction | ButtonInteraction, listing: CompanionListing, store: MemoryStore) {
  const delisted = await store.delistListing(listing.id);
  if (!delisted) {
    const refused = listing.status === "flagged"
      ? `**${listing.name}** is flagged for moderation review — it stays listed until a mod clears the flag.`
      : `**${listing.name}** is already off the marketplace.`;
    if (typeof (interaction as ButtonInteraction).isButton === "function" && (interaction as ButtonInteraction).isButton()) {
      return (interaction as ButtonInteraction).update({ content: refused, components: [] });
    }
    return interaction.reply({ content: refused, ephemeral: true });
  }
  if (listing.forumThreadId && config.marketplaceChannelId) {
    const channel = await interaction.client.channels.fetch(config.marketplaceChannelId).catch(() => null);
    const thread = channel && channel.type === ChannelType.GuildForum
      ? await channel.threads.fetch(listing.forumThreadId).catch(() => null)
      : null;
    if (thread) await thread.setLocked(true).then(() => thread.setArchived(true)).catch(() => {});
  }
  const content = `**${listing.name}** has been removed from the marketplace. Bring it back anytime with \`/companion action:relist\`.`;
  if (typeof (interaction as ButtonInteraction).isButton === "function" && (interaction as ButtonInteraction).isButton()) {
    return (interaction as ButtonInteraction).update({ content, components: [] });
  }
  return interaction.reply({ content, ephemeral: true });
}

/** Revive a delisted listing (cap-checked atomically in the store) and post
 *  a fresh forum card — the old thread stays archived. On thread failure the
 *  revive is rolled back to delisted, matching the publish paths. */
async function doRelist(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  listing: CompanionListing,
  store: MemoryStore,
  account: { plan: string } | null,
) {
  const isButton = typeof (interaction as ButtonInteraction).isButton === "function" && (interaction as ButtonInteraction).isButton();
  const reply = (content: string) =>
    isButton ? (interaction as ButtonInteraction).update({ content, components: [] }) : interaction.reply({ content, ephemeral: true });

  const res = await store.relistListing(listing.id, interaction.user.id, listingCapFor(store, account));
  if (!res.ok) {
    const msg =
      res.reason === "cap" ? LISTING_CAP_MSG
        : res.reason === "not_delisted" ? `**${listing.name}** isn't unpublished — nothing to bring back.`
        : "That listing isn't yours to relist.";
    return reply(msg);
  }
  const threadId = await postListingThread(interaction, res.listing);
  if (!threadId) {
    await store.delistListing(res.listing.id);
    return reply("I couldn't create the forum post — check my permissions in the marketplace channel.");
  }
  await store.setListingThread(res.listing.id, threadId);
  inc("market.relisted");
  return reply(`**${res.listing.name}** is back on the shelf in <#${config.marketplaceChannelId}>!`);
}

/** DM the adopted companion's greeting; returns whether it actually landed —
 *  server summoning unlocks only on a successful send. */
export async function sendAdoptionGreeting(user: { createDM(): Promise<{ send(o: object): Promise<unknown> }> }, companion: Companion, greeting: string): Promise<boolean> {
  try {
    const dm = await user.createDM();
    const embed = new EmbedBuilder()
      .setTitle(companion.name)
      .setDescription(greeting || `*${companion.name} joins you.*`);
    if (companion.avatarUrl) embed.setThumbnail(companion.avatarUrl);
    await dm.send({ embeds: [embed] });
    return true;
  } catch {
    return false;
  }
}

export async function summonPickedCompanion(interaction: ChatInputCommandInteraction | ButtonInteraction, companion: Companion, store: MemoryStore) {
  if (!interaction.guildId) {
    return interaction.reply({ content: "That can only be done inside a Discord server.", ephemeral: true });
  }
  // Mocks in tests may not implement isButton — treat absence as a command.
  const isButton = typeof (interaction as ButtonInteraction).isButton === "function" && (interaction as ButtonInteraction).isButton();
  if (companion.kind === "adopted") {
    const adoption = await store.adoptionForCompanion(companion.id);
    if (adoption && !adoption.dmIntroducedAt) {
      const msg =
        `**${companion.name}** hasn't introduced themselves yet — open your DMs with me and they'll say hello. ` +
        `After that first introduction you can summon them into servers.`;
      if (isButton) return (interaction as ButtonInteraction).update({ content: msg, components: [] });
      return interaction.reply({ content: msg, ephemeral: true });
    }
  }
  await store.summonCompanion(interaction.guildId, companion.id, interaction.user.id, interaction.user.username);
  await sendCompanionSystemMessage(
    (interaction as { channel?: unknown }).channel ?? (interaction as { guild?: unknown }).guild,
    companion,
    interaction.user.username,
    "joined",
  );
  const embed = new EmbedBuilder()
    .setTitle(`${companion.name} joined the server`)
    .setDescription(
      `**${companion.name}** (${interaction.user.username}'s companion) is now hanging out in this server.\n\n` +
      `**Vibe:** ${companion.voicePersona || "Observant and candid"}\n` +
      `**Traits:** ${companion.coreTraits.length ? companion.coreTraits.join(", ") : "—"}\n` +
      `**Bond with ${interaction.user.username}:** ${companion.ownerDynamic || "Close confidant"}`,
    );
  if (companion.avatarUrl) embed.setThumbnail(companion.avatarUrl);
  if (isButton) return (interaction as ButtonInteraction).update({ content: "Summoned.", embeds: [embed], components: [] });
  return interaction.reply({ ephemeral: true, embeds: [embed] });
}

export async function dismissPickedCompanion(interaction: ChatInputCommandInteraction | ButtonInteraction, companion: Companion, store: MemoryStore) {
  if (!interaction.guildId) {
    return interaction.reply({ content: "That can only be done inside a Discord server.", ephemeral: true });
  }
  const removed = await store.dismissCompanion(interaction.guildId, companion.id);
  if (removed) {
    await sendCompanionSystemMessage(
      (interaction as { channel?: unknown }).channel ?? (interaction as { guild?: unknown }).guild,
      companion,
      interaction.user.username,
      "left",
    );
  }
  const content = removed
    ? `**${companion.name}** has stepped out of this server. You can bring them back anytime with \`/companion action:summon\`.`
    : `**${companion.name}** wasn't active in this server.`;
  if (typeof (interaction as ButtonInteraction).isButton === "function" && (interaction as ButtonInteraction).isButton()) {
    return (interaction as ButtonInteraction).update({ content, components: [] });
  }
  return interaction.reply({ content, ephemeral: true });
}

async function promptUnawakenedCompanion(
  interaction: { user: { id: string; username: string; send?: (payload: any) => Promise<any> }; reply: (payload: any) => Promise<any> },
  prefixText: string,
  brainFor?: BrainFor,
) {
  const hasBrain = brainFor ? Boolean(await brainFor(`dm:${interaction.user.id}`)) : true;
  let dmUrl: string | undefined;
  if (typeof interaction.user.send === "function") {
    try {
      const dmPayload = hasBrain
        ? buildOnboardingWelcomePayload(interaction.user.id)
        : buildApiKeyOnboardingPayload(interaction.user.id);
      const sent = await interaction.user.send(dmPayload);
      if (sent?.channelId) dmUrl = `https://discord.com/channels/@me/${sent.channelId}`;
    } catch {
      /* User has DMs closed or blocked — fall back to inline buttons */
    }
  }
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (!hasBrain) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`onboard:key:${interaction.user.id}`)
        .setLabel("Paste API Key")
        .setStyle(ButtonStyle.Primary),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`onboard:edit:${interaction.user.id}`)
      .setLabel("Create via Form")
      .setStyle(hasBrain ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`onboard:preset:surprise:${interaction.user.id}`)
      .setLabel("Surprise Me")
      .setStyle(ButtonStyle.Secondary),
  );
  const dmHint = dmUrl
    ? `I just sent you a starter DM (${dmUrl}) — head there to shape your companion, or use the buttons below. *(Note: Each account gets one permanent companion — once awakened, their character is locked in!)*`
    : "Send me a direct message (DM) to shape your companion through conversation, or use the buttons below. *(Note: Each account gets one permanent companion — once awakened, their character is locked in!)*";
  return interaction.reply({
    content: `${prefixText} ${dmHint}`,
    components: [row],
    ephemeral: true,
  });
}

export const commandDefinitions = [
  { name: "memory", description: "View remembered information", options: [
    { name: "about", description: "Member to inspect", type: 6, required: false }, { name: "search", description: "Search your memories", type: 3, required: false },
    { name: "page", description: "Page number", type: 4, required: false }, { name: "server", description: "Show server lore", type: 5, required: false },
    { name: "stats", description: "Show server memory statistics", type: 5, required: false }, { name: "memory_id", description: "Show provenance for a memory", type: 4, required: false },
    { name: "candidates", description: "Show unconfirmed candidate memories", type: 5, required: false }
  ] },
  { name: "forget", description: "Request deletion of one of your memories", options: [{ name: "memory_id", description: "The memory number", type: 4, required: true }] },
  { name: "correct", description: "Correct or update something remembered about you", options: [{ name: "statement", description: "For example: I don't support Arsenal anymore", type: 3, required: true }] },
  { name: "memory-confirm", description: "Confirm one of your candidate memories", options: [{ name: "memory_id", description: "The candidate memory number", type: 4, required: true }] },
  { name: "memory-export", description: "Download all memory stored about you" },
  { name: "memory-purge", description: "Admin: delete old raw messages for this server", default_member_permissions: PermissionFlagsBits.ManageGuild.toString(), options: [{ name: "older_than_days", description: "Delete messages older than this many days", type: 4, required: true }] },
  { name: "memory-pause", description: "Admin: immediately pause Characterly in this server", default_member_permissions: PermissionFlagsBits.ManageGuild.toString() },
  { name: "memory-resume", description: "Admin: enable or resume Characterly in this server", default_member_permissions: PermissionFlagsBits.ManageGuild.toString() },
  { name: "memory-settings", description: "Admin: view server memory and retention settings", default_member_permissions: PermissionFlagsBits.ManageGuild.toString() },
  { name: "status", description: "Admin: server status, active companions, and operational counters", default_member_permissions: PermissionFlagsBits.ManageGuild.toString() },
  { name: "memory-triage", description: "Admin: the most recent memories stored for any member", default_member_permissions: PermissionFlagsBits.ManageGuild.toString() },
  { name: "event", description: "Inspect the event linked to one of your memories", options: [
    { name: "memory_id", description: "A memory number returned by /memory", type: 4, required: true }
  ] },
  { name: "profile", description: "View a member's synthesized profile card", options: [
    { name: "user", description: "Member to inspect (admins can view anyone)", type: 6, required: false }
  ] },
  { name: "dossier", description: "View a member's detailed profile dossier", options: [
    { name: "user", description: "Member to inspect (admins can view anyone)", type: 6, required: false }
  ] },
  { name: "privacy", description: "See what Characterly stores in this server and your consent state" },
  { name: "opt-out", description: "Stop Characterly forming memories or a profile about you, and forget what it already holds" },
  { name: "opt-in", description: "Consent to memories and a profile about you — then run /profile-build to scan your history" },
  { name: "profile-build", description: "Opt in and build your profile: scans the archive for your messages and references to you" },
  { name: "server-build", description: "Admin: run the server-level historical build on a channel", default_member_permissions: PermissionFlagsBits.ManageGuild.toString(), options: [
    { name: "channel", description: "Text channel to build from (defaults to the configured ingest channel)", type: 7, required: false }
  ] },
  { name: "limits", description: "Admin: set this server's daily LLM-call cap", default_member_permissions: PermissionFlagsBits.ManageGuild.toString(), options: [
    { name: "daily_cap", description: "Max LLM calls per day, 0–100000 — 0 blocks all calls (resets at midnight UTC)", type: 4, required: true }
  ] },
  { name: "ignore-channel", description: "Admin: make Characterly fully ignore a channel — no archive, no replies", default_member_permissions: PermissionFlagsBits.ManageGuild.toString(), options: [
    { name: "channel", description: "Channel to ignore", type: 7, required: true }
  ] },
  { name: "unignore-channel", description: "Admin: restore a channel Characterly was ignoring", default_member_permissions: PermissionFlagsBits.ManageGuild.toString(), options: [
    { name: "channel", description: "Channel to restore", type: 7, required: true }
  ] },
  { name: "companion", description: "Manage your personal AI companion and summon them into servers", options: [
    { name: "action", description: "Companion action", type: 3, required: true, choices: [
      { name: "card — View a companion's profile card", value: "card" },
      { name: "list — See all companions active in this server", value: "list" },
      { name: "summon — Bring your companion into this server", value: "summon" },
      { name: "dismiss — Dismiss your companion from this server", value: "dismiss" },
      { name: "kick — Admin: remove a member's companion from this server", value: "kick" },
      { name: "key — Connect or update your personal AI API key", value: "key" },
      { name: "status — Check your personal API key, DM usage, and active servers", value: "status" },
      { name: "avatar — Set your companion's avatar URL", value: "avatar" },
      { name: "publish — List your companion in the hub server's marketplace", value: "publish" },
      { name: "create — Author an extra marketplace character (counts toward listing slots)", value: "create" },
      { name: "unpublish — Remove your companion from the marketplace", value: "unpublish" },
      { name: "relist — Bring back an unpublished listing", value: "relist" },
      { name: "switch — Choose which companion answers in your DMs", value: "switch" },
      { name: "drop — Give up an adopted companion (12h re-adopt cooldown)", value: "drop" },
    ] },
    { name: "avatar_url", description: "Public http(s) image URL when action is avatar", type: 3, required: false },
    { name: "user", description: "Member whose companion to inspect (card) or remove (kick)", type: 6, required: false }
  ] },
  // In a server this is the guild-scope key (admin only); in DMs it stores the
  // user's personal key — the same modal backs both paths.
  { name: "setup", description: "Connect an AI API key — server key for admins here, your personal key in DMs", default_member_permissions: PermissionFlagsBits.ManageGuild.toString() },
  { name: "link", description: "Get a one-time code to link this Discord account to your Characterly web account" }
];

const confidence = (value: number | undefined) => {
  if (value === undefined) return "Unknown";
  return value >= .8 ? "High" : value >= .55 ? "Medium" : "Low";
};
const OPT_IN_HINT_SELF = "You haven't opted in yet — run /profile-build to consent and build your profile.";
const OPT_IN_HINT_OTHER = "That member hasn't opted in to profiles.";
/** One server build at a time — the routine is heavy and its archive marks are
 * not re-entrant across overlapping runs. */
let serverBuildRunning = false;
/** One profile build per member at a time — claimed synchronously before any
 * await so a double-invoke can't slip past the check and double the LLM spend. */
const profileBuildsRunning = new Set<string>();
const display = (memory: Memory) => `**#${memory.id} · ${confidence(memory.confidence)} confidence**\n${memory.content}\n*${memory.mentions} confirmation${memory.mentions === 1 ? "" : "s"}; last confirmed ${new Date(memory.lastConfirmedAt).toLocaleDateString()}*`;

type BrainFor = (guildId: string) => Promise<Brain | null>;
const NO_KEY_MSG = "No AI key is configured yet — connect your personal API key with `/companion action:key` (or `/setup`).";

const SERVER_ONLY_COMMANDS = new Set([
  "memory-purge", "memory-pause", "memory-resume", "memory-settings",
  "status", "memory-triage", "server-build",
  "limits", "ignore-channel", "unignore-channel",
]);

export async function handleMemoryCommand(interaction: ChatInputCommandInteraction, store: MemoryStore, brainFor: BrainFor, evStore?: EventStore, profileStore: ProfileStore = new ProfileStore()) {
  if (!interaction.guildId && SERVER_ONLY_COMMANDS.has(interaction.commandName)) {
    return interaction.reply({ content: "That command can only be used inside a Discord server.", ephemeral: true });
  }
  const guildId = interaction.guildId ?? `dm:${interaction.user.id}`;
  if (interaction.commandName === "link") {
    const code = await store.createLinkCode(interaction.user.id);
    return interaction.reply({
      ephemeral: true,
      content:
        `**Link code:** \`${code}\`\n\n` +
        `Enter it on your Characterly account page: ${config.siteUrl}/dashboard\n` +
        `It expires in 10 minutes and only you can see this message.`
    });
  }
  // Link gate: hosted-lane actions (summon puts a companion on the hosted
  // reply path; profile-build runs a hosted LLM scan) need a linked account.
  // Everything else — reads, privacy/data, admin, key entry — stays open.
  const gatedAction =
    interaction.commandName === "profile-build" ||
    (interaction.commandName === "companion" && interaction.options.getString("action") === "summon");
  if (gatedAction && store.creditsSupported) {
    // BYOK is exempt — a personal key means their lane never spends tokens.
    const [account, ownKey] = await Promise.all([
      store.accountForDiscordUser(interaction.user.id).catch(() => null),
      store.getGuildKey(`dm:${interaction.user.id}`).catch(() => null),
    ]);
    if (!account && !ownKey) {
      return interaction.reply({
        ephemeral: true,
        content:
          `This action needs a linked Characterly account — create one free at ${config.siteUrl} ` +
          `and run \`/link\` here to connect it. Takes about a minute.`,
      });
    }
  }
  if (interaction.commandName === "companion") {
    const action = interaction.options.getString("action", true);
    if (action === "summon") {
      if (!interaction.guildId) {
        return interaction.reply({ content: "Run `/companion action:summon` inside the Discord server where you want to bring your companion.", ephemeral: true });
      }
      const roster = await store.listCompanionsForUser(interaction.user.id);
      const active = roster.filter(c => c.onboardingState === "active");
      if (!active.length) {
        return promptUnawakenedCompanion(
          interaction,
          "You haven't awakened your companion yet!",
          brainFor,
        );
      }
      if (active.length === 1) return summonPickedCompanion(interaction, active[0], store);
      const buttons = active.slice(0, 5).map((c, i) =>
        new ButtonBuilder()
          .setCustomId(`market:summon:${c.id}`)
          .setLabel(c.name || `Companion ${i + 1}`)
          .setStyle(ButtonStyle.Primary),
      );
      return interaction.reply({
        ephemeral: true,
        content: "Which companion do you want to summon here?",
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)],
      });
    }
    if (action === "dismiss") {
      if (!interaction.guildId) {
        return interaction.reply({ content: "Run `/companion action:dismiss` inside the Discord server you want your companion to leave.", ephemeral: true });
      }
      const roster = await store.listCompanionsForUser(interaction.user.id);
      const active = roster.filter(c => c.onboardingState === "active");
      if (!active.length) {
        return interaction.reply({ content: "You don't have a companion to dismiss.", ephemeral: true });
      }
      if (active.length > 1) {
        const buttons = active.slice(0, 5).map((c, i) =>
          new ButtonBuilder()
            .setCustomId(`market:dismiss:${c.id}`)
            .setLabel(c.name || `Companion ${i + 1}`)
            .setStyle(ButtonStyle.Danger),
        );
        return interaction.reply({
          ephemeral: true,
          content: "Which companion should step out of this server?",
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)],
        });
      }
      return dismissPickedCompanion(interaction, active[0], store);
    }
    if (action === "edit" || action === "reset") {
      const existing = await store.getCompanionByOwner(interaction.user.id);
      if (existing?.onboardingState === "active") {
        return interaction.reply({
          content: `Your companion **${existing.name}** is already awakened and permanently locked to your account — each account gets one permanent companion.`,
          ephemeral: true,
        });
      }
      if (action === "edit" && typeof interaction.showModal === "function") {
        return interaction.showModal(buildCompanionEditModal(existing));
      }
      return promptUnawakenedCompanion(
        interaction,
        "You haven't awakened your companion yet!",
        brainFor,
      );
    }
    if (action === "card") {
      const targetUser = interaction.options.getUser("user") ?? interaction.user;
      const companion = await store.getCompanionByOwner(targetUser.id);
      if (!companion || companion.onboardingState !== "active") {
        if (targetUser.id === interaction.user.id) {
          return promptUnawakenedCompanion(
            interaction,
            "You haven't awakened your companion yet!",
            brainFor,
          );
        }
        return interaction.reply({
          content: `${targetUser.username} hasn't awakened a companion yet.`,
          ephemeral: true,
        });
      }
      const compSubj = MemoryStore.companionSubjectId(companion.id);
      const edges = (await store.relationshipsFor(guildId, compSubj)).slice(0, 5);
      const relLines: string[] = [];
      for (const e of edges) {
        if (!e.inferred && e.summary) {
          const otherId = e.subjectId === compSubj ? e.otherId : e.subjectId;
          const otherName = await store.displayNameFor(guildId, otherId);
          relLines.push(`• **${otherName}**: ${e.summary}${e.trend ? ` *(${e.trend})*` : ""}`);
        }
      }
      const embed = new EmbedBuilder()
        .setTitle(`${companion.name} — ${targetUser.username}'s Companion`)
        .setDescription(companion.backstory || companion.voicePersona || "Personal AI companion")
        .addFields(
          { name: "Voice & Vibe", value: companion.voicePersona || "—", inline: false },
          { name: "Core Traits", value: companion.coreTraits.length ? companion.coreTraits.join(", ") : "—", inline: true },
          { name: `Bond with ${targetUser.username}`, value: companion.ownerDynamic || "—", inline: true },
          { name: "Relationships here", value: relLines.length ? relLines.join("\n") : "No established relationships in this scope yet.", inline: false },
        )
        .setFooter({ text: "Permanently bound companion (1 per account)" });
      const roster = await store.listCompanionsForUser(targetUser.id);
      const adopted = roster.filter(c => c.kind === "adopted");
      if (adopted.length) {
        embed.addFields({
          name: "Adopted companions",
          value: adopted.map(c => `• **${c.name}**`).join("\n"),
          inline: false,
        });
      }
      if (companion.avatarUrl) embed.setThumbnail(companion.avatarUrl);
      return interaction.reply({ ephemeral: true, embeds: [embed] });
    }
    if (action === "list") {
      if (!interaction.guildId) {
        return interaction.reply({
          content: "Run `/companion action:list` inside a Discord server to see which companions are hanging out there.",
          ephemeral: true,
        });
      }
      const list = await store.listGuildCompanions(interaction.guildId);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("onboard:start")
          .setLabel("Awaken / Summon Companion")
          .setStyle(ButtonStyle.Primary),
      );
      if (!list.length) {
        const emptyEmbed = new EmbedBuilder()
          .setTitle("Active Companions in This Server")
          .setDescription(
            "No companions are currently summoned in this server.\n\nClick **Awaken / Summon Companion** below (or run `/companion action:summon`) to bring your companion into the hangout!",
          );
        return interaction.reply({ ephemeral: true, embeds: [emptyEmbed], components: [row] });
      }
      const lines = await Promise.all(
        list.map(async c => {
          const ownerName = await store.displayNameFor(interaction.guildId!, c.ownerUserId);
          return `• **${c.name}** (${ownerName}'s companion) — ${c.voicePersona || "Observant and candid"}\n  *Say "${c.name}" in chat to talk to them*`;
        }),
      );
      const listEmbed = new EmbedBuilder()
        .setTitle(`Active Companions (${list.length})`)
        .setDescription(lines.join("\n\n"));
      return interaction.reply({ ephemeral: true, embeds: [listEmbed], components: [row] });
    }
    if (action === "kick") {
      if (!interaction.guildId) {
        return interaction.reply({
          content: "Run `/companion action:kick` inside the Discord server where you want to remove a companion.",
          ephemeral: true,
        });
      }
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: "Only server administrators (`Manage Server`) can kick another member's companion.",
          ephemeral: true,
        });
      }
      const targetUser = interaction.options.getUser("user");
      if (!targetUser) {
        return interaction.reply({
          content: "Specify the companion's owner with `user:@member` to remove their companion from this server.",
          ephemeral: true,
        });
      }
      const roster = await store.listCompanionsForUser(targetUser.id);
      if (!roster.length) {
        return interaction.reply({
          content: `${targetUser.username} doesn't have a companion.`,
          ephemeral: true,
        });
      }
      const removedNames: string[] = [];
      for (const companion of roster) {
        const removed = await store.dismissCompanion(interaction.guildId, companion.id);
        if (removed) {
          removedNames.push(companion.name);
          await sendCompanionSystemMessage(
            (interaction as { channel?: unknown; guild?: unknown }).channel ?? (interaction as { guild?: unknown }).guild,
            companion,
            targetUser.username,
            "left",
          );
        }
      }
      return interaction.reply({
        content: removedNames.length
          ? `Removed ${removedNames.map(n => `**${n}**`).join(", ")} (${targetUser.username}'s companion${removedNames.length > 1 ? "s" : ""}) from this server.`
          : `**${targetUser.username}**'s companions weren't active in this server.`,
        ephemeral: true,
      });
    }
    if (action === "status") {
      const dmScope = `dm:${interaction.user.id}`;
      const [companion, keyRow, dmUsage, account, dmResolved] = await Promise.all([
        store.getCompanionByOwner(interaction.user.id),
        typeof store.getGuildKey === "function" ? store.getGuildKey(dmScope) : Promise.resolve(null),
        typeof store.usageToday === "function" ? store.usageToday(dmScope) : Promise.resolve(0),
        store.creditsSupported ? store.accountForDiscordUser(interaction.user.id).catch(() => null) : Promise.resolve(null),
        store.resolveDmCompanion(interaction.user.id).catch(() => null),
      ]);
      const adoptedRoster = (await store.listCompanionsForUser(interaction.user.id)).filter(c => c.kind === "adopted");
      const dmPointer = dmResolved;
      const guildIds =
        companion && typeof store.listCompanionGuilds === "function"
          ? await store.listCompanionGuilds(companion.id)
          : [];
      const compStatus =
        companion?.onboardingState === "active"
          ? `**${companion.name}** (Awakened & Permanently Locked)`
          : companion
            ? `Draft in progress (${companion.name || "unnamed"})`
            : "Not awakened yet — send me a DM to start!";
      const keyStatus = keyRow
        ? `Connected (\`${keyRow.keyHint}\`)${keyRow.validatedAt ? ` · verified ${new Date(keyRow.validatedAt).toLocaleDateString()}` : " · unverified"}`
        : config.groqKey && !config.requireGuildKeys
          ? "Using operator default key (connect your own anytime with `/companion action:key`)"
          : "No personal key connected — run `/companion action:key` to connect one";
      const serversStatus = guildIds.length
        ? `Summoned in **${guildIds.length}** server${guildIds.length === 1 ? "" : "s"}`
        : "Not currently summoned in any server";
      const statusEmbed = new EmbedBuilder()
        .setTitle("Your Characterly Status")
        .addFields(
          { name: "Companion (1 per Account)", value: compStatus, inline: false },
          {
            name: "Adopted Companions",
            value: adoptedRoster.length
              ? adoptedRoster.map(c => `• **${c.name}**${c.id === dmPointer?.id ? " *(answering DMs)*" : ""}`).join("\n")
              : `None — browse the marketplace${account?.plan === "premium" ? " (unlimited slots)" : ` (${config.freeAdoptionSlots} slot)`}`,
            inline: false,
          },
          { name: "Personal AI Key", value: keyStatus, inline: false },
          { name: "Active Servers", value: serversStatus, inline: true },
          {
            name: "Today's DM Usage",
            value: `${dmUsage.toLocaleString()} / ${config.dmLlmDailyCap.toLocaleString()} calls (resets at UTC midnight)`,
            inline: true,
          },
          ...(store.creditsSupported
            ? [{
                name: "Tokens",
                value: account
                  ? `**${account.creditBalance.toLocaleString()}** on the **${account.plan}** plan — refreshes daily at UTC midnight.${account.plan === "free" && !keyRow ? ` Premium: 150/day, live memory, web tools — ${config.siteUrl}/dashboard#billing` : ` Details: ${config.siteUrl}/dashboard`}`
                  : `Not linked — create an account at ${config.siteUrl} and run \`/link\` to get hosted tokens`,
                inline: false,
              }]
            : []),
        );
      return interaction.reply({ ephemeral: true, embeds: [statusEmbed] });
    }
    if (action === "key") {
      if (!config.keyEncryptionSecret) {
        return interaction.reply({
          content: "The bot operator hasn't configured key storage (KEY_ENCRYPTION_SECRET) — personal keys are unavailable.",
          ephemeral: true,
        });
      }
      if (typeof interaction.showModal !== "function") {
        return interaction.reply({ content: "Setting an API key requires modal support.", ephemeral: true });
      }
      return interaction.showModal(buildUserApiKeyModal("user-key"));
    }
    if (action === "avatar") {
      const url = interaction.options.getString("avatar_url")?.trim();
      if (!url || !isSafeUrl(url) || await resolvesToPrivateAddress(new URL(url).hostname)) {
        return interaction.reply({ content: "Please provide a valid public `http(s)` image URL in `avatar_url`.", ephemeral: true });
      }
      const updated = await store.updateCompanionAvatar(interaction.user.id, url);
      if (!updated) {
        return interaction.reply({ content: "You haven't created a companion yet — send me a DM first!", ephemeral: true });
      }
      return interaction.reply({ content: `Updated **${updated.name || "your companion"}**'s avatar.`, ephemeral: true });
    }
    if (action === "publish") {
      if (!config.marketplaceChannelId) {
        return interaction.reply({ content: "The marketplace isn't configured yet — check back soon.", ephemeral: true });
      }
      const companion = await store.getCompanionByOwner(interaction.user.id);
      if (!companion || companion.onboardingState !== "active") {
        return promptUnawakenedCompanion(interaction, "You need an awakened companion before you can publish them.", brainFor);
      }
      const account = await store.accountForDiscordUser(interaction.user.id).catch(() => null);
      if (!account) {
        return interaction.reply({
          content: `Publishing requires a linked Characterly account — create one at ${config.siteUrl} and run \`/link\` first.`,
          ephemeral: true,
        });
      }
      if (typeof interaction.showModal !== "function") {
        return interaction.reply({ content: "Publishing requires modal support.", ephemeral: true });
      }
      const listing = await store.listingForCompanion(companion.id);
      // A revive (delisted → active) adds a live listing back — only a
      // republish of an already-live listing skips the slot check.
      if (!listing || listing.status === "delisted") {
        const slotError = await listingSlotError(store, interaction.user.id, account);
        if (slotError) return interaction.reply({ content: slotError, ephemeral: true });
      }
      return interaction.showModal(buildPublishModal(companion, listing));
    }
    if (action === "create") {
      if (!config.marketplaceChannelId) {
        return interaction.reply({ content: "The marketplace isn't configured yet — check back soon.", ephemeral: true });
      }
      const account = await store.accountForDiscordUser(interaction.user.id).catch(() => null);
      if (!account) {
        return interaction.reply({
          content: `Creating marketplace characters requires a linked Characterly account — create one at ${config.siteUrl} and run \`/link\` first.`,
          ephemeral: true,
        });
      }
      const slotError = await listingSlotError(store, interaction.user.id, account);
      if (slotError) return interaction.reply({ content: slotError, ephemeral: true });
      if (typeof interaction.showModal !== "function") {
        return interaction.reply({ content: "Creating characters requires modal support.", ephemeral: true });
      }
      return interaction.showModal(buildCreateModal());
    }
    if (action === "unpublish") {
      const listings = await store.listMyListings(interaction.user.id);
      if (!listings.length) {
        return interaction.reply({ content: "You don't have any live listings.", ephemeral: true });
      }
      if (listings.length > 1) {
        const buttons = listings.slice(0, 5).map((l, i) =>
          new ButtonBuilder()
            .setCustomId(`market:unlist:${l.id}`)
            .setLabel(l.name || `Listing ${i + 1}`)
            .setStyle(ButtonStyle.Danger),
        );
        return interaction.reply({
          ephemeral: true,
          content: "Which listing do you want to take down?",
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)],
        });
      }
      return unlistListing(interaction, listings[0], store);
    }
    if (action === "relist") {
      if (!config.marketplaceChannelId) {
        return interaction.reply({ content: "The marketplace isn't configured yet — check back soon.", ephemeral: true });
      }
      const account = await store.accountForDiscordUser(interaction.user.id).catch(() => null);
      if (!account) {
        return interaction.reply({
          content: `Relisting requires a linked Characterly account — create one at ${config.siteUrl} and run \`/link\` first.`,
          ephemeral: true,
        });
      }
      const delisted = await store.listDelistedListings(interaction.user.id);
      if (!delisted.length) {
        return interaction.reply({ content: "No unpublished listings to bring back.", ephemeral: true });
      }
      if (delisted.length > 1) {
        const buttons = delisted.slice(0, 5).map((l, i) =>
          new ButtonBuilder()
            .setCustomId(`market:relist:${l.id}`)
            .setLabel(l.name || `Listing ${i + 1}`)
            .setStyle(ButtonStyle.Success),
        );
        return interaction.reply({
          ephemeral: true,
          content: "Which listing do you want back on the shelf?",
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)],
        });
      }
      return doRelist(interaction, delisted[0], store, account);
    }
    if (action === "switch") {
      const roster = await store.listCompanionsForUser(interaction.user.id);
      const active = roster.filter(c => c.onboardingState === "active");
      if (!active.length) {
        return promptUnawakenedCompanion(interaction, "You haven't awakened your companion yet!", brainFor);
      }
      const current = await store.resolveDmCompanion(interaction.user.id);
      const buttons = active.slice(0, 5).map((c, i) =>
        new ButtonBuilder()
          .setCustomId(`market:talk:${c.id}`)
          .setLabel(c.name || `Companion ${i + 1}`)
          .setStyle(c.id === current?.id ? ButtonStyle.Success : ButtonStyle.Primary),
      );
      const rows = [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
      const hasAwakened = active.some(c => c.kind === "awakened");
      // Adopted-only users can't reach awakening through the DM chat path —
      // surface the affordance here so the permanent bond stays discoverable.
      const hint = hasAwakened
        ? ""
        : "\n\nYou haven't awakened a permanent companion yet — that's the one bond that's yours forever.";
      if (!hasAwakened) {
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("onboard:start").setLabel("Awaken your own companion").setStyle(ButtonStyle.Primary),
        ));
      }
      return interaction.reply({
        ephemeral: true,
        content: `Who do you want answering your DMs? (green = current)${hint}`,
        components: rows,
      });
    }
    if (action === "drop") {
      const roster = await store.listCompanionsForUser(interaction.user.id);
      const adopted = roster.filter(c => c.kind === "adopted");
      if (!adopted.length) {
        return interaction.reply({ content: "You haven't adopted any companions — browse the marketplace to find one.", ephemeral: true });
      }
      const buttons = adopted.slice(0, 5).map((c, i) =>
        new ButtonBuilder()
          .setCustomId(`market:drop:${c.id}`)
          .setLabel(c.name || `Companion ${i + 1}`)
          .setStyle(ButtonStyle.Danger),
      );
      return interaction.reply({
        ephemeral: true,
        content: "Drop an adopted companion — you can't re-adopt the same one for 12 hours.",
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)],
      });
    }
  }
  if (interaction.commandName === "privacy") {
    // Public + always ephemeral: the static explainer, plus the dynamic bits
    // the caller is entitled to — this guild's retention, whether it's
    // observing right now, and the caller's own consent state. No admin data.
    const s = await store.settings(guildId, config.rawMessageRetentionDays);
    const member = await store.getMember(guildId, interaction.user.id);
    const brain = await brainFor(guildId);
    const status = !s.memoryEnabled
      ? "**Dormant** — Characterly is not recording messages here (an admin can enable it with `/memory-resume`)."
      : brain
        ? "**Observing** — messages in this server are being archived and analyzed."
        : "**Enabled but no active companion key** — nothing is being recorded until a companion with a connected personal AI key is summoned.";
    const consent = member?.optedOut ? "opted out — nothing derived forms about you"
      : member?.optedIn ? "opted in — derived memories and a profile may form about you"
      : "not opted in — derived memories and a profile only form if you opt in (`/opt-in`, `/profile-build`, or `/companion action:summon`)";
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder()
      .setTitle("What Characterly stores in this server")
      .addFields(
        { name: "Status", value: status },
        { name: "Raw messages", value: `Kept for **${s.rawRetentionDays} days**, then permanently deleted.` },
        { name: "Derived data", value: "Memories, profiles, and relationship notes form **only for members who opt in** — never automatically." },
        { name: "Your consent", value: consent },
        { name: "Processing", value: "Messages are sent to an OpenAI-compatible LLM provider for analysis using each companion owner's personal API key (`/companion action:key`) or the operator's default." },
        { name: "Controls & guarantees", value: "`/opt-out` forgets your memories and deletes your profile, attributes, relationships, stored quotes, and companion journal entries about you · `/memory-export` downloads everything stored about you · **removing Characterly from this server deletes every row it holds here**." },
      )] });
  }
  if (interaction.commandName === "memory") {
    const server = interaction.options.getBoolean("server") ?? false;
    const stats = interaction.options.getBoolean("stats") ?? false;
    if (stats) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can view memory statistics.", ephemeral: true });
      const value = await store.stats(guildId); return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle("Memory statistics").setDescription(`${value.messages.toLocaleString()} raw messages\n${value.memories.toLocaleString()} active memories\n${value.lore.toLocaleString()} server-lore memories`)] });
    }
    const detailId = interaction.options.getInteger("memory_id");
    if (detailId) {
      const memory = await store.getMemory(guildId, detailId);
      const canInspect = memory && (memory.subjectId === interaction.user.id || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
      if (!canInspect || !memory) return interaction.reply({ content: "I couldn't find a memory you are allowed to inspect with that ID.", ephemeral: true });
      const evidence = (await store.evidence(guildId, memory.id)).slice(0, 5);
      const evidenceText = evidence.length ? evidence.map(item => `• "${item.quote.slice(0, 220)}"\n  *Why:* ${item.reason} · ${new Date(item.observedAt).toLocaleDateString()}`).join("\n") : "No evidence has been retained.";
      return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle(`Memory #${memory.id}`).setDescription(`**${memory.content}**\n\nStatus: ${memory.status}\nConfidence: ${confidence(memory.confidence)} (${(memory.confidence ?? 0).toFixed(2)})\nImportance: ${(memory.importance ?? 0).toFixed(2)}\nFirst observed: ${new Date(memory.createdAt).toLocaleDateString()}\nLast confirmed: ${new Date(memory.lastConfirmedAt).toLocaleDateString()}\nConfirmations: ${memory.mentions}\n\n**Evidence**\n${evidenceText}`)] });
    }
    const member = interaction.options.getUser("about");
    if (member && member.id !== interaction.user.id && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "You can only view your own memories.", ephemeral: true });
    const subjectId = server ? "server" : (member?.id ?? interaction.user.id);
    // Derived data is opt-in — nothing exists (or should surface) for a member
    // who never consented.
    if (!server) {
      const subjectMember = await store.getMember(guildId, subjectId);
      if (!subjectMember?.optedIn || subjectMember.optedOut) {
        return interaction.reply({ content: subjectId === interaction.user.id ? OPT_IN_HINT_SELF : OPT_IN_HINT_OTHER, ephemeral: true });
      }
    }
    const candidates = interaction.options.getBoolean("candidates") ?? false;
    const result = await store.listMemories(guildId, subjectId, { search: interaction.options.getString("search") ?? undefined, page: interaction.options.getInteger("page") ?? 1, status: candidates ? "candidate" : undefined });
    const title = candidates ? "Candidate memories awaiting confirmation" : (server ? "What I remember about this server" : `What I remember about ${member?.username ?? interaction.user.username}`);
    const description = result.memories.length ? result.memories.map(display).join("\n\n") : "Nothing active yet.";
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle(`🧠 ${title}`).setDescription(description).setFooter({ text: `Page ${result.page} · ${result.total} ${candidates ? "candidate" : "active"} memories` })] });
  }
  if (interaction.commandName === "forget") {
    const id = interaction.options.getInteger("memory_id", true), memory = await store.getMemory(guildId, id);
    if (!memory || memory.subjectId !== interaction.user.id) return interaction.reply({ content: "I couldn't find one of your memories with that ID.", ephemeral: true });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`forget:${guildId}:${interaction.user.id}:${id}`).setLabel("Forget it").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("forget:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );
    return interaction.reply({ content: `Forget **#${id}**: "${memory.content}"? This removes the curated memory, but not its raw source message.`, components: [row], ephemeral: true });
  }
  if (interaction.commandName === "correct") {
    // /correct writes a memory about the caller directly — same consent gate
    // as every other derived-data path.
    const caller = await store.getMember(guildId, interaction.user.id);
    if (!caller?.optedIn || caller.optedOut) return interaction.reply({ content: OPT_IN_HINT_SELF, ephemeral: true });
    const brain = await brainFor(guildId);
    if (!brain) return interaction.reply({ content: NO_KEY_MSG, ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const existing = await store.allActiveMemories(guildId, interaction.user.id);
      const correction = await brain.correctMemory(interaction.user.id, interaction.options.getString("statement", true), existing);
      correction.replacement.subjectId = interaction.user.id;
      correction.replacement.evidenceType = "correction";
      correction.replacement.effect = "correct";
      const event: MessageEvent = { guildId, channelId: interaction.channelId, messageId: `correction:${interaction.id}`, authorId: interaction.user.id, authorName: interaction.user.username, content: interaction.options.getString("statement", true), createdAt: new Date(), mentionsBot: false };
      const saved = await store.saveMemory(event, correction.replacement);
      await Promise.all(correction.supersedes.filter(id => existing.some(m => m.id === id)).map(id => store.supersede(guildId, id, saved.id)));
      return interaction.editReply(`Updated memory **#${saved.id}**: "${saved.content}"${correction.supersedes.length ? `. Superseded: ${correction.supersedes.map(id => `#${id}`).join(", ")}.` : "."}`);
    } catch { return interaction.editReply("I couldn't process that correction right now. Nothing was changed."); }
  }
  if (interaction.commandName === "memory-confirm") {
    const memory = await store.getMemory(guildId, interaction.options.getInteger("memory_id", true));
    if (!memory || memory.subjectId !== interaction.user.id || memory.status !== "candidate") return interaction.reply({ content: "I couldn't find one of your candidate memories with that ID.", ephemeral: true });
    await store.confirm(guildId, memory.id);
    return interaction.reply({ content: `Confirmed memory **#${memory.id}**. It is now active.`, ephemeral: true });
  }
  if (interaction.commandName === "memory-export") {
    const data = JSON.stringify(await store.exportSubject(guildId, interaction.user.id), null, 2);
    return interaction.reply({ content: "Here is the memory data I hold about you.", files: [new AttachmentBuilder(Buffer.from(data), { name: "my-characterly-memory.json" })], ephemeral: true });
  }
  if (interaction.commandName === "memory-purge") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can purge raw messages.", ephemeral: true });
    const days = interaction.options.getInteger("older_than_days", true);
    if (days < 1) return interaction.reply({ content: "Retention must be at least one day.", ephemeral: true });
    const deleted = await store.deleteRawMessagesOlderThan(guildId, days);
    return interaction.reply({ content: `Deleted ${deleted.toLocaleString()} raw messages older than ${days} days. Curated memories were retained.`, ephemeral: true });
  }
  if (interaction.commandName === "memory-pause" || interaction.commandName === "memory-resume") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can change memory collection.", ephemeral: true });
    const paused = interaction.commandName === "memory-pause";
    await store.setPaused(guildId, paused);
    return interaction.reply({ content: paused ? "Memory collection and bot replies are now paused for this server." : "Memory collection and bot replies are now enabled for this server.", ephemeral: true });
  }
  if (interaction.commandName === "status") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can view bot status.", ephemeral: true });
    const { uptimeSec, counts } = metricsSnapshot();
    const value = await store.stats(guildId);
    const uptime = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`;
    const counterLines = Object.entries(counts).map(([k, v]) => `**${k}:** ${v.toLocaleString()}`).join("\n") || "No events recorded yet.";
    const settings = await store.settings(guildId);
    const activeCompanions = typeof store.listGuildCompanions === "function" ? await store.listGuildCompanions(guildId) : [];
    const companionsLine = `**Summoned companions (${activeCompanions.length}):** ${activeCompanions.length ? activeCompanions.map(c => c.name).join(", ") : "none"}`;
    const [usage, qstats] = await Promise.all([store.usageToday(guildId), store.queueStats(guildId)]);
    const oldestMin = qstats.oldestPendingAt ? Math.max(0, Math.round((Date.now() - qstats.oldestPendingAt.getTime()) / 60_000)) : null;
    const queueLine = `**queue:** ${qstats.pending} job${qstats.pending === 1 ? "" : "s"} pending${oldestMin !== null ? ` (oldest ${oldestMin}m ago)` : ""}${qstats.dead ? ` · ${qstats.dead} dead-lettered — operator can re-drive with scripts/requeue-dead-jobs.mjs` : ""}`;
    const budgetLine = `**LLM usage:** ${usage.toLocaleString()}/${settings.llmDailyCap.toLocaleString()} calls today · ${queueLine}`;
    const flagsLine = `**Flags:** memory ${settings.memoryEnabled ? "on" : "paused"} · companion replies ${settings.replyEnabled ? "on" : "paused"} · ignored channels ${settings.ignoredChannels.length}`;
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle("Characterly server status").setDescription(`**Uptime:** ${uptime}\n\n${counterLines}\n\n${companionsLine}\n${flagsLine}\n${budgetLine}\n\n*${value.messages.toLocaleString()} raw messages · ${value.memories.toLocaleString()} active memories · ${value.lore.toLocaleString()} lore*`)] });
  }
  if (interaction.commandName === "memory-triage") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can triage memories.", ephemeral: true });
    const recent = await store.recentMemories(guildId, 15);
    const lines = recent.map(m => `**#${m.id}** \`${m.status}/${m.kind}\` **${m.subjectLabel}** — ${m.content.slice(0, 120)}`);
    // Contested attributes are the dispute surface — a stored facet whose
    // evidence is currently under challenge.
    const contested = await store.contestedAttributes(guildId, 5);
    if (contested.length) {
      const attrLines = await Promise.all(contested.map(async a =>
        `⚔️ **${await store.displayNameFor(guildId, a.subjectId)}** — ${a.field}: ${a.value}`));
      lines.push("", "**Contested attributes**", ...attrLines);
    }
    return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setTitle("Recent memories (all members)").setDescription(lines.join("\n") || "Nothing stored yet.")] });
  }
  if (interaction.commandName === "memory-settings") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can view settings.", ephemeral: true });
    const settings = await store.settings(guildId);
    const ignored = settings.ignoredChannels.length
      ? settings.ignoredChannels.map(id => `<#${id}>`).join(", ")
      : "none";
    return interaction.reply({ content: `Memory collection: **${settings.memoryEnabled ? "on" : "paused"}**\nCompanion replies: **${settings.replyEnabled ? "on" : "paused"}**\nRaw-message retention: **${settings.rawRetentionDays} days**\nIgnored channels: ${ignored}\nDaily LLM cap: **${settings.llmDailyCap.toLocaleString()} calls**`, ephemeral: true });
  }
  if (interaction.commandName === "limits") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can change the LLM budget.", ephemeral: true });
    const cap = interaction.options.getInteger("daily_cap", true);
    if (cap < 0 || cap > 100000) return interaction.reply({ content: "The daily cap must be between **0** and **100,000** calls (0 blocks all LLM calls).", ephemeral: true });
    await store.setDailyCap(guildId, cap);
    return interaction.reply({ content: cap === 0
      ? "Daily LLM cap set to **0** — all LLM calls for this server are now blocked until the cap is raised (usage resets at midnight UTC)."
      : `Daily LLM cap set to **${cap.toLocaleString()} calls** for this server (resets at midnight UTC).`, ephemeral: true });
  }
  if (interaction.commandName === "ignore-channel" || interaction.commandName === "unignore-channel") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can change ignored channels.", ephemeral: true });
    const channel = interaction.options.getChannel("channel", true);
    const settings = await store.settings(guildId);
    const ignored = new Set(settings.ignoredChannels);
    if (interaction.commandName === "ignore-channel") {
      if (ignored.has(channel.id)) return interaction.reply({ content: `<#${channel.id}> is already ignored.`, ephemeral: true });
      ignored.add(channel.id);
      await store.setIgnoredChannels(guildId, [...ignored]);
      return interaction.reply({ content: `<#${channel.id}> is now invisible to Characterly — nothing there is archived, answered, or scanned by \`/server-build\`. Restore it with \`/unignore-channel\`.`, ephemeral: true });
    }
    if (!ignored.has(channel.id)) return interaction.reply({ content: `<#${channel.id}> isn't ignored.`, ephemeral: true });
    ignored.delete(channel.id);
    await store.setIgnoredChannels(guildId, [...ignored]);
    return interaction.reply({ content: `<#${channel.id}> is visible to Characterly again — messages there are archived and answered normally.`, ephemeral: true });
  }
  if (interaction.commandName === "event") {
    if (!evStore) return interaction.reply({ content: "Event inspection is not available right now.", ephemeral: true });
    const memId = interaction.options.getInteger("memory_id", true);
    const memory = await store.getMemory(guildId, memId);
    const canInspect = memory && (memory.subjectId === interaction.user.id || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
    if (!canInspect || !memory) return interaction.reply({ content: "I couldn't find a memory you are allowed to inspect with that ID.", ephemeral: true });
    const events = await evStore.eventsForMemory(guildId, memId);
    if (events.length === 0) return interaction.reply({ content: `Memory **#${memId}** is not linked to any recorded event.`, ephemeral: true });
    const ev = events[0]; // show the most recent linked event
    const participantList = ev.participants.map(p => `${p.userName} *(${p.role})*`).join(", ") || "Unknown";
    const embed = new EmbedBuilder()
      .setTitle(`📅 ${ev.title || `Event #${ev.id}`}`)
      .setDescription(ev.summary || "*No summary yet.*")
      .addFields(
        { name: "Participants", value: participantList, inline: false },
        { name: "Occurred", value: ev.occurredAt.toLocaleDateString(), inline: true },
        { name: "Significance", value: `${(ev.significance * 100).toFixed(0)}%`, inline: true },
        { name: "Status", value: ev.tier, inline: true },
        { name: "Messages", value: String(ev.messageIds.length), inline: true },
        { name: "Memories", value: String(ev.memoryIds.length), inline: true },
      );
    return interaction.reply({ ephemeral: true, embeds: [embed] });
  }
  if (interaction.commandName === "profile") {
    const member = interaction.options.getUser("user");
    if (member && member.id !== interaction.user.id && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: "You can only view your own profile.", ephemeral: true });
    }
    const subjectId = member?.id ?? interaction.user.id;
    const memberRow = await store.getMember(guildId, subjectId);
    if (!memberRow?.optedIn || memberRow.optedOut) {
      return interaction.reply({ content: subjectId === interaction.user.id ? OPT_IN_HINT_SELF : OPT_IN_HINT_OTHER, ephemeral: true });
    }
    const profile = await profileStore.getProfile(guildId, subjectId);
    if (!profile) return interaction.reply({ content: "No profile has been built for that member yet. Profiles are generated during daily maintenance once enough has been observed.", ephemeral: true });

    const [edges, memories] = await Promise.all([
      store.relationshipsFor(guildId, subjectId),
      store.listMemories(guildId, subjectId),
    ]);
    const topEdges = edges.filter(e => e.observationCount >= 2).slice(0, 5);
    const relLines: string[] = [];
    for (const e of topEdges) {
      const otherId = e.subjectId === subjectId ? e.otherId : e.subjectId;
      const name = await store.displayNameFor(guildId, otherId);
      const tone = e.valence == null ? "" : e.valence >= 0.3 ? " · close" : e.valence <= -0.3 ? " · hostile" : " · neutral";
      relLines.push(`**${name}** — ${e.summary || "observed dynamic"}${tone} (${e.observationCount} observations)`);
    }
    const events = evStore ? (await evStore.listEvents(guildId, { subjectUserId: subjectId, tier: "event" })).events.slice(0, 5) : [];

    const embed = new EmbedBuilder()
      .setTitle(`Profile — ${profile.displayName || member?.username || interaction.user.username}`)
      .setDescription(profile.summary || "*No bio yet.*")
      .addFields({
        name: "Activity",
        value: memberRow
          ? `${memberRow.messageCount.toLocaleString()} messages · first seen ${new Date(memberRow.firstSeenAt).toLocaleDateString()} · last seen ${new Date(memberRow.lastSeenAt).toLocaleDateString()}`
          : "No activity recorded",
        inline: false,
      });
    if (profile.facets.roleInServer) embed.addFields({ name: "Role", value: profile.facets.roleInServer, inline: false });

    // Attributes carry provenance — each facet shows the memories it was
    // derived from, so "why does it think this" has an answer.
    const attrs = (await store.attributesFor(guildId, subjectId)).filter(a => a.status === "active");
    const cite = (a: { memoryIds: number[] }) => a.memoryIds.length ? ` *(${a.memoryIds.map(id => `#${id}`).join(", ")})*` : "";
    const details = attrs.filter(a => !["trait", "interest", "skill"].includes(a.field)).map(a => `**${a.field}:** ${a.value}${cite(a)}`);
    if (details.length) embed.addFields({ name: "Details", value: details.join("\n"), inline: false });
    const traits = attrs.filter(a => a.field === "trait").map(a => `${a.value}${cite(a)}`);
    if (traits.length) embed.addFields({ name: "Traits", value: traits.join(", "), inline: false });
    const interests = attrs.filter(a => a.field === "interest").map(a => `${a.value}${cite(a)}`);
    if (interests.length) embed.addFields({ name: "Interests", value: interests.join(", "), inline: false });
    const skills = attrs.filter(a => a.field === "skill").map(a => `${a.value}${cite(a)}`);
    if (skills.length) embed.addFields({ name: "Skills", value: skills.join(", "), inline: false });
    // Legacy facets cover profiles built before attributes existed.
    if (!attrs.length && profile.facets.traits?.length) embed.addFields({ name: "Traits", value: profile.facets.traits.join(", "), inline: false });
    if (!attrs.length && profile.facets.interests?.length) embed.addFields({ name: "Interests", value: profile.facets.interests.join(", "), inline: false });
    if (relLines.length) embed.addFields({ name: "Relationships", value: relLines.join("\n"), inline: false });
    if (events.length) embed.addFields({
      name: "Significant events",
      value: events.map(e => `${e.title || `Event #${e.id}`} *(${e.participants.find(p => p.userId === subjectId)?.role ?? "participant"})*`).join("\n"),
      inline: false,
    });
    if (memories.memories.length) embed.addFields({
      name: "Top memories",
      value: memories.memories.slice(0, 5).map(m => `• ${m.content}`).join("\n"),
      inline: false,
    });
    return interaction.reply({ ephemeral: true, embeds: [embed] });
  }
  if (interaction.commandName === "dossier") {
    const member = interaction.options.getUser("user");
    if (member && member.id !== interaction.user.id && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: "You can only view your own dossier.", ephemeral: true });
    }
    const subjectId = member?.id ?? interaction.user.id;
    const memberRow = await store.getMember(guildId, subjectId);
    if (!memberRow?.optedIn || memberRow.optedOut) {
      return interaction.reply({ content: subjectId === interaction.user.id ? OPT_IN_HINT_SELF : OPT_IN_HINT_OTHER, ephemeral: true });
    }
    const profile = await profileStore.getProfile(guildId, subjectId);
    const dossier = profile?.facets.dossier?.sections;
    if (!profile || !dossier || Object.keys(dossier).length === 0) {
      return interaction.reply({ content: "No detailed profile has been built for that member yet.", ephemeral: true });
    }

    const cite = (ids?: number[]) => ids?.length ? ` *(${ids.map(id => `#${id}`).join(", ")})*` : "";
    const itemsText = (items?: Array<{ text?: string; source_ids?: number[]; confirmed?: boolean }>) =>
      (items ?? []).map(i => `• ${i.text ?? ""}${cite(i.source_ids)}`).join("\n") || "*None.*";

    const embeds: EmbedBuilder[] = [];
    const head = new EmbedBuilder()
      .setTitle(`Dossier — ${profile.displayName || member?.username || interaction.user.username}`)
      .setDescription(profile.summary || "*No bio yet.*")
      .setFooter({ text: "Unconfirmed items are marked as such. #n references resolve via /memory memory_id." });
    embeds.push(head);

    const v = dossier.voice?.data as { prose?: string; quirks?: string[]; stats?: { avgLength: number; capsRatio: number; emojiRatio: number; questionRatio: number; sampleSize: number } } | undefined;
    if (v) {
      const stats = v.stats ? `\n\n*avg ${v.stats.avgLength} chars · ${(v.stats.capsRatio * 100).toFixed(0)}% all-caps · ${(v.stats.emojiRatio * 100).toFixed(0)}% emoji · ${(v.stats.questionRatio * 100).toFixed(0)}% questions · ${v.stats.sampleSize} msgs sampled*` : "";
      embeds.push(new EmbedBuilder().setTitle("Voice").setDescription(`${v.prose ?? ""}${v.quirks?.length ? `\n\n**Quirks:** ${v.quirks.join("; ")}` : ""}${stats}`));
    }
    const life = dossier.life_situation?.data as { items?: Array<{ text?: string; source_ids?: number[] }> } | undefined;
    if (life) embeds.push(new EmbedBuilder().setTitle("Life situation").setDescription(itemsText(life.items)));
    const temp = dossier.temperament?.data as { prose?: string; items?: Array<{ text?: string; source_ids?: number[] }> } | undefined;
    if (temp) embeds.push(new EmbedBuilder().setTitle("Temperament").setDescription(`${temp.prose ?? ""}${temp.items?.length ? `\n\n${itemsText(temp.items)}` : ""}`));
    const beliefs = dossier.beliefs?.data as { items?: Array<{ text?: string; source_ids?: number[] }> } | undefined;
    if (beliefs) embeds.push(new EmbedBuilder().setTitle("Beliefs & tastes").setDescription(itemsText(beliefs.items)));
    const rels = dossier.relationship_map?.data as { entries?: Array<{ name?: string; dynamic?: string }> } | undefined;
    if (rels?.entries?.length) embeds.push(new EmbedBuilder().setTitle("Relationship map").setDescription(rels.entries.map(e => `• **${e.name ?? "?"}** — ${e.dynamic ?? ""}`).join("\n")));
    const rep = dossier.reputation?.data as { prose?: string; items?: Array<{ text?: string; source_ids?: number[] }> } | undefined;
    if (rep) embeds.push(new EmbedBuilder().setTitle("Reputation").setDescription(`${rep.prose ?? ""}${rep.items?.length ? `\n\n${itemsText(rep.items)}` : ""}`));
    const tl = dossier.timeline?.data as { entries?: Array<{ title?: string; date?: string; role?: string }> } | undefined;
    if (tl?.entries?.length) embeds.push(new EmbedBuilder().setTitle("Timeline").setDescription(tl.entries.map(e => `• ${e.date ?? "?"} — ${e.title ?? "Untitled"} *(${e.role ?? "participant"})*`).join("\n")));

    return interaction.reply({ ephemeral: true, embeds: embeds.slice(0, 10) });
  }
  if (interaction.commandName === "opt-out") {
    const userId = interaction.user.id;
    await store.setMemberOptOut(guildId, userId, true);
    const forgotten = await store.forgetAllFor(guildId, userId);
    const relForgotten = await store.forgetRelationshipsFor(guildId, userId);
    // Companion journal entries about this user are derived person data too —
    // hard-delete them in this scope (and the user's DM scope if they have one).
    await store.forgetJournalAbout(guildId, userId);
    await store.forgetJournalAbout(`dm:${userId}`, userId);
    await store.deleteAttributesFor(guildId, userId);
    // Consolidated behavioral patterns are derived person data too — without
    // this a pattern built from now-forgotten episodes would resurface on
    // re-opt-in.
    await store.deletePatternsFor(guildId, userId);
    // Verbatim evidence (quotes, message snapshots) is scrubbed now, not at
    // retention expiry — opt-out shouldn't wait days to stop holding the words.
    await store.scrubEvidenceFor(guildId, userId);
    await profileStore.deleteProfile(guildId, userId);
    return interaction.reply({ content: `Opted out. ${forgotten} memor${forgotten === 1 ? "y" : "ies"} and ${relForgotten} relationship record${relForgotten === 1 ? "" : "s"} about you were forgotten and your profile, attributes, and stored quotes were deleted — no new memories, relationships, or profile data will be formed about you while you're opted out. Your messages still appear in the raw archive until the server's retention window removes them. Use /opt-in and /profile-build to start again.`, ephemeral: true });
  }
  if (interaction.commandName === "opt-in") {
    await store.setMemberOptIn(guildId, interaction.user.id, true);
    await store.setMemberOptOut(guildId, interaction.user.id, false);
    return interaction.reply({ content: "Opted in — new memories about you can form from live activity. Run /profile-build to also scan your message history and build your profile now.", ephemeral: true });
  }
  if (interaction.commandName === "profile-build") {
    const userId = interaction.user.id;
    // Cooldown — a full archive scan is a real LLM spend; one build per day.
    const existing = await profileStore.getProfile(guildId, userId);
    if (existing?.updatedAt && Date.now() - new Date(existing.updatedAt).getTime() < PROFILE_BUILD_COOLDOWN_MS) {
      return interaction.reply({ content: "Your profile was built recently — you can rebuild once every 24 hours.", ephemeral: true });
    }
    const brain = await brainFor(guildId);
    if (!brain) return interaction.reply({ content: NO_KEY_MSG, ephemeral: true });
    const pbKey = `${guildId}:${userId}`;
    if (profileBuildsRunning.has(pbKey)) return interaction.reply({ content: "Your profile build is already running.", ephemeral: true });
    profileBuildsRunning.add(pbKey);
    try {
      await interaction.deferReply({ ephemeral: true });
      await store.setMemberOptIn(guildId, userId, true);
      await store.setMemberOptOut(guildId, userId, false);
      const stats = await runProfileBuild(guildId, userId, {
        store, brain, eventStore: evStore ?? new EventStore(), profileStore,
      });
      return await interaction.editReply(`Opted in and built your profile — scanned ${stats.scanned.toLocaleString()} messages, formed ${stats.memories} memor${stats.memories === 1 ? "y" : "ies"}${stats.relationships ? ` and ${stats.relationships} relationship observation${stats.relationships === 1 ? "" : "s"}` : ""}. Run /profile to see it.`);
    } catch (err) {
      logError("Profile build failed", err);
      return await interaction.editReply("The profile build failed partway through — you're opted in, so live activity keeps shaping it. Try again later for the full scan.").catch(() => {});
    } finally {
      profileBuildsRunning.delete(pbKey);
    }
  }
  if (interaction.commandName === "server-build") {
    const isOwner = interaction.user.id === interaction.guild?.ownerId;
    if (!isOwner && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: "Only the server owner or an administrator can run a server build.", ephemeral: true });
    }
    if (serverBuildRunning) return interaction.reply({ content: "A server build is already running.", ephemeral: true });
    const channelOpt = interaction.options.getChannel("channel");
    const channel = (channelOpt ?? interaction.guild?.channels.cache.find(c => c.name === config.ingestChannel && c.type === ChannelType.GuildText)) ?? null;
    if (!channel || channel.type !== ChannelType.GuildText) {
      return interaction.reply({ content: "Pick a text channel to build from (or set INGEST_CHANNEL and omit the option).", ephemeral: true });
    }
    // Ignored means invisible — a historical scan over an ignored channel
    // would archive exactly what the admin excluded.
    const buildSettings = await store.settings(guildId);
    if (buildSettings.ignoredChannels.includes(channel.id)) {
      return interaction.reply({ content: `<#${channel.id}> is on the ignored list — nothing there is archived. Restore it with \`/unignore-channel\` first if you really want to scan it.`, ephemeral: true });
    }
    // Consent gate — this scans and archives channel history, including
    // messages written before the bot arrived by people who never consented
    // to it. The click-through is the consent artifact; the build itself
    // only starts from the confirm button (handleMemoryButton).
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`serverbuild:confirm:${guildId}:${interaction.user.id}:${channel.id}`).setLabel("Scan channel history").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`serverbuild:cancel:${guildId}:${interaction.user.id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({ ephemeral: true, components: [row],
      content: `**This scans and archives #${channel.name} history** — including messages written before the bot arrived, by people who never consented to it. Only continue if the server expects this.` });
  }
  if (interaction.commandName === "setup") {
    if (interaction.guildId && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: "Only server administrators can configure the LLM key. Use `/companion action:key` to connect your personal API key.", ephemeral: true });
    }
    if (!config.keyEncryptionSecret) {
      return interaction.reply({ content: "The bot operator hasn't configured key storage (KEY_ENCRYPTION_SECRET) — per-guild keys are unavailable.", ephemeral: true });
    }
    const modalId = interaction.guildId ? "setup-key" : "user-key";
    return interaction.showModal(buildUserApiKeyModal(modalId));
  }
}

/** Modal submission for /setup or personal key onboarding — validates the key
 * live (auto-detecting provider from key prefix when Base URL is left blank),
 * encrypts it, stores the row, and invalidates cached Brains. */
export async function handleSetupModal(
  interaction: ModalSubmitInteraction, store: MemoryStore,
  invalidateBrain: (scopeId: string) => void,
  validate: typeof validateLlmKey = validateLlmKey
) {
  const isUserModal = interaction.customId === "user-key";
  const isSetupModal = interaction.customId === "setup-key";
  if (!isUserModal && !isSetupModal) return;

  if (isSetupModal && interaction.guildId && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: "Setup requires the Manage Server permission.", ephemeral: true });
  }
  const userId = (interaction as { user?: { id?: string } }).user?.id;
  const targetScopeId = isUserModal || !interaction.guildId
    ? (userId ? `dm:${userId}` : null)
    : interaction.guildId;
  if (!targetScopeId) return;

  const key = interaction.fields.getTextInputValue("api-key").trim();
  const baseUrl = interaction.fields.getTextInputValue("base-url").trim() || null;
  const modelInput = interaction.fields.getTextInputValue("model")?.trim() || null;
  await interaction.deferReply({ ephemeral: true });
  if (baseUrl && !isSafeUrl(baseUrl)) {
    return interaction.editReply("That base URL isn't allowed — it must be a public http(s) endpoint. Leave it blank to auto-detect your provider.");
  }
  if (baseUrl && await resolvesToPrivateAddress(new URL(baseUrl).hostname)) {
    return interaction.editReply("That base URL isn't allowed — it resolves to a private or internal address. Leave it blank to auto-detect your provider.");
  }
  // A custom endpoint without a model name can't be driven — the detected
  // default almost certainly doesn't exist on their server.
  if (baseUrl && !modelInput) {
    return interaction.editReply("A custom Base URL needs a Model name too — the provider default won't exist on your server. Re-run and fill in Model (e.g. `llama-3.3-70b`).");
  }
  try {
    const detected = detectProviderFromKey(key, baseUrl, config.groqBaseUrl, config.model, modelInput);
    const result = await validate(key, detected.baseUrl, guardedLlmFetch);
    if (!result.ok && "status" in result) {
      return interaction.editReply("That key was rejected by the provider (auth failed) — nothing was stored. Check the key and try again.");
    }
    const keyRecord = {
      keyEnc: encryptSecret(key),
      keyHint: maskKey(key),
      baseUrl,
      model: modelInput,
      validatedAt: result.ok ? new Date().toISOString() : null,
    };
    await store.upsertGuildKey(targetScopeId, keyRecord);
    invalidateBrain(targetScopeId);
    // When a user submits a key in a server via setup-key, also bind it to their personal dm:<userId> scope.
    if (userId && targetScopeId !== `dm:${userId}`) {
      await store.upsertGuildKey(`dm:${userId}`, keyRecord);
      invalidateBrain(`dm:${userId}`);
    }

    const providerLabel = detected.autoDetected ? ` (${detected.provider} auto-detected)` : "";
    if (isUserModal || !interaction.guildId) {
      const existing = userId ? await store.getCompanionByOwner(userId) : null;
      const needsOnboarding = userId && (!existing || existing.onboardingState !== "active");
      const statusText = result.ok
        ? `Personal AI key connected (${maskKey(key)})${providerLabel}! Your companion will use this key across DMs and servers.`
        : `Couldn't reach the provider to verify right now, but your key (${maskKey(key)})${providerLabel} is saved and will be checked on first use.`;
      if (needsOnboarding && userId) {
        const welcome = buildOnboardingWelcomePayload(userId);
        return (interaction.editReply as (p: any) => Promise<any>)({
          content: statusText,
          ...welcome,
        });
      }
      return interaction.editReply(statusText);
    }

    return interaction.editReply(result.ok
      ? `Key stored (${maskKey(key)})${providerLabel} — this scope now runs on this key. Re-run /setup or \`/companion action:key\` any time to rotate it.`
      : `Couldn't reach the provider to verify, but the key (${maskKey(key)})${providerLabel} is stored unverified — it'll be checked on first use.`);
  } catch (error) {
    logError("/setup failed", error);
    return interaction.editReply("Setup failed — nothing was stored. Try again later.");
  }
}

export async function handleCompanionModal(
  interaction: ModalSubmitInteraction,
  store: MemoryStore,
  invalidateLookups?: (scopeId: string) => void,
) {
  // market_create — author a freehand marketplace character (no awakened
  // companion backs it). Listing cap applies here at submit time too — the
  // action-level check alone could be raced past.
  if (interaction.customId === "market_create") {
    const userId = interaction.user.id;
    const account = await store.accountForDiscordUser(userId).catch(() => null);
    if (!account) {
      return interaction.reply({ content: `Creating marketplace characters requires a linked account — create one at ${config.siteUrl} and run \`/link\`.`, ephemeral: true });
    }
    const channel = await interaction.client.channels.fetch(config.marketplaceChannelId!).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildForum) {
      return interaction.reply({ content: "The marketplace channel isn't reachable — tell a moderator to check MARKETPLACE_CHANNEL_ID.", ephemeral: true });
    }
    const slotError = await listingSlotError(store, userId, account);
    if (slotError) return interaction.reply({ content: slotError, ephemeral: true });
    const name = interaction.fields.getTextInputValue("listing-name").trim().slice(0, 64);
    const tagline = interaction.fields.getTextInputValue("listing-tagline").trim().slice(0, 120);
    const greeting = interaction.fields.getTextInputValue("listing-greeting").trim().slice(0, 1000);
    const voicePersona = interaction.fields.getTextInputValue("listing-voice").trim().slice(0, 500);
    const backstory = interaction.fields.getTextInputValue("listing-backstory").trim().slice(0, 600);
    if (!name || !tagline || !greeting || !voicePersona) {
      return interaction.reply({ content: "Name, tagline, greeting, and voice are all required.", ephemeral: true });
    }
    const res = await store.createListing(userId, {
      name, tagline, greeting, voicePersona,
      coreTraits: [], ownerDynamic: "a companion who met you here", backstory,
      avatarUrl: null,
    }, listingCapFor(store, account));
    if (!res.ok) {
      return interaction.reply({ content: LISTING_CAP_MSG, ephemeral: true });
    }
    const listing = res.listing;
    const threadId = await postListingThread(interaction, listing);
    if (!threadId) {
      await store.delistListing(listing.id);
      return interaction.reply({ content: "I couldn't create the forum post — check my permissions in the marketplace channel.", ephemeral: true });
    }
    await store.setListingThread(listing.id, threadId);
    inc("market.published");
    const manageRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`market:editmodal:${listing.id}`).setLabel("Edit persona").setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({
      ephemeral: true,
      content: `**${listing.name}** is live in <#${config.marketplaceChannelId}>! Use **Edit persona** below to set traits and their bond with adopters.`,
      components: [manageRow],
    });
  }

  // market_publish:<companionId> — create/republish the listing, then the bot
  // posts the forum card itself so listings can't be faked.
  if (interaction.customId.startsWith("market_publish:")) {
    const companionId = Number(interaction.customId.slice("market_publish:".length));
    const userId = interaction.user.id;
    const companion = await store.getCompanionByOwner(userId);
    if (!companion || companion.id !== companionId || companion.onboardingState !== "active") {
      return interaction.reply({ content: "That companion isn't yours to publish.", ephemeral: true });
    }
    const account = await store.accountForDiscordUser(userId).catch(() => null);
    if (!account) {
      return interaction.reply({ content: `Publishing requires a linked account — create one at ${config.siteUrl} and run \`/link\`.`, ephemeral: true });
    }
    const channel = await interaction.client.channels.fetch(config.marketplaceChannelId!).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildForum) {
      return interaction.reply({ content: "The marketplace channel isn't reachable — tell a moderator to check MARKETPLACE_CHANNEL_ID.", ephemeral: true });
    }
    const name = interaction.fields.getTextInputValue("listing-name").trim().slice(0, 64) || companion.name;
    const tagline = interaction.fields.getTextInputValue("listing-tagline").trim().slice(0, 120);
    const greeting = interaction.fields.getTextInputValue("listing-greeting").trim().slice(0, 1000);
    if (!tagline || !greeting) {
      return interaction.reply({ content: "Tagline and greeting are both required.", ephemeral: true });
    }
    const existing = await store.listingForCompanion(companion.id);
    // Only a republish of an already-live listing skips the slot check —
    // reviving a delisted one adds a live listing back.
    if (!existing || existing.status === "delisted") {
      const slotError = await listingSlotError(store, userId, account);
      if (slotError) return interaction.reply({ content: slotError, ephemeral: true });
    }
    const res = await store.upsertListing(userId, companion.id, {
      name,
      tagline,
      voicePersona: existing?.voicePersona ?? companion.voicePersona,
      coreTraits: existing?.coreTraits ?? companion.coreTraits,
      ownerDynamic: existing?.ownerDynamic ?? companion.ownerDynamic,
      backstory: existing?.backstory ?? companion.backstory,
      greeting,
      avatarUrl: existing?.avatarUrl ?? companion.avatarUrl,
    }, { maxListings: listingCapFor(store, account) });
    if (!res.ok) {
      return interaction.reply({ content: LISTING_CAP_MSG, ephemeral: true });
    }
    const listing = res.listing;
    // A flagged listing survives republish still flagged — save the edits but
    // don't post a fresh card whose Add/Report buttons would refuse anyway.
    if (listing.status === "flagged") {
      return interaction.reply({
        ephemeral: true,
        content: `Edits saved (v${listing.version}) — **${listing.name}** is still under review, so the marketplace post stays down until a moderator clears it.`,
      });
    }
    if (existing?.forumThreadId) {
      const old = await channel.threads.fetch(existing.forumThreadId).catch(() => null);
      if (old) await old.setLocked(true).then(() => old.setArchived(true)).catch(() => {});
    }
    const threadId = await postListingThread(interaction, listing);
    if (!threadId) {
      await store.delistListing(listing.id);
      return interaction.reply({ content: "I couldn't create the forum post — check my permissions in the marketplace channel.", ephemeral: true });
    }
    await store.setListingThread(listing.id, threadId);
    inc("market.published");
    const manageRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`market:editmodal:${listing.id}`).setLabel("Edit persona").setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({
      ephemeral: true,
      content: `**${listing.name}** is live in <#${config.marketplaceChannelId}>! (v${listing.version}) — anyone can adopt them from the post.`,
      components: [manageRow],
    });
  }

  // market_edit:<listingId> — persona edit; bumps the version and propagates
  // to every adopted clone (live reference, audit trail via persona versions).
  if (interaction.customId.startsWith("market_edit:")) {
    const listingId = Number(interaction.customId.slice("market_edit:".length));
    const userId = interaction.user.id;
    const listing = await store.listingById(listingId);
    if (!listing || listing.creatorUserId !== userId) {
      return interaction.reply({ content: "That's not your listing.", ephemeral: true });
    }
    const name = interaction.fields.getTextInputValue("companion-name").trim().slice(0, 64);
    const voicePersona = interaction.fields.getTextInputValue("voice-persona").trim().slice(0, 500);
    const rawTraits = interaction.fields.getTextInputValue("core-traits").trim();
    const coreTraits = rawTraits ? rawTraits.split(",").map(t => t.trim()).filter(Boolean).slice(0, 8) : [];
    const ownerDynamic = interaction.fields.getTextInputValue("owner-dynamic").trim().slice(0, 300);
    const backstory = interaction.fields.getTextInputValue("backstory").trim().slice(0, 600);
    if (!name || !voicePersona || !ownerDynamic) {
      return interaction.reply({ content: "Name, Voice & Vibe, and Dynamic are all required.", ephemeral: true });
    }
    const updated = await store.updateListing(listing.id, userId, {
      name, tagline: listing.tagline, voicePersona, coreTraits, ownerDynamic,
      backstory, greeting: listing.greeting, avatarUrl: listing.avatarUrl,
    });
    if (!updated) {
      return interaction.reply({ content: "That's not your listing.", ephemeral: true });
    }
    inc("market.republished");
    return interaction.reply({
      ephemeral: true,
      content: `**${updated.name}** updated to v${updated.version} — the change is live for all ${updated.addCount} adopter${updated.addCount === 1 ? "" : "s"}.`,
    });
  }

  if (interaction.customId !== "companion-edit") return;
  const userId = interaction.user.id;
  const ownerName =
    (interaction.user as { globalName?: string; username?: string }).globalName ??
    interaction.user.username ??
    userId;
  const name = interaction.fields.getTextInputValue("companion-name").trim().slice(0, 64);
  const voicePersona = interaction.fields.getTextInputValue("voice-persona").trim().slice(0, 500);
  const rawTraits = interaction.fields.getTextInputValue("core-traits").trim();
  const coreTraits = rawTraits
    ? rawTraits
        .split(",")
        .map(t => t.trim())
        .filter(Boolean)
        .slice(0, 8)
    : ["observant", "loyal", "witty"];
  const ownerDynamic = interaction.fields.getTextInputValue("owner-dynamic").trim().slice(0, 300);
  const backstory = interaction.fields.getTextInputValue("backstory").trim().slice(0, 600);

  if (!name || !voicePersona || !ownerDynamic) {
    return interaction.reply({
      content: "Name, Voice & Vibe, and Dynamic are all required.",
      ephemeral: true,
    });
  }

  const existing = await store.getCompanionByOwner(userId);
  if (existing?.onboardingState === "active") {
    return interaction.reply({
      content: `Your companion **${existing.name}** is already awakened and permanently locked to your account — each account gets one permanent companion.`,
      ephemeral: true,
    });
  }

  const activated = await store.activateCompanion(userId, ownerName, {
    name,
    voicePersona,
    coreTraits,
    ownerDynamic,
    backstory,
    avatarUrl: existing?.avatarUrl ?? null,
  });
  invalidateLookups?.(`dm:${userId}`);
  inc("companion.awakened");
  const payload = buildAwakenedCompanionPayload(
    activated,
    ownerName,
    findMutualGuilds(interaction.client, userId),
  );
  return interaction.reply({
    content: `**${activated.name}** is awake and permanently bound to your account!`,
    ...payload,
    ephemeral: true,
  });
}

export async function handleMemoryButton(interaction: ButtonInteraction, store: MemoryStore, brainFor?: BrainFor, evStore?: EventStore) {
  if (interaction.customId === "forget:cancel") return interaction.update({ content: "No memory was deleted.", components: [] });
  const parts = interaction.customId.split(":");

  // market:{add|report|talk|summon|dismiss|drop|unlist|relist|editmodal}:{id} — the companion
  // marketplace. Add/Report live on public forum cards and stay put after the
  // click; talk/summon/dismiss/drop are picker buttons on the caller's own
  // ephemeral replies, so they replace the message. Ownership is always
  // re-derived from the roster — the button ID alone authorizes nothing.
  if (parts[0] === "market") {
    const sub = parts[1];
    const id = Number(parts[2]);
    const userId = interaction.user.id;
    if (!Number.isFinite(id)) return interaction.reply({ content: "That button is no longer valid.", ephemeral: true });

    if (sub === "add") {
      const listing = await store.listingById(id);
      if (!listing || listing.status !== "active") {
        return interaction.reply({ content: "That listing is no longer available.", ephemeral: true });
      }
      const account = store.creditsSupported
        ? await store.accountForDiscordUser(userId).catch(() => null)
        : null;
      // Self-host lane has no billing → no adoption cap; hosted free = FREE_ADOPTION_SLOTS, premium uncapped.
      const maxSlots = !store.creditsSupported || account?.plan === "premium"
        ? Number.MAX_SAFE_INTEGER
        : config.freeAdoptionSlots;
      const res = await store.adoptListing(userId, id, maxSlots, config.adoptionCooldownMs);
      if (!res.ok) {
        const msg =
          res.reason === "cap" ? `Free accounts can have ${config.freeAdoptionSlots} active adoption${config.freeAdoptionSlots === 1 ? "" : "s"} — drop one first, or go Premium for unlimited: ${config.siteUrl}/dashboard#billing`
          : res.reason === "cooldown" ? `You dropped **${listing.name}** recently — you can adopt them again ${res.cooldownUntil ? `<t:${Math.floor(new Date(res.cooldownUntil).getTime() / 1000)}:R>` : "in about 12 hours"}.`
          : res.reason === "own_listing" ? `**${listing.name}** is your own companion — they're already bound to you.`
          : "That listing is no longer available.";
        return interaction.reply({ content: msg, ephemeral: true });
      }
      await store.setActiveDmCompanion(userId, res.companion.id);
      const greeted = await sendAdoptionGreeting(interaction.user, res.companion, listing.greeting);
      if (greeted) await store.markDmIntroduced(res.adoption.id);
      inc("market.adopted");
      // Adopting is open to unlinked users, but hosted chat isn't — say so now
      // rather than letting the first reply hit the link gate cold. And a user
      // who only ever adopts never sees the DM onboarding path — keep the
      // permanent awakened bond discoverable.
      const awakened = await store.getCompanionByOwner(userId);
      const hasAwakened = awakened?.onboardingState === "active";
      const rows = hasAwakened
        ? []
        : [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("onboard:start").setLabel("Awaken your own companion").setStyle(ButtonStyle.Primary),
          )];
      return interaction.reply({
        ephemeral: true,
        content:
          `**${res.companion.name}** has joined your companions${res.reused ? " (re-adopted — your history with them continues)" : ""} — they'll answer your DMs now.` +
          (greeted
            ? " They've introduced themselves — check your DMs! Once introduced, `/companion action:summon` works in servers too."
            : " I couldn't reach your DMs — open them once so they can introduce themselves (required before server summoning).") +
          " `/companion action:switch` changes who's answering." +
          (store.creditsSupported && !account
            ? ` Heads up — hosted chat needs a linked account: create one at ${config.siteUrl} and run \`/link\`, or connect your own key with \`/companion action:key\`.`
            : "") +
          (hasAwakened ? "" : " You can also awaken a permanent companion of your own — that's the bond that stays yours forever."),
        components: rows,
      });
    }

    if (sub === "report") {
      const listing = await store.listingById(id);
      if (!listing || listing.status !== "active") {
        return interaction.reply({ content: "That listing is no longer available.", ephemeral: true });
      }
      if (listing.creatorUserId === userId) {
        return interaction.reply({ content: "This is your own listing — use `/companion action:unpublish` to take it down.", ephemeral: true });
      }
      const count = await store.reportListing(id, userId);
      if (count < 0) {
        return interaction.reply({ content: "You've already reported this listing — the team has it.", ephemeral: true });
      }
      const flagged = count >= config.marketplaceReportFlagThreshold && listing.status === "active" && await store.flagListing(id);
      if (config.marketplaceModChannelId) {
        const modChannel = await interaction.client.channels.fetch(config.marketplaceModChannelId).catch(() => null);
        if (modChannel?.isTextBased() && "send" in modChannel) {
          await (modChannel as TextChannel).send(
            `🚩 Listing report: **${listing.name}** (id ${listing.id}, creator <@${listing.creatorUserId}>) — ${count} report${count === 1 ? "" : "s"}${flagged ? " — **auto-flagged, new Adds blocked**" : ""}.`,
          ).catch(() => {});
        }
      }
      inc("market.reported");
      return interaction.reply({ content: "Thanks — your report has been recorded and the listing flagged for review.", ephemeral: true });
    }

    if (sub === "talk") {
      const roster = await store.listCompanionsForUser(userId);
      const companion = roster.find(c => c.id === id);
      if (!companion) {
        return interaction.update({ content: "That companion isn't on your roster.", components: [] });
      }
      await store.setActiveDmCompanion(userId, companion.id);
      let extra = "";
      if (companion.kind === "adopted") {
        const adoption = await store.adoptionForCompanion(companion.id);
        if (adoption && !adoption.dmIntroducedAt) {
          const listing = companion.adoptedFromListingId ? await store.listingById(companion.adoptedFromListingId) : null;
          const greeted = await sendAdoptionGreeting(interaction.user, companion, listing?.greeting ?? "");
          if (greeted) {
            await store.markDmIntroduced(adoption.id);
            extra = " They've just introduced themselves — check your DMs.";
          } else {
            extra = " Open your DMs once so they can introduce themselves (required before server summoning).";
          }
        }
      }
      return interaction.update({ content: `**${companion.name}** is answering your DMs now.${extra}`, components: [] });
    }

    if (sub === "summon" || sub === "dismiss") {
      const roster = await store.listCompanionsForUser(userId);
      const companion = roster.find(c => c.id === id);
      if (!companion) {
        return interaction.update({ content: "That companion isn't on your roster.", components: [] });
      }
      return sub === "summon"
        ? summonPickedCompanion(interaction, companion, store)
        : dismissPickedCompanion(interaction, companion, store);
    }

    if (sub === "drop") {
      const dropped = await store.dropAdoption(userId, id, config.adoptionCooldownMs);
      if (!dropped) {
        return interaction.update({ content: "That adoption is no longer active.", components: [] });
      }
      inc("market.dropped");
      return interaction.update({
        content: `Dropped — you can't re-adopt this companion until <t:${Math.floor(new Date(dropped.cooldownUntil!).getTime() / 1000)}:R>. Your history with them is kept if you come back.`,
        components: [],
      });
    }

    if (sub === "unlist") {
      const listing = await store.listingById(id);
      if (!listing || listing.creatorUserId !== userId) {
        return interaction.reply({ content: "That's not your listing.", ephemeral: true });
      }
      return unlistListing(interaction, listing, store);
    }

    if (sub === "relist") {
      const listing = await store.listingById(id);
      if (!listing || listing.creatorUserId !== userId) {
        return interaction.reply({ content: "That's not your listing.", ephemeral: true });
      }
      // Same accountability bar as action:relist — a forged click on the
      // picker button doesn't get a weaker gate.
      const account = await store.accountForDiscordUser(userId).catch(() => null);
      if (!account) {
        return interaction.reply({
          content: `Relisting requires a linked account — create one at ${config.siteUrl} and run \`/link\`.`,
          ephemeral: true,
        });
      }
      return doRelist(interaction, listing, store, account);
    }

    if (sub === "editmodal") {
      const listing = await store.listingById(id);
      if (!listing || listing.creatorUserId !== userId) {
        return interaction.reply({ content: "That's not your listing.", ephemeral: true });
      }
      if (typeof interaction.showModal !== "function") {
        return interaction.reply({ content: "Editing requires modal support.", ephemeral: true });
      }
      return interaction.showModal(buildMarketPersonaModal(listing));
    }
    return;
  }

  // serverbuild:{confirm|cancel}:{guildId}:{userId}:{channelId?} — the
  // /server-build consent gate. Same-user and ManageGuild are both re-checked:
  // the prompt is ephemeral but button clicks are new interactions.
  if (parts[0] === "serverbuild") {
    const [, sub, guildId, userId, channelId] = parts;
    if (interaction.user.id !== userId) return interaction.reply({ content: "That confirmation is not for you.", ephemeral: true });
    if (sub === "cancel") return interaction.update({ content: "Server build cancelled — no history was scanned.", components: [] });
    if (sub !== "confirm" || !channelId || interaction.guildId !== guildId) return interaction.reply({ content: "That confirmation is not valid.", ephemeral: true });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "A server build requires the Manage Server permission.", ephemeral: true });
    if (serverBuildRunning) return interaction.reply({ content: "A server build is already running.", ephemeral: true });
    if (!brainFor) return interaction.reply({ content: "Server builds aren't available right now.", ephemeral: true });
    const brain = await brainFor(guildId);
    if (!brain) return interaction.reply({ content: NO_KEY_MSG, ephemeral: true });
    const channel = interaction.guild?.channels.cache.get(channelId)
      ?? await interaction.guild?.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return interaction.update({ content: "That channel no longer exists — run /server-build again.", components: [] });
    // Claim synchronously — the awaits below would otherwise let a second
    // invocation slip past the check and start a parallel build.
    serverBuildRunning = true;
    let buildStarted = false;
    try {
      await interaction.update({ content: `Server build started for #${(channel as TextChannel).name} — this runs long; results post to this channel when done.`, components: [] });
      buildStarted = true;
      // Ingest calls pipeline.process outside the job queue — pause live
      // extract claims for this guild and drain anything already claimed so
      // the two can't interleave event-pipeline writes. The wait is bounded:
      // a wedged job must not hang a build (the lease reclaims it anyway).
      pauseGuildClaims(guildId);
      waitForGuildIdle(guildId, 120_000).then(() => runServerIngest(channel as TextChannel, {
        store, brain, eventStore: evStore ?? new EventStore(),
        pipeline: new EventPipeline(), botId: interaction.client.user.id,
      })).then(async s => {
        const summary = `Server build done for #${(channel as TextChannel).name}: ${s.total.toLocaleString()} messages scanned · ${s.memoriesSaved} memories · ${s.relationshipsRecorded} relationship observations · ${s.eventsCreated} events · ${s.profilesBuilt} profiles built · ${s.llmErrors} LLM errors`;
        await announce(summary);
      }).catch(async err => {
        logError("Server build failed", err);
        await announce(`Server build for #${(channel as TextChannel).name} failed: ${(err as Error).message.slice(0, 180)}`);
      }).finally(() => { serverBuildRunning = false; resumeGuildClaims(guildId); });
      // Interaction tokens expire at ~15 min and a build can run longer — post
      // to the invoking channel, with followUp as the short-run fallback.
      async function announce(text: string) {
        const ch = interaction.channel;
        if (ch && "send" in ch) { await (ch.send as (t: string) => Promise<unknown>)(text).catch(() => {}); return; }
        await interaction.followUp(text).catch(() => {});
      }
      return;
    } finally {
      if (!buildStarted) serverBuildRunning = false;
    }
  }

  if (parts[0] === "companionreset") {
    const [, , userId] = parts;
    if (interaction.user.id !== userId) return interaction.reply({ content: "That confirmation is not for you.", ephemeral: true });
    return interaction.update({
      content: "Companions are permanently locked once awakened and cannot be reset (one companion per account).",
      components: [],
    });
  }

  if (parts[0] === "server" && parts[1] === "enable") {
    if (!interaction.guildId) {
      return interaction.reply({ content: "This button can only be used inside a Discord server.", ephemeral: true });
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: "Only server administrators (`Manage Server`) can enable Characterly in this server.",
        ephemeral: true,
      });
    }
    await store.setPaused(interaction.guildId, false);
    return interaction.reply({
      content: "Characterly is now **enabled** for this server! Members can awaken their personal companions in DMs and bring them here anytime with `/companion action:summon`.",
      ephemeral: true,
    });
  }

  if (parts[0] === "onboard") {
    const sub = parts[1];
    const userId = interaction.user.id;
    const ownerName = (interaction.user as { globalName?: string; username?: string }).globalName ?? interaction.user.username ?? userId;

    if (sub === "key") {
      const targetUserId = parts[2];
      if (targetUserId && targetUserId !== userId) {
        return interaction.reply({ content: "That button is not for you.", ephemeral: true });
      }
      if (!config.keyEncryptionSecret) {
        return interaction.reply({
          content: "The bot operator hasn't configured key storage (KEY_ENCRYPTION_SECRET) — personal keys are unavailable.",
          ephemeral: true,
        });
      }
      if (typeof (interaction as unknown as { showModal?: (m: ModalBuilder) => Promise<unknown> }).showModal !== "function") {
        return interaction.reply({ content: "Setting an API key requires modal support.", ephemeral: true });
      }
      return (interaction as unknown as { showModal: (m: ModalBuilder) => Promise<unknown> }).showModal(
        buildUserApiKeyModal("user-key"),
      );
    }

    // Link gate — same rule as the DM/message path: hosted features need a
    // linked account or a personal key. Buttons bypass the message handler, so
    // the check lives here; `onboard:key` above stays open (it IS the BYOK lane).
    if (store.creditsSupported) {
      const [account, ownKey] = await Promise.all([
        store.accountForDiscordUser(userId).catch(() => null),
        store.getGuildKey(`dm:${userId}`).catch(() => null),
      ]);
      if (!account && !ownKey) {
        return interaction.reply({
          content:
            `This needs a linked Characterly account — create one free at ${config.siteUrl} ` +
            `and run \`/link\` here, or connect your own key with **Paste API Key**.`,
          ephemeral: true,
        });
      }
    }

    if (sub === "start") {
      const existing = await store.getCompanionByOwner(userId);
      if (existing?.onboardingState === "active") {
        if (interaction.guildId) {
          await store.summonCompanion(interaction.guildId, existing.id, userId, ownerName);
          await sendCompanionSystemMessage(
            (interaction as { channel?: unknown; guild?: unknown }).channel ?? (interaction as { guild?: unknown }).guild,
            existing,
            ownerName,
            "joined",
          );
          return interaction.reply({
            content: `**${existing.name}** is now hanging out in this server!`,
            ephemeral: true,
          });
        }
        return interaction.reply({
          ...buildAwakenedCompanionPayload(existing, ownerName, findMutualGuilds(interaction.client, userId)),
          ephemeral: true,
        });
      }
      return promptUnawakenedCompanion(
        interaction as unknown as { user: { id: string; username: string; send?: (payload: any) => Promise<any> }; reply: (payload: any) => Promise<any> },
        "Let's awaken your personal companion!",
        brainFor,
      );
    }

    if (sub === "edit") {
      const targetUserId = parts[2];
      if (targetUserId && targetUserId !== userId) {
        return interaction.reply({ content: "That button is not for you.", ephemeral: true });
      }
      const existing = await store.getCompanionByOwner(userId);
      if (existing?.onboardingState === "active") {
        return interaction.reply({
          content: `Your companion **${existing.name}** is already awakened and permanently locked to your account — each account gets one permanent companion.`,
          ephemeral: true,
        });
      }
      if (typeof (interaction as unknown as { showModal?: (m: ModalBuilder) => Promise<unknown> }).showModal !== "function") {
        return interaction.reply({ content: "Editing requires modal support.", ephemeral: true });
      }
      return (interaction as unknown as { showModal: (m: ModalBuilder) => Promise<unknown> }).showModal(
        buildCompanionEditModal(existing),
      );
    }

    if (sub === "awaken") {
      const targetUserId = parts[2];
      if (targetUserId && targetUserId !== userId) {
        return interaction.reply({ content: "That button is not for you.", ephemeral: true });
      }
      const existing = await store.getCompanionByOwner(userId);
      if (existing?.onboardingState === "active") {
        return interaction.reply({
          content: `Your companion **${existing.name}** is already awakened and permanently locked to your account.`,
          ephemeral: true,
        });
      }
      // Awakening is permanent — never materialize a default companion off a
      // stale or forged button. The click must be backed by a real draft with
      // at least a name the user has seen in the preview card.
      if (!existing || !existing.name?.trim()) {
        return interaction.reply({
          content: "There's no companion draft to awaken — start with a quick-start vibe or the edit form first, then confirm the preview card.",
          ephemeral: true,
        });
      }
      const activated = await store.activateCompanion(userId, ownerName, {
        name: existing.name.trim(),
        voicePersona: existing.voicePersona?.trim() || "Casual, sharp, observant, and grounded.",
        coreTraits: existing.coreTraits?.length ? existing.coreTraits : ["observant", "loyal", "witty"],
        ownerDynamic: existing.ownerDynamic?.trim() || "Close confidant and ride-or-die friend",
        backstory: existing.backstory ?? "",
        avatarUrl: existing.avatarUrl ?? null,
      });
      inc("companion.awakened");
      const payload = buildAwakenedCompanionPayload(
        activated,
        ownerName,
        findMutualGuilds(interaction.client, userId),
      );
      return interaction.update({
        content: `**${activated.name}** is awake and permanently bound to your account!`,
        ...payload,
      });
    }

    if (sub === "preset") {
      const presetKey = parts[2];
      const targetUserId = parts[3];
      if (targetUserId && targetUserId !== userId) {
        return interaction.reply({ content: "That button is not for you.", ephemeral: true });
      }
      const existing = await store.getCompanionByOwner(userId);
      if (existing?.onboardingState === "active") {
        return interaction.reply({
          content: `Your companion **${existing.name}** is already awakened and permanently locked to your account.`,
          ephemeral: true,
        });
      }
      const preset = ONBOARDING_ARCHETYPES[presetKey];
      if (!preset) {
        return interaction.reply({ content: "Unknown companion archetype.", ephemeral: true });
      }
      const dmScope = `dm:${userId}`;
      const brain = brainFor ? await brainFor(dmScope) : null;
      if (!brain) {
        return interaction.reply({
          ...buildApiKeyOnboardingPayload(userId),
          ephemeral: true,
        });
      }
      const turn = await brain.runOnboardingTurn({
        ownerName,
        userMessage: preset.prompt,
        transcript: [],
        currentDraft: existing
          ? {
              name: existing.name,
              voicePersona: existing.voicePersona,
              coreTraits: existing.coreTraits,
              ownerDynamic: existing.ownerDynamic,
              backstory: existing.backstory,
              avatarUrl: existing.avatarUrl,
            }
          : undefined,
        turnCount: existing?.onboardingTurns ?? 0,
        allowImmediateComplete: preset.allowImmediateComplete,
        model: config.replyModel,
      });
      // Archetype presets always show the draft preview first so the user can
      // inspect and confirm before permanently locking their 1-per-account companion.
      const updatedDraft = await store.upsertCompanionOnboarding(
        userId,
        { ...turn.spec, avatarUrl: existing?.avatarUrl ?? null },
        true,
      );
      inc("companion.onboarding_turn");
      return interaction.update({
        content: turn.replyText,
        embeds: [buildOnboardingDraftEmbed(updatedDraft, updatedDraft.onboardingTurns)],
        components: [buildOnboardingDraftComponents(userId, updatedDraft)],
      });
    }

    if (sub === "summon") {
      const targetGuildId = parts[2];
      const targetUserId = parts[3];
      if (targetUserId && targetUserId !== userId) {
        return interaction.reply({ content: "That button is not for you.", ephemeral: true });
      }
      if (!targetGuildId) {
        return interaction.reply({ content: "Invalid server summon target.", ephemeral: true });
      }
      const companion = await store.getCompanionByOwner(userId);
      if (!companion || companion.onboardingState !== "active") {
        return interaction.reply({ content: "Awaken your companion first before summoning.", ephemeral: true });
      }
      // Buttons live in DMs and can be clicked long after they were rendered —
      // re-check that the owner is actually a member of the target guild right
      // now before summonCompanion auto-opts them in there.
      const targetGuild = interaction.client.guilds.cache.get(targetGuildId);
      if (!targetGuild) {
        return interaction.reply({ content: "I can't see that server anymore.", ephemeral: true });
      }
      const member = await targetGuild.members.fetch(userId).catch(() => null);
      if (!member) {
        return interaction.reply({ content: `You've left **${targetGuild.name}** — rejoin it before summoning ${companion.name} there.`, ephemeral: true });
      }
      await store.summonCompanion(targetGuildId, companion.id, userId, ownerName);
      await sendCompanionSystemMessage(targetGuild, companion, ownerName, "joined");
      const guildName = targetGuild?.name ?? "the server";
      return interaction.reply({
        content: `**${companion.name}** has been summoned to **${guildName}**! Say their name there anytime to bring them into the conversation.`,
        ephemeral: true,
      });
    }

    if (sub === "announce") {
      const targetGuildId = parts[2];
      const targetUserId = parts[3];
      if (targetUserId && targetUserId !== userId) {
        return interaction.reply({ content: "That button is not for you.", ephemeral: true });
      }
      if (!targetGuildId || interaction.guildId !== targetGuildId) {
        return interaction.reply({ content: "That announcement is no longer valid.", ephemeral: true });
      }
      const companion = await store.getCompanionByOwner(userId);
      if (!companion || companion.onboardingState !== "active") {
        return interaction.reply({ content: "Your companion isn't active yet.", ephemeral: true });
      }
      const publicEmbed = new EmbedBuilder()
        .setTitle(`${companion.name} joined the hangout`)
        .setDescription(
          `**${companion.name}** (${ownerName}'s companion) is now hanging out in this server.\n\n` +
          `**Vibe:** ${companion.voicePersona || "Observant and candid"}\n` +
          `**Traits:** ${companion.coreTraits.length ? companion.coreTraits.join(", ") : "—"}\n` +
          `**Bond with ${ownerName}:** ${companion.ownerDynamic || "Close confidant"}`,
        )
        .setFooter({ text: `Say "${companion.name}" in chat to talk to them, or awaken your own companion below.` });
      if (companion.avatarUrl) publicEmbed.setThumbnail(companion.avatarUrl);
      const publicRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("onboard:start")
          .setLabel("Awaken Your Own Companion")
          .setStyle(ButtonStyle.Primary),
      );
      const ch = interaction.channel;
      if (ch && "send" in ch) {
        await (ch.send as (p: unknown) => Promise<unknown>)({
          embeds: [publicEmbed],
          components: [publicRow],
          allowedMentions: { parse: [] },
        }).catch(() => {});
      }
      return interaction.update({
        content: `Introduced **${companion.name}** to the channel!`,
        components: [],
      });
    }
  }

  const action = parts[0];
  const rawId = parts[parts.length - 1];
  const userId = parts[parts.length - 2];
  const guildId = parts.slice(1, -2).join(":");
  if (action !== "forget" || !guildId || !userId || !rawId || interaction.user.id !== userId) return interaction.reply({ content: "That confirmation is not valid for you.", ephemeral: true });
  const memory = await store.getMemory(guildId, Number(rawId));
  if (!memory || memory.subjectId !== userId || (await store.forget(guildId, memory.id)) === 0) return interaction.update({ content: "That memory is no longer available.", components: [] });
  return interaction.update({ content: `Forgot memory **#${memory.id}**. I will not use it in future replies.`, components: [] });
}
