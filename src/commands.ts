import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, ChannelType, ChatInputCommandInteraction, EmbedBuilder, escapeMarkdown, ModalBuilder, ModalSubmitInteraction, PermissionFlagsBits, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, type Client, type MessageContextMenuCommandInteraction, type StringSelectMenuInteraction, type TextChannel } from "discord.js";
import type { Brain } from "./brain.js";
import { MemoryStore, type Memory } from "./database.js";
import { EventStore } from "./events.js";
import { ProfileStore } from "./profiles.js";
import { encryptSecret, logError, maskKey, validateLlmKey } from "./secrets.js";
import { isSafeUrl, resolvesToPrivateAddress } from "./tools.js";
import { detectProviderFromKey, guardedLlmFetch } from "./brains.js";
import { runProfileBuild, PROFILE_BUILD_COOLDOWN_MS } from "./profile-build.js";
import { inc, metricsSnapshot } from "./metrics.js";
import type { ChatImport, Companion, CompanionListing, CompanionSpec, MessageEvent } from "./types.js";
import { config } from "./config.js";
import { checkListingFields, REPORT_CATEGORIES, safetyBrain } from "./safety.js";
import { handleOpsCommand, handleHouseButton, isHouse, isMarketplaceThread } from "./ops.js";
import { CURATED_TAGS, postListingThread, buildListingCard, buildListingComponents } from "./marketplace.js";
import { parseCardFile, cardToPersona, cardImportMeta, cardFileHash, CARD_MAX_BYTES, type ImportPersona, type CardImportMeta, type ParsedCard } from "./charcard.js";
import { parseChatFile, chatImportMeta, chatFileHash, type ParsedChat, type ChatImportMeta } from "./chathist.js";
import { enqueue, pauseGuildClaims } from "./jobs.js";
import { sql } from "./db.js";

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

/** Companion system cards follow the same rule as replies: a channel (or its
 * parent, for threads) on the quiet list gets none. Returns the resolved
 * channel the card would land in so callers can check once. */
async function channelIsQuiet(store: MemoryStore, guildId: string | null | undefined, channel: { id?: string; parentId?: string | null; isThread?: () => boolean } | null | undefined): Promise<boolean> {
  if (!guildId || !channel?.id) return false;
  const settings = await store.settings(guildId);
  if (settings.quietChannels.includes(channel.id)) return true;
  // Threads follow their parent channel; isThread() keeps categories out of
  // the match (a text channel's parentId is its category).
  return channel.isThread?.() === true
    && channel.parentId != null
    && settings.quietChannels.includes(channel.parentId);
}

export async function sendCompanionSystemMessage(
  channelOrGuild: unknown,
  companion: Companion,
  ownerName: string,
  event: "joined" | "left",
  store?: MemoryStore,
  guildId?: string | null,
): Promise<boolean> {
  if (!channelOrGuild || typeof channelOrGuild !== "object") return false;
  let sendFn: ((payload: unknown) => Promise<unknown>) | undefined;
  const candidate = channelOrGuild as {
    send?: (payload: unknown) => Promise<unknown>;
    id?: string; parentId?: string | null;
    systemChannel?: { send?: (payload: unknown) => Promise<unknown>; id?: string; parentId?: string | null };
  };
  // A channel is used directly; a bare Guild falls back to its system channel
  // only — picking an arbitrary cached text channel could announce a companion
  // in a private channel the owner can't see, which is worse than silence.
  const resolved = typeof candidate.send === "function" ? candidate : candidate.systemChannel;
  if (typeof candidate.send === "function") {
    sendFn = candidate.send.bind(candidate);
  } else if (typeof candidate.systemChannel?.send === "function") {
    sendFn = candidate.systemChannel.send.bind(candidate.systemChannel);
  }
  if (!sendFn) return false;
  if (store && await channelIsQuiet(store, guildId, resolved)) return false;

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
  // Cover art: the embed's large image doubles as the forum's Gallery cover.
  // Prefilled so republish shows (and can swap/clear) the current cover.
  const coverInput = new TextInputBuilder()
    .setCustomId("listing-cover")
    .setLabel("Cover image URL (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(400)
    .setPlaceholder("https://… image URL — becomes the gallery cover");
  const prefillCover = listing?.avatarUrl ?? companion.avatarUrl;
  if (prefillCover) coverInput.setValue(prefillCover.slice(0, 400));

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(taglineInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(greetingInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(coverInput),
  );
  return modal;
}

/** Publish modal for a private import — the listing row is the source of
 *  truth (there's no awakened companion behind it). Same fields as
 *  buildPublishModal minus the persona internals, which stay as imported. */
export function buildImportPublishModal(listing: CompanionListing): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`market_pubimp:${listing.id}`)
    .setTitle("Publish Imported Character");

  const nameInput = new TextInputBuilder()
    .setCustomId("listing-name")
    .setLabel("Display name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(64)
    .setValue(listing.name.slice(0, 64));
  const taglineInput = new TextInputBuilder()
    .setCustomId("listing-tagline")
    .setLabel("Tagline (shown on the listing card)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(120)
    .setValue(listing.tagline.slice(0, 120));
  const greetingInput = new TextInputBuilder()
    .setCustomId("listing-greeting")
    .setLabel("Greeting — first DM the character sends")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(2000) // imports allow 2000 — don't silently halve long cards
    .setValue(listing.greeting.slice(0, 2000));
  const coverInput = new TextInputBuilder()
    .setCustomId("listing-cover")
    .setLabel("Cover image URL (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(400)
    .setPlaceholder("https://… image URL — becomes the gallery cover");
  if (listing.avatarUrl) coverInput.setValue(listing.avatarUrl.slice(0, 400));

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(taglineInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(greetingInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(coverInput),
  );
  return modal;
}

/** One-field URL modal for the card's Cover button. Blank input clears the
 *  cover — the same control sets and removes. */
export function buildCoverModal(listing: CompanionListing): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId("cover-url")
    .setLabel("Cover image URL — blank removes it")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(400)
    .setPlaceholder("https://… public image URL");
  if (listing.avatarUrl) input.setValue(listing.avatarUrl.slice(0, 400));
  return new ModalBuilder()
    .setCustomId(`market_cover:${listing.id}`)
    .setTitle(`Cover image — ${listing.name.slice(0, 30)}`)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
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

// Card builders + thread posting live in ./marketplace.js so ops.ts can use
// them without a commands↔ops import cycle. Re-exported for existing imports.
export { buildListingCard, buildListingComponents } from "./marketplace.js";

/** Ephemeral multi-select of the forum's creator-pickable (non-moderated)
 *  tags — the curated badges never appear here. Returns null when the forum
 *  has none so callers can simply omit the row. Options carry forum tag ids;
 *  `market:tagsel:{listingId}` re-checks ownership at submit time. */
export async function tagPickerRow(client: Client, listingId: number): Promise<ActionRowBuilder<StringSelectMenuBuilder> | null> {
  if (!config.marketplaceChannelId) return null;
  const channel = await client.channels.fetch(config.marketplaceChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildForum) return null;
  const pickable = (channel.availableTags ?? []).filter(t => !t.moderated).slice(0, 25);
  if (!pickable.length) return null;
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`market:tagsel:${listingId}`)
      .setPlaceholder("Tag this listing")
      .setMinValues(0)
      // Three picks, same as c.ai's category cap — keeps the taxonomy
      // meaningful instead of everything wearing every tag.
      .setMaxValues(Math.min(3, pickable.length))
      .setOptions(pickable.map(t => ({ label: t.name, value: t.id }))),
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

const BANNED_CREATOR_MSG = "Your marketplace access has been suspended — you can't publish new characters. If you think this is a mistake, contact a moderator.";

const DAILY_PUBLISH_MSG = `That's a lot of characters for one day — the limit is ${config.marketPublishDailyCap} new listing${config.marketPublishDailyCap === 1 ? "" : "s"} per day. Try again tomorrow.`;

/** Returns the refusal message if the user can't create a listing right now —
 *  creator ban first, then (when the write would produce a NEW listing row —
 *  `isNewListing`) the daily publish cap. Republishes/revives skip the daily
 *  check: they aren't new listings. Advisory UX check only — the store
 *  enforces both atomically at write time. */
async function publishGateError(store: MemoryStore, userId: string, isNewListing: boolean): Promise<string | null> {
  if (await store.creatorBan(userId).catch(() => null)) return BANNED_CREATOR_MSG;
  if (isNewListing) {
    const published = await store.dailyPublishCount(userId).catch(() => 0);
    if (published >= config.marketPublishDailyCap) return DAILY_PUBLISH_MSG;
  }
  return null;
}

/** Deterministic + model screens over authored listing fields. Fail-closed:
 *  a configured-but-erroring classifier refuses the write (publish isn't
 *  time-sensitive — retrying is the correct UX). */
async function screenListingFields(fields: {
  name: string; tagline: string; greeting: string; voicePersona: string;
  coreTraits: string[]; ownerDynamic: string; backstory: string;
}): Promise<string | null> {
  const det = checkListingFields(fields);
  if (!det.ok) {
    inc("safety.listing_blocked");
    return `That can't go on the marketplace — the **${det.field}** field trips the content policy (${det.category}).`;
  }
  const brain = safetyBrain();
  if (!brain) return null; // no operator key — deterministic layer only
  try {
    const verdict = await brain.safetyVerdict({
      kind: "listing",
      subject:
        `Name: ${fields.name}\nTagline: ${fields.tagline}\nGreeting: ${fields.greeting}\n` +
        `Voice: ${fields.voicePersona}\nTraits: ${fields.coreTraits.join(", ")}\n` +
        `Dynamic: ${fields.ownerDynamic}\nBackstory: ${fields.backstory}`,
    });
    if (verdict.verdict === "flag") {
      inc("safety.listing_flagged");
      return `That can't go on the marketplace — content screening flagged it${verdict.category ? ` (${verdict.category})` : ""}${verdict.reason ? `: ${verdict.reason}` : "."}`;
    }
  } catch (error) {
    inc("safety.screen_error");
    logError("listing safety screen failed", error);
    return "Content screening isn't reachable right now — try again in a moment.";
  }
  return null;
}

/** Mod-action gate: a configured marketplace role id, or ManageGuild (server
 *  admins can always act). Handles both GuildMember and raw API member shapes.
 *  Structural param type — button and context-menu interactions both fit. */
function isMarketplaceMod(interaction: { member?: unknown; memberPermissions?: { has?(f: bigint): boolean } | null }): boolean {
  const raw = (interaction.member as { roles?: unknown } | null)?.roles;
  const hasRole = config.marketplaceModRoleIds.length > 0 && (
    Array.isArray(raw)
      ? raw.some(r => config.marketplaceModRoleIds.includes(r))
      : typeof (raw as { cache?: { has(id: string): boolean } })?.cache?.has === "function" &&
        config.marketplaceModRoleIds.some(id => (raw as { cache: { has(id: string): boolean } }).cache.has(id))
  );
  const hasPerm = (interaction.memberPermissions as { has?(f: bigint): boolean } | null)?.has?.(PermissionFlagsBits.ManageGuild) ?? false;
  return hasPerm || hasRole;
}

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

/** Re-render the listing card in place after a rating lands. Best-effort —
 *  a deleted thread or archived card just skips the refresh. */
async function refreshListingCard(client: Client, listing: CompanionListing, store: MemoryStore): Promise<void> {
  if (!listing.forumThreadId || !config.marketplaceChannelId) return;
  const channel = await client.channels.fetch(config.marketplaceChannelId).catch(() => null);
  const thread = channel && channel.type === ChannelType.GuildForum
    ? await channel.threads.fetch(listing.forumThreadId).catch(() => null)
    : null;
  if (!thread) return;
  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (!starter) return;
  const creator = await client.users.fetch(listing.creatorUserId).catch(() => null);
  const creatorName = creator?.globalName ?? creator?.username ?? "a creator";
  const stats = await store.listingRatingStats(listing.id).catch(() => undefined);
  await starter.edit({
    embeds: [buildListingCard(listing, creatorName, stats)],
    components: [buildListingComponents(listing.id)],
  }).catch(() => {});
}

/** Rating gate: on the house guild, a verified Member (or a marketplace mod —
 *  staff may not carry Member). Outside the house, or when no Member role is
 *  configured (self-host), anyone holding the button may rate. */
function canRateListing(interaction: ButtonInteraction): boolean {
  if (!isHouse(interaction.guildId) || !config.houseMemberRoleId) return true;
  if (isMarketplaceMod(interaction)) return true;
  const raw = (interaction.member as { roles?: unknown } | null)?.roles;
  return Array.isArray(raw)
    ? raw.includes(config.houseMemberRoleId)
    : (raw as { cache?: { has(id: string): boolean } } | null)?.cache?.has?.(config.houseMemberRoleId) ?? false;
}

const RATE_GATE_MSG = `Verify your Characterly account in <#${config.houseVerifyChannelId}> to rate listings — it keeps review-bombing out.`;

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
  const reply = (content: string, components: ActionRowBuilder<StringSelectMenuBuilder>[] = []) =>
    isButton ? (interaction as ButtonInteraction).update({ content, components }) : interaction.reply({ content, ephemeral: true, components });

  // A stale/forged relist button must not outlive a creator ban — enforce it
  // here in the shared path, not only in the command that renders the picker.
  if (await store.creatorBan(interaction.user.id).catch(() => null)) {
    return reply(BANNED_CREATOR_MSG);
  }
  const res = await store.relistListing(listing.id, interaction.user.id, listingCapFor(store, account));
  if (!res.ok) {
    const msg =
      res.reason === "cap" ? LISTING_CAP_MSG
        : res.reason === "moderated" ? `**${listing.name}** was taken down by a moderator — only they can bring it back.`
        : res.reason === "not_delisted" ? `**${listing.name}** isn't unpublished — nothing to bring back.`
        : "That listing isn't yours to relist.";
    return reply(msg);
  }
  const threadId = await postListingThread(interaction, res.listing, store);
  if (!threadId) {
    await store.delistListing(res.listing.id);
    return reply("I couldn't create the forum post — check my permissions in the marketplace channel.");
  }
  await store.setListingThread(res.listing.id, threadId);
  inc("market.relisted");
  const tagRow = await tagPickerRow(interaction.client, res.listing.id);
  return reply(
    `**${res.listing.name}** is back on the shelf in <#${config.marketplaceChannelId}>!` +
    (tagRow ? " Pick the tags that fit it below." : "") +
    " The post's **Cover image** button sets its gallery art.",
    tagRow ? [tagRow] : [],
  );
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
    // A banned listing freezes its clones — roster queries already hide them,
    // so this only trips on stale pickers or edge paths.
    if (companion.adoptedFromListingId) {
      const listing = await store.listingById(companion.adoptedFromListingId).catch(() => null);
      if (listing?.status === "banned") {
        const msg = `**${companion.name}** was removed from the marketplace by moderation.`;
        if (isButton) return (interaction as ButtonInteraction).update({ content: msg, components: [] });
        return interaction.reply({ content: msg, ephemeral: true });
      }
    }
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
  const quietHere = await channelIsQuiet(store, interaction.guildId, interaction.channel as { id?: string; parentId?: string | null } | null);
  await sendCompanionSystemMessage(
    (interaction as { channel?: unknown }).channel ?? (interaction as { guild?: unknown }).guild,
    companion,
    interaction.user.username,
    "joined",
    store,
    interaction.guildId,
  );
  const embed = new EmbedBuilder()
    .setTitle(`${companion.name} joined the server`)
    .setDescription(
      `**${companion.name}** (${interaction.user.username}'s companion) is now hanging out in this server.\n\n` +
      `**Vibe:** ${companion.voicePersona || "Observant and candid"}\n` +
      `**Traits:** ${companion.coreTraits.length ? companion.coreTraits.join(", ") : "—"}\n` +
      `**Bond with ${interaction.user.username}:** ${companion.ownerDynamic || "Close confidant"}` +
      (quietHere ? "\n\n*Heads up — this channel is on the quiet list, so they can't speak here.*" : ""),
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
      store,
      interaction.guildId,
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
  { name: "companions-pause", description: "Admin: silence companions server-wide — Characterly still observes and remembers", default_member_permissions: PermissionFlagsBits.ManageGuild.toString() },
  { name: "companions-resume", description: "Admin: let companions speak in this server again", default_member_permissions: PermissionFlagsBits.ManageGuild.toString() },
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
  { name: "limits", description: "Admin: set this server's daily LLM-call cap", default_member_permissions: PermissionFlagsBits.ManageGuild.toString(), options: [
    { name: "daily_cap", description: "Max LLM calls per day, 0–100000 — 0 blocks all calls (resets at midnight UTC)", type: 4, required: true }
  ] },
  { name: "ignore-channel", description: "Admin: make Characterly fully ignore a channel — no archive, no replies", default_member_permissions: PermissionFlagsBits.ManageGuild.toString(), options: [
    { name: "channel", description: "Channel to ignore", type: 7, required: true, channel_types: [0, 5, 10, 11, 12, 15, 16] }
  ] },
  { name: "unignore-channel", description: "Admin: restore a channel Characterly was ignoring", default_member_permissions: PermissionFlagsBits.ManageGuild.toString(), options: [
    { name: "channel", description: "Channel to restore", type: 7, required: true, channel_types: [0, 5, 10, 11, 12, 15, 16] }
  ] },
  { name: "quiet-channel", description: "Admin: silence companions in a channel — Characterly still observes and remembers", default_member_permissions: PermissionFlagsBits.ManageGuild.toString(), options: [
    { name: "channel", description: "Channel to quiet (default: this one — threads inherit their parent)", type: 7, required: false, channel_types: [0, 5, 10, 11, 12, 15, 16] }
  ] },
  { name: "unquiet-channel", description: "Admin: let companions speak in a channel again", default_member_permissions: PermissionFlagsBits.ManageGuild.toString(), options: [
    { name: "channel", description: "Channel to unquiet (default: this one)", type: 7, required: false, channel_types: [0, 5, 10, 11, 12, 15, 16] }
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
      { name: "avatar — Set your companion's avatar (URL or upload)", value: "avatar" },
      { name: "publish — List your companion in the hub server's marketplace", value: "publish" },
      { name: "create — Author an extra marketplace character (counts toward listing slots)", value: "create" },
      { name: "unpublish — Remove your companion from the marketplace", value: "unpublish" },
      { name: "relist — Bring back an unpublished listing", value: "relist" },
      { name: "switch — Choose which companion answers in your DMs", value: "switch" },
      { name: "drop — Give up an adopted companion (12h re-adopt cooldown)", value: "drop" },
      { name: "import — Bring in a character card (.png/.json) from another platform", value: "import" },
      { name: "imports — View or undo your chat-history imports", value: "imports" },
    ] },
    { name: "avatar_url", description: "Public http(s) image URL when action is avatar", type: 3, required: false },
    { name: "avatar_file", description: "Uploaded image when action is avatar — also used as the marketplace cover", type: 11, required: false },
    { name: "card_file", description: "File to import (.png/.json character card, or .jsonl/.json chat export)", type: 11, required: false },
    { name: "user", description: "Member whose companion to inspect (card) or remove (kick)", type: 6, required: false }
  ] },
  // In a server this is the guild-scope key (admin only); in DMs it stores the
  // user's personal key — the same modal backs both paths.
  { name: "setup", description: "Connect an AI API key — server key for admins here, your personal key in DMs", default_member_permissions: PermissionFlagsBits.ManageGuild.toString() },
  { name: "link", description: "Get a one-time code to link this Discord account to your Characterly web account" },
  // House ops console — visible everywhere but refuses anyone not in
  // OPS_USER_IDS (it controls the host). Works in the house guild and DMs.
  { name: "ops", description: "Operator console — host health, deploy, house ops", options: [
    { name: "action", description: "What to do", type: 3, required: true, choices: [
      { name: "status — host + queue health", value: "status" },
      { name: "logs — last N journal lines", value: "logs" },
      { name: "restart — restart the bot onto the same code", value: "restart" },
      { name: "deploy — git pull + npm ci + restart", value: "deploy" },
      { name: "announce — post to the announcements channel", value: "announce" },
      { name: "layout — reconcile house channels, perms + resource posts", value: "layout" },
      { name: "seedmarket — populate the marketplace with the official roster", value: "seedmarket" },
    ] },
    { name: "text", description: "Announcement text (action=announce)", type: 3, required: false },
    { name: "lines", description: "Journal lines for action=logs (default 30, max 200)", type: 4, required: false },
  ] },
  // Message context menu — right-click → Apps → "Report message" on a comment
  // inside a marketplace listing thread. Validated to that surface in the
  // handler; everywhere else it replies "not reportable".
  { name: "Report message", type: 3 },
  // "Staff pick" — marketplace-mod toggle for the curated forum badge.
  { name: "Staff pick", type: 3 },
];

const confidence = (value: number | undefined) => {
  if (value === undefined) return "Unknown";
  return value >= .8 ? "High" : value >= .55 ? "Medium" : "Low";
};
const OPT_IN_HINT_SELF = "You haven't opted in yet — run /profile-build to consent and build your profile.";
const OPT_IN_HINT_OTHER = "That member hasn't opted in to profiles.";
/** Parsed character cards awaiting the user's confirm click. In-memory only —
 *  a restart just expires the preview (the button explains itself). */
const pendingImports = new Map<string, { persona: ImportPersona; meta: CardImportMeta; avatarUrl: string | null; card: ParsedCard; expires: number }>();
/** Parsed chat histories awaiting the user's companion pick — keeps the raw
 *  bytes so the companion's name can re-resolve flagless speaker names. */
const pendingChatImports = new Map<string, { bytes: Uint8Array; filename: string; sha256: string; chat: ParsedChat; meta: ChatImportMeta; expires: number }>();
const PENDING_IMPORT_TTL_MS = 15 * 60 * 1000;

/** `/companion action:imports` + the "keep" path of the undo confirm — the
 *  user's import rows as an embed with per-row undo/cancel buttons. */
async function buildImportsManager(store: MemoryStore, userId: string) {
  const imports = await store.listChatImports(userId).catch(() => [] as Array<ChatImport & { companionName: string }>);
  if (!imports.length) {
    return {
      content: "No chat-history imports yet — `/companion action:import` with a `.jsonl` or `.json` export brings them over.",
      embeds: [] as EmbedBuilder[],
      components: [] as ActionRowBuilder<ButtonBuilder>[],
    };
  }
  const lines = imports.map(i => {
    const pct = i.messageCount > 0 ? Math.min(100, Math.round(100 * i.processedTurns / i.messageCount)) : 0;
    const state = i.status === "queued" ? "queued"
      : i.status === "distilling" ? `distilling — ${pct}%`
      : i.status === "done" ? `done — ${i.keptCount} memories kept`
      : `failed${i.error ? ` — ${i.error}` : ""}`;
    return `**${escapeMarkdown(i.filename)}** → **${escapeMarkdown(i.companionName)}** · ${state}`;
  });
  const embed = new EmbedBuilder()
    .setTitle("Your chat-history imports")
    .setDescription(lines.join("\n") + "\n\n*Undoing removes every memory that import wrote — permanently.*")
    .setFooter({ text: "Importing a new history: /companion action:import" });
  const components = imports.slice(0, 4).map(i => new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`market:histundo:${i.id}`)
      .setLabel(i.status === "done" || i.status === "failed" ? `Undo — ${i.filename.slice(0, 30)}` : `Cancel — ${i.filename.slice(0, 30)}`)
      .setStyle(ButtonStyle.Danger),
  ));
  return { embeds: [embed], components };
}
/** One profile build per member at a time — claimed synchronously before any
 * await so a double-invoke can't slip past the check and double the LLM spend. */
const profileBuildsRunning = new Set<string>();
const display = (memory: Memory) => `**#${memory.id} · ${confidence(memory.confidence)} confidence**\n${memory.content}\n*${memory.mentions} confirmation${memory.mentions === 1 ? "" : "s"}; last confirmed ${new Date(memory.lastConfirmedAt).toLocaleDateString()}*`;

type BrainFor = (guildId: string) => Promise<Brain | null>;
const NO_KEY_MSG = "No AI key is configured yet — connect your personal API key with `/companion action:key` (or `/setup`).";

export const SERVER_ONLY_COMMANDS = new Set([
  "memory-purge", "memory-pause", "memory-resume", "memory-settings",
  "companions-pause", "companions-resume",
  "status", "memory-triage",
  "limits", "ignore-channel", "unignore-channel", "quiet-channel", "unquiet-channel",
]);

/** Command definitions with Discord install contexts applied — the app
 *  supports guild + user installs (dev portal), so DM-safe commands are
 *  invocable in the App DM (contexts: 0=guild, 1=bot DM; private channels
 *  (2) deliberately excluded) while server-only ones stay guild-scoped. */
export function scopedCommandDefinitions<T extends { name: string }>(defs: readonly T[]): T[] {
  return defs.map(def => SERVER_ONLY_COMMANDS.has(def.name)
    ? { ...def, integrationTypes: [0], contexts: [0] }
    : { ...def, integrationTypes: [0, 1], contexts: [0, 1] });
}

export async function handleMemoryCommand(interaction: ChatInputCommandInteraction, store: MemoryStore, brainFor: BrainFor, evStore?: EventStore, profileStore: ProfileStore = new ProfileStore()) {
  // /ops self-gates on OPS_USER_IDS and house-guild context — dispatch before
  // the server-only/link gates so an allowlisted operator can use it in DMs.
  if (interaction.commandName === "ops") return handleOpsCommand(interaction);
  if (!interaction.guildId && SERVER_ONLY_COMMANDS.has(interaction.commandName)) {
    return interaction.reply({ content: "That command can only be used inside a Discord server.", ephemeral: true });
  }
  const guildId = interaction.guildId ?? `dm:${interaction.user.id}`;
  if (interaction.commandName === "link") {
    // The bot already knows the Discord profile — snapshot it onto the code so
    // claim_link_code can stamp web_profiles.discord_username/avatar_url and a
    // code-linked account renders identically to an OAuth one.
    const code = await store.createLinkCode(interaction.user.id, 10, {
      username: interaction.user.globalName ?? interaction.user.username,
      avatarUrl: interaction.user.displayAvatarURL({ size: 64 }),
    });
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
    (interaction.commandName === "companion" &&
      (interaction.options.getString("action") === "summon" ||
        interaction.options.getString("action") === "import"));
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
            store,
            interaction.guildId,
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
      const file = interaction.options.getAttachment?.("avatar_file") ?? null;
      if (url && file) {
        return interaction.reply({ content: "Pick one — either `avatar_url` or `avatar_file`, not both.", ephemeral: true });
      }
      let avatarUrl: string;
      if (file) {
        // Discord CDN links are already public https; keep the scheme check
        // anyway so a forged/stub attachment can't smuggle another protocol.
        if (!file.contentType?.startsWith("image/")) {
          return interaction.reply({ content: "`avatar_file` must be an image upload (png, jpg, webp, gif…).", ephemeral: true });
        }
        if (!isSafeUrl(file.url)) {
          return interaction.reply({ content: "That upload didn't give me a usable image URL — try `avatar_url` instead.", ephemeral: true });
        }
        avatarUrl = file.url;
      } else {
        if (!url || !isSafeUrl(url) || await resolvesToPrivateAddress(new URL(url).hostname)) {
          return interaction.reply({ content: "Provide a public `http(s)` image in `avatar_url`, or upload one as `avatar_file`.", ephemeral: true });
        }
        avatarUrl = url;
      }
      const updated = await store.updateCompanionAvatar(interaction.user.id, avatarUrl);
      if (!updated) {
        return interaction.reply({ content: "You haven't created a companion yet — send me a DM first!", ephemeral: true });
      }
      return interaction.reply({ content: `Updated **${updated.name || "your companion"}**'s avatar — it'll show as the marketplace cover next time you publish (or use the listing's **Cover image** button).`, ephemeral: true });
    }
    if (action === "imports") {
      const view = await buildImportsManager(store, interaction.user.id);
      return interaction.reply({ ephemeral: true, ...view });
    }
    if (action === "import") {
      const file = interaction.options.getAttachment?.("card_file") ?? null;
      if (!file) {
        return interaction.reply({
          content: "Attach a file as `card_file` — a `.png` card or `.json` character export, or a `.jsonl`/`.json` chat export from wherever they lived before.",
          ephemeral: true,
        });
      }
      if (file.size > CARD_MAX_BYTES) {
        return interaction.reply({ content: "That file is over 8 MB — export a fresh copy (or a shorter slice, for a chat history) and try again.", ephemeral: true });
      }
      const isPng = file.contentType === "image/png" || /\.png$/i.test(file.name ?? "");
      const isJson = /\.json$/i.test(file.name ?? "") || file.contentType === "application/json";
      const isHistFile = /\.(jsonl|txt)$/i.test(file.name ?? "");
      if (!isPng && !isJson && !isHistFile) {
        return interaction.reply({ content: "I can read `.png`/`.json` character cards and `.jsonl` chat exports — that file is none of them.", ephemeral: true });
      }
      if (!file.url || !isSafeUrl(file.url)) {
        return interaction.reply({ content: "That upload didn't give me a usable file URL — try exporting the card again.", ephemeral: true });
      }
      // Attachment URLs are Discord-issued, but the fetch still follows
      // redirects — refuse anything that would resolve inside the network,
      // same bar as the user-typed cover-image URL.
      if (await resolvesToPrivateAddress(new URL(file.url).hostname).catch(() => true)) {
        return interaction.reply({ content: "That upload didn't give me a usable file URL — try exporting the card again.", ephemeral: true });
      }
      const bytes = await fetch(file.url)
        .then(r => (r.ok ? r.arrayBuffer() : null))
        .then(b => (b ? new Uint8Array(b) : null))
        .catch(() => null);
      if (!bytes) {
        return interaction.reply({ content: "Couldn't fetch that upload — try re-attaching the file.", ephemeral: true });
      }
      // History exports route to the transcript flow: .jsonl/.txt always,
      // .json only when it isn't a card.
      const chatRes = isHistFile || !isPng ? parseChatFile(bytes, file.name ?? "chat") : null;
      const parsed = chatRes?.ok ? null : isHistFile ? null : parseCardFile(bytes, file.name ?? "card");
      if (chatRes?.ok) {
        const chat = chatRes.chat;
        const sha256 = await chatFileHash(bytes);
        const dupe = await store.findChatImportByHash(interaction.user.id, sha256).catch(() => undefined);
        if (dupe === undefined) {
          return interaction.reply({ content: "Couldn't check your previous imports right now — try again in a moment.", ephemeral: true });
        }
        if (dupe) {
          const state = dupe.status === "done" ? "already part of them"
            : dupe.status === "failed" ? "failed last time — ask me to retry by re-uploading isn't supported yet"
            : "still being distilled";
          return interaction.reply({ content: `You've already imported this file — it's ${state}.`, ephemeral: true });
        }
        const active = await store.activeChatImportCount(interaction.user.id).catch(() => -1);
        if (active < 0) {
          return interaction.reply({ content: "Couldn't check your imports right now — try again in a moment.", ephemeral: true });
        }
        if (active >= config.chatImportCap) {
          return interaction.reply({ content: `You've got ${config.chatImportCap} imports queued or distilling already — wait for one to finish first.`, ephemeral: true });
        }
        const roster = await store.listCompanionsForUser(interaction.user.id).catch(() => []);
        if (!roster.length) {
          return interaction.reply({ content: "You need a companion to give this history to — awaken one, adopt one, or import their card first.", ephemeral: true });
        }
        const meta = chatImportMeta(chat, { filename: file.name ?? "chat", sha256, importedVia: "discord" });
        pendingChatImports.set(interaction.user.id, { bytes, filename: file.name ?? "chat", sha256, chat, meta, expires: Date.now() + PENDING_IMPORT_TTL_MS });
        for (const [k, v] of pendingChatImports) if (v.expires < Date.now()) pendingChatImports.delete(k);
        const span = chat.firstTs && chat.lastTs
          ? `${chat.firstTs.slice(0, 10)} → ${chat.lastTs.slice(0, 10)}`
          : "dates unknown";
        const buttons = roster.slice(0, 4).map(c => new ButtonBuilder()
          .setCustomId(`market:histimp:${c.id}`)
          .setLabel(`${c.name} (${c.kind === "awakened" ? "awakened" : "adopted"})`)
          .setStyle(c.kind === "awakened" ? ButtonStyle.Primary : ButtonStyle.Success));
        const embed = new EmbedBuilder()
          .setTitle(`Import this chat history?`)
          .setDescription(
            `I found **${chat.turns.length}** usable turns${chat.turns.length < chat.totalTurns ? ` (of ${chat.totalTurns})` : ""} between **${escapeMarkdown(chat.userName)}** and **${escapeMarkdown(chat.charName)}** (${span}).` +
            (chat.droppedOthers ? `\n*${chat.droppedOthers} lines from other speakers were skipped — only yours and the character's come over.*` : "") +
            `\n\nI'll read through, journal the moments that mattered as *their* memories — private, just for you — then delete the transcript itself. Pick who this history belongs to:`,
          )
          .setFooter({ text: "Distillation runs in the background — I'll DM you when the memories settle." });
        return interaction.reply({ ephemeral: true, embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)] });
      }
      if (isHistFile) {
        const why = chatRes
          ? chatRes.error === "bad_json"
            ? "That file looks like a chat export but the data inside is damaged — export a fresh copy and try again."
            : "That file isn't a chat export I can read — export a `.jsonl` (Tavern/chat) or a supported `.json` transcript."
          : "That file isn't a chat export I can read.";
        return interaction.reply({ content: why, ephemeral: true });
      }
      if (!parsed) {
        return interaction.reply({ content: "That file isn't a character card or a chat export I can read — export a `.png`/`.json` card or a `.jsonl` transcript.", ephemeral: true });
      }
      if (!parsed.ok) {
        const why =
          parsed.error === "no_card_in_png"
            ? "That PNG doesn't have character data inside it — cards carry the persona embedded in the image. Export the card (not just the picture) and try again."
            : parsed.error === "bad_json"
              ? "The data inside that file is damaged — export a fresh copy and try again."
              : "That file isn't a character card or chat export I can read — a `.png` card, `.json` card, or `.jsonl` transcript all work.";
        return interaction.reply({ content: why, ephemeral: true });
      }
      const persona = cardToPersona(parsed.card);
      const screened = checkListingFields({ ...persona });
      if (!screened.ok) {
        return interaction.reply({ content: `I can't import this card — its ${screened.field} trips the **${screened.category}** content rule.`, ephemeral: true });
      }
      const sha256 = await cardFileHash(bytes);
      // The same file re-imported is a no-op — revive/reuse the private row
      // instead of stacking duplicate companions. Fail-closed: a lookup error
      // means "unknown", not "no dupe" — proceeding would stack a duplicate.
      const dupe = await store.findUnlistedByHash(interaction.user.id, sha256).catch(() => undefined);
      if (dupe === undefined) {
        return interaction.reply({ content: "Couldn't check your previous imports right now — try again in a moment.", ephemeral: true });
      }
      if (dupe) {
        const account = await store.accountForDiscordUser(interaction.user.id).catch(() => null);
        const maxSlots = !store.creditsSupported || account?.plan === "premium" ? 1_000_000 : config.freeAdoptionSlots;
        const res = await store.adoptListing(interaction.user.id, dupe.id, { maxSlots, maxDaily: config.marketAdoptDailyCap });
        if (!res.ok) {
          const msg = res.reason === "cap"
            ? `Your roster is full — drop a companion with \`/companion action:drop\` (or go Premium) to bring **${dupe.name}** back.`
            : "You've already imported this card, and it can't rejoin your roster right now — try again later.";
          return interaction.reply({ content: msg, ephemeral: true });
        }
        const greeted = res.adoption && !res.adoption.dmIntroducedAt
          ? await sendAdoptionGreeting(interaction.user, res.companion, dupe.greeting)
          : false;
        if (greeted && res.adoption) await store.markDmIntroduced(res.adoption.id);
        return interaction.reply({
          ephemeral: true,
          content: `You've already imported this card — **${escapeMarkdown(res.companion.name)}** is ${res.revived ? "back on your roster" : "already with you"}.${greeted ? " They said hello in your DMs." : ""}`,
        });
      }
      const meta = cardImportMeta(parsed.card, { filename: file.name ?? "card", sha256, importedVia: "discord" });
      pendingImports.set(interaction.user.id, {
        persona, meta, card: parsed.card,
        avatarUrl: isPng ? file.url : null,
        expires: Date.now() + PENDING_IMPORT_TTL_MS,
      });
      // Abandoned previews are only touched again if that user clicks — sweep
      // expired entries on write so the map can't grow stale entries forever.
      for (const [k, v] of pendingImports) if (v.expires < Date.now()) pendingImports.delete(k);
      const card = parsed.card;
      const embed = new EmbedBuilder()
        .setTitle(`Import ${persona.name}?`)
        .setDescription(
          `Here's what the card says. Confirming adds **${persona.name}** to your companions — *private to you* unless you later publish them to the marketplace.` +
          (card.creator ? `\n\n*Card credits: ${escapeMarkdown(card.creator)}*` : ""),
        )
        .addFields(
          { name: "Voice & Vibe", value: persona.voicePersona.slice(0, 300) || "*(blank)*", inline: false },
          ...(persona.coreTraits.length ? [{ name: "Traits", value: persona.coreTraits.join(", "), inline: false }] : []),
          ...(persona.greeting ? [{ name: "They'll say", value: persona.greeting.slice(0, 300), inline: false }] : []),
          { name: "Card format", value: `${card.spec || "unknown"}${card.specVersion ? ` v${card.specVersion}` : ""}`, inline: true },
          { name: "Source file", value: file.name ?? "card", inline: true },
        )
        .setFooter({ text: "Imported personas keep their provenance — claimed creator + file hash are recorded for moderation." });
      if (isPng) embed.setThumbnail(file.url);
      return interaction.reply({
        ephemeral: true,
        embeds: [embed],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("market:imp:confirm").setLabel("Bring them in").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("market:imp:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    }
    if (action === "publish") {
      if (!config.marketplaceChannelId) {
        return interaction.reply({ content: "The marketplace isn't configured yet — check back soon.", ephemeral: true });
      }
      const companion = await store.getCompanionByOwner(interaction.user.id);
      // Private imports are publishable too — when both exist, ask which.
      const unlisted = await store.listUnlistedListings(interaction.user.id).catch(() => []);
      if (unlisted.length) {
        const buttons: ButtonBuilder[] = [];
        if (companion?.onboardingState === "active") {
          buttons.push(new ButtonBuilder()
            .setCustomId("market:pubpick:own")
            .setLabel(`${companion.name || "Your companion"} (awakened)`)
            .setStyle(ButtonStyle.Primary));
        }
        for (const l of unlisted.slice(0, 4)) {
          buttons.push(new ButtonBuilder()
            .setCustomId(`market:pubpick:${l.id}`)
            .setLabel(`${l.name || "Imported"} (imported)`)
            .setStyle(ButtonStyle.Success));
        }
        return interaction.reply({
          ephemeral: true,
          content: "What are you putting on the marketplace?",
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)],
        });
      }
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
      const listing = await store.listingForCompanion(companion.id);
      // Daily cap only gates a genuinely new listing row — republish/revive
      // of an existing row isn't a "new listing".
      const gateError = await publishGateError(store, interaction.user.id, !listing);
      if (gateError) return interaction.reply({ content: gateError, ephemeral: true });
      if (typeof interaction.showModal !== "function") {
        return interaction.reply({ content: "Publishing requires modal support.", ephemeral: true });
      }
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
      const gateError = await publishGateError(store, interaction.user.id, true);
      if (gateError) return interaction.reply({ content: gateError, ephemeral: true });
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
      if (await store.creatorBan(interaction.user.id).catch(() => null)) {
        return interaction.reply({ content: BANNED_CREATOR_MSG, ephemeral: true });
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
  if (interaction.commandName === "companions-pause" || interaction.commandName === "companions-resume") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can pause companions.", ephemeral: true });
    const paused = interaction.commandName === "companions-pause";
    await store.setReplyPaused(guildId, paused);
    return interaction.reply({ content: paused
      ? "Companions are silent in this server — Characterly still observes and remembers. (`/memory-pause` pauses everything.)"
      : "Companions can speak in this server again.", ephemeral: true });
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
    const flagsLine = `**Flags:** memory ${settings.memoryEnabled ? "on" : "paused"} · companion replies ${settings.replyEnabled ? "on" : "paused"} · ignored channels ${settings.ignoredChannels.length} · quiet channels ${settings.quietChannels.length}`;
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
    const quiet = settings.quietChannels.length
      ? settings.quietChannels.map(id => `<#${id}>`).join(", ")
      : "none";
    return interaction.reply({ content: `Memory collection: **${settings.memoryEnabled ? "on" : "paused"}**\nCompanion replies: **${settings.replyEnabled ? "on" : "paused"}**\nRaw-message retention: **${settings.rawRetentionDays} days**\nIgnored channels: ${ignored}\nQuiet channels (companions silent, still observing): ${quiet}\nDaily LLM cap: **${settings.llmDailyCap.toLocaleString()} calls**`, ephemeral: true });
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
      return interaction.reply({ content: `<#${channel.id}> is now invisible to Characterly — nothing there is archived or answered. (To silence just companions instead, use \`/quiet-channel\`.) Restore it with \`/unignore-channel\`.`, ephemeral: true });
    }
    if (!ignored.has(channel.id)) return interaction.reply({ content: `<#${channel.id}> isn't ignored.`, ephemeral: true });
    ignored.delete(channel.id);
    await store.setIgnoredChannels(guildId, [...ignored]);
    return interaction.reply({ content: `<#${channel.id}> is visible to Characterly again — messages there are archived and answered normally.`, ephemeral: true });
  }
  if (interaction.commandName === "quiet-channel" || interaction.commandName === "unquiet-channel") {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: "Only server administrators can change quiet channels.", ephemeral: true });
    const channel = interaction.options.getChannel("channel") ?? interaction.channel;
    if (!channel) return interaction.reply({ content: "I couldn't determine which channel you mean — pass one with the `channel` option.", ephemeral: true });
    const settings = await store.settings(guildId);
    const quiet = new Set(settings.quietChannels);
    if (interaction.commandName === "quiet-channel") {
      if (quiet.has(channel.id)) return interaction.reply({ content: `<#${channel.id}> is already quiet.`, ephemeral: true });
      quiet.add(channel.id);
      await store.setQuietChannels(guildId, [...quiet]);
      return interaction.reply({ content: `Companions won't speak in <#${channel.id}> anymore — Characterly still observes and remembers there. (Threads under it stay quiet too. For a full blackout use \`/ignore-channel\`.) Restore with \`/unquiet-channel\`.`, ephemeral: true });
    }
    if (!quiet.has(channel.id)) return interaction.reply({ content: `<#${channel.id}> isn't quiet.`, ephemeral: true });
    quiet.delete(channel.id);
    await store.setQuietChannels(guildId, [...quiet]);
    return interaction.reply({ content: `Companions can speak in <#${channel.id}> again.`, ephemeral: true });
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
    const gateError = await publishGateError(store, userId, true);
    if (gateError) return interaction.reply({ content: gateError, ephemeral: true });
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
    const screenError = await screenListingFields({
      name, tagline, greeting, voicePersona,
      coreTraits: [], ownerDynamic: "a companion who met you here", backstory,
    });
    if (screenError) return interaction.reply({ content: screenError, ephemeral: true });
    const res = await store.createListing(userId, {
      name, tagline, greeting, voicePersona,
      coreTraits: [], ownerDynamic: "a companion who met you here", backstory,
      avatarUrl: null,
    }, { maxListings: listingCapFor(store, account), maxDailyPublish: config.marketPublishDailyCap });
    if (!res.ok) {
      return interaction.reply({ content: res.reason === "daily_cap" ? DAILY_PUBLISH_MSG : LISTING_CAP_MSG, ephemeral: true });
    }
    const listing = res.listing;
    const threadId = await postListingThread(interaction, listing, store);
    if (!threadId) {
      await store.delistListing(listing.id);
      return interaction.reply({ content: "I couldn't create the forum post — check my permissions in the marketplace channel.", ephemeral: true });
    }
    await store.setListingThread(listing.id, threadId);
    inc("market.published");
    const manageRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`market:editmodal:${listing.id}`).setLabel("Edit persona").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`market:cover:${listing.id}`).setLabel("Cover image").setStyle(ButtonStyle.Secondary),
    );
    const tagRow = await tagPickerRow(interaction.client, listing.id);
    return interaction.reply({
      ephemeral: true,
      content:
        `**${listing.name}** is live in <#${config.marketplaceChannelId}>! Use **Edit persona** for traits and bond, or **Cover image** for the gallery art.` +
        (tagRow ? " Pick the tags that fit it below." : ""),
      components: [manageRow, ...(tagRow ? [tagRow] : [])],
    });
  }

  // market_pubimp:<listingId> — publish a private import. Persona internals
  // (voice/traits/dynamic/backstory) come from the listing row, not the
  // modal — the modal only collects the public-facing fields.
  if (interaction.customId.startsWith("market_pubimp:")) {
    const listingId = Number(interaction.customId.slice("market_pubimp:".length));
    const userId = interaction.user.id;
    const prior = await store.listingById(listingId);
    if (!prior || prior.creatorUserId !== userId || prior.status !== "unlisted") {
      return interaction.reply({ content: "That import isn't yours to publish.", ephemeral: true });
    }
    const account = await store.accountForDiscordUser(userId).catch(() => null);
    if (!account) {
      return interaction.reply({ content: `Publishing requires a linked account — create one at ${config.siteUrl} and run \`/link\`.`, ephemeral: true });
    }
    // An unlisted→active flip is a new public listing — same daily gate as
    // the awakened publish path (also covers the creator ban).
    const gateError = await publishGateError(store, userId, true);
    if (gateError) return interaction.reply({ content: gateError, ephemeral: true });
    const channel = await interaction.client.channels.fetch(config.marketplaceChannelId!).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildForum) {
      return interaction.reply({ content: "The marketplace channel isn't reachable — tell a moderator to check MARKETPLACE_CHANNEL_ID.", ephemeral: true });
    }
    const name = interaction.fields.getTextInputValue("listing-name").trim().slice(0, 64) || prior.name;
    const tagline = interaction.fields.getTextInputValue("listing-tagline").trim().slice(0, 120);
    const greeting = interaction.fields.getTextInputValue("listing-greeting").trim().slice(0, 2000);
    const coverField = interaction.fields.getTextInputValue("listing-cover").trim().slice(0, 400);
    let avatarUrl: string | null = null;
    if (coverField) {
      if (!isSafeUrl(coverField) || await resolvesToPrivateAddress(new URL(coverField).hostname)) {
        return interaction.reply({ content: "That cover image URL isn't a valid public `http(s)` URL.", ephemeral: true });
      }
      avatarUrl = coverField;
    }
    if (!tagline || !greeting) {
      return interaction.reply({ content: "Tagline and greeting are both required.", ephemeral: true });
    }
    // The persona internals are the imported fields — screen the whole thing;
    // publishing is where private content becomes our public surface.
    const screenError = await screenListingFields({
      name, tagline, greeting,
      voicePersona: prior.voicePersona,
      coreTraits: prior.coreTraits,
      ownerDynamic: prior.ownerDynamic,
      backstory: prior.backstory,
    });
    if (screenError) return interaction.reply({ content: screenError, ephemeral: true });
    const res = await store.publishListing(listingId, userId, {
      name, tagline, greeting, avatarUrl,
      voicePersona: prior.voicePersona,
      coreTraits: prior.coreTraits,
      ownerDynamic: prior.ownerDynamic,
      backstory: prior.backstory,
    }, listingCapFor(store, account), config.marketPublishDailyCap);
    if (!res.ok) {
      return interaction.reply({
        ephemeral: true,
        content: res.reason === "cap" ? LISTING_CAP_MSG
          : res.reason === "daily_cap" ? DAILY_PUBLISH_MSG
          : res.reason === "moderated" ? `**${prior.name}** was taken down by a moderator — only they can bring it back.`
          : "That import isn't available to publish anymore.",
      });
    }
    const listing = res.listing;
    const threadId = await postListingThread(interaction, listing, store);
    if (!threadId) {
      await store.delistListing(listing.id);
      return interaction.reply({ content: "I couldn't create the forum post — check my permissions in the marketplace channel.", ephemeral: true });
    }
    await store.setListingThread(listing.id, threadId);
    inc("market.published");
    inc("market.import_published");
    const manageRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`market:editmodal:${listing.id}`).setLabel("Edit persona").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`market:cover:${listing.id}`).setLabel("Cover image").setStyle(ButtonStyle.Secondary),
    );
    const tagRow = await tagPickerRow(interaction.client, listing.id);
    return interaction.reply({
      ephemeral: true,
      content:
        `**${listing.name}** is live in <#${config.marketplaceChannelId}>! Its import provenance stays attached for moderation.` +
        (tagRow ? " Pick the tags that fit it below." : ""),
      components: [manageRow, ...(tagRow ? [tagRow] : [])],
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
    // The modal's cover field is the avatar source of truth on publish —
    // it's prefilled with the current cover, so blank means "remove it".
    const coverField = interaction.fields.getTextInputValue("listing-cover").trim().slice(0, 400);
    let avatarUrl: string | null = null;
    if (coverField) {
      if (!isSafeUrl(coverField) || await resolvesToPrivateAddress(new URL(coverField).hostname)) {
        return interaction.reply({ content: "That cover image URL isn't a valid public `http(s)` URL.", ephemeral: true });
      }
      avatarUrl = coverField;
    }
    if (!tagline || !greeting) {
      return interaction.reply({ content: "Tagline and greeting are both required.", ephemeral: true });
    }
    const existing = await store.listingForCompanion(companion.id);
    const gateError = await publishGateError(store, userId, !existing);
    if (gateError) return interaction.reply({ content: gateError, ephemeral: true });
    // Only a republish of an already-live listing skips the slot check —
    // reviving a delisted one adds a live listing back.
    if (!existing || existing.status === "delisted") {
      const slotError = await listingSlotError(store, userId, account);
      if (slotError) return interaction.reply({ content: slotError, ephemeral: true });
    }
    // Screen the assembled persona — inherited fields are the creator's own,
    // but the listing is public content either way.
    const screenError = await screenListingFields({
      name, tagline, greeting,
      voicePersona: existing?.voicePersona ?? companion.voicePersona,
      coreTraits: existing?.coreTraits ?? companion.coreTraits,
      ownerDynamic: existing?.ownerDynamic ?? companion.ownerDynamic,
      backstory: existing?.backstory ?? companion.backstory,
    });
    if (screenError) return interaction.reply({ content: screenError, ephemeral: true });
    const res = await store.upsertListing(userId, companion.id, {
      name,
      tagline,
      voicePersona: existing?.voicePersona ?? companion.voicePersona,
      coreTraits: existing?.coreTraits ?? companion.coreTraits,
      ownerDynamic: existing?.ownerDynamic ?? companion.ownerDynamic,
      backstory: existing?.backstory ?? companion.backstory,
      greeting,
      avatarUrl,
    }, { maxListings: listingCapFor(store, account), maxDailyPublish: config.marketPublishDailyCap });
    if (!res.ok) {
      return interaction.reply({ content: res.reason === "daily_cap" ? DAILY_PUBLISH_MSG : LISTING_CAP_MSG, ephemeral: true });
    }
    const listing = res.listing;
    // Flagged/banned/mod-taken-down listings survive republish with their
    // status — save the edits but don't post a fresh card whose buttons
    // would refuse anyway.
    if (listing.status !== "active") {
      return interaction.reply({
        ephemeral: true,
        content: listing.status === "banned"
          ? `**${listing.name}** was removed by moderation and can't be republished.`
          : listing.status === "delisted"
          ? `Edits saved (v${listing.version}), but **${listing.name}** was taken down by a moderator — only they can bring it back.`
          : `Edits saved (v${listing.version}) — **${listing.name}** is still under review, so the marketplace post stays down until a moderator clears it.`,
      });
    }
    if (existing?.forumThreadId) {
      const old = await channel.threads.fetch(existing.forumThreadId).catch(() => null);
      if (old) await old.setLocked(true).then(() => old.setArchived(true)).catch(() => {});
    }
    const threadId = await postListingThread(interaction, listing, store);
    if (!threadId) {
      await store.delistListing(listing.id);
      return interaction.reply({ content: "I couldn't create the forum post — check my permissions in the marketplace channel.", ephemeral: true });
    }
    await store.setListingThread(listing.id, threadId);
    inc("market.published");
    const manageRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`market:editmodal:${listing.id}`).setLabel("Edit persona").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`market:cover:${listing.id}`).setLabel("Cover image").setStyle(ButtonStyle.Secondary),
    );
    const tagRow = await tagPickerRow(interaction.client, listing.id);
    return interaction.reply({
      ephemeral: true,
      content:
        `**${listing.name}** is live in <#${config.marketplaceChannelId}>! (v${listing.version}) — anyone can adopt them from the post.` +
        (tagRow ? " Pick the tags that fit it below." : "") +
        " Set gallery art anytime with the post's **Cover image** button.",
      components: [manageRow, ...(tagRow ? [tagRow] : [])],
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
    // Same freeze as the button that opens this modal — a submit can lag a
    // ban by minutes (modal timeouts) or be forged outright.
    if (await store.creatorBan(userId).catch(() => null)) {
      return interaction.reply({ content: BANNED_CREATOR_MSG, ephemeral: true });
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
    // Edits get the same screen as publishes — the persona is public content
    // and a flagged listing can't edit its way out of review.
    const screenError = await screenListingFields({
      name, tagline: listing.tagline, greeting: listing.greeting,
      voicePersona, coreTraits, ownerDynamic, backstory,
    });
    if (screenError) return interaction.reply({ content: screenError, ephemeral: true });
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

  // market_cover:<listingId> — cover image set/clear; edits the forum post's
  // starter message in place so the gallery cover updates immediately.
  if (interaction.customId.startsWith("market_cover:")) {
    const listingId = Number(interaction.customId.slice("market_cover:".length));
    const userId = interaction.user.id;
    const listing = await store.listingById(listingId);
    if (!listing || listing.creatorUserId !== userId) {
      return interaction.reply({ content: "That's not your listing.", ephemeral: true });
    }
    if (await store.creatorBan(userId).catch(() => null)) {
      return interaction.reply({ content: BANNED_CREATOR_MSG, ephemeral: true });
    }
    const url = interaction.fields.getTextInputValue("cover-url").trim().slice(0, 400);
    let avatarUrl: string | null = null;
    if (url) {
      if (!isSafeUrl(url) || await resolvesToPrivateAddress(new URL(url).hostname)) {
        return interaction.reply({ content: "That cover image URL isn't a valid public `http(s)` URL.", ephemeral: true });
      }
      avatarUrl = url;
    }
    const updated = await store.updateListing(listing.id, userId, {
      name: listing.name, tagline: listing.tagline, voicePersona: listing.voicePersona,
      coreTraits: listing.coreTraits, ownerDynamic: listing.ownerDynamic,
      backstory: listing.backstory, greeting: listing.greeting, avatarUrl,
    });
    if (!updated) {
      return interaction.reply({ content: "That's not your listing.", ephemeral: true });
    }
    // Re-render the OP card in place — same helper the rating flow uses, so
    // the gallery cover updates immediately without a repost.
    await refreshListingCard(interaction.client, updated, store);
    inc("market.coverSet");
    return interaction.reply({
      ephemeral: true,
      content: avatarUrl
        ? `Cover updated for **${updated.name}** — the forum post refreshes in place.`
        : `Cover removed from **${updated.name}** — the card still renders normally.`,
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

  // house:* — the verify-gate button on our own community server.
  if (parts[0] === "house") return handleHouseButton(interaction);

  // market:{add|report|reportcat|talk|summon|dismiss|drop|unlist|relist|editmodal}:{id}
  // market:mod:{unflag|delist|ban|bancreator}:{listingId} — the companion
  // marketplace. Add/Report live on public forum cards and stay put after the
  // click; talk/summon/dismiss/drop are picker buttons on the caller's own
  // ephemeral replies, so they replace the message. Ownership is always
  // re-derived from the roster — the button ID alone authorizes nothing.
  if (parts[0] === "market") {
    const sub = parts[1];
    const userId = interaction.user.id;

    // Character-card import confirm/cancel — the parsed card waits in
    // pendingImports; the button id alone carries nothing.
    if (sub === "imp") {
      const act = parts[2];
      const pending = pendingImports.get(userId);
      if (act === "cancel") {
        pendingImports.delete(userId);
        return interaction.update({ content: "Import cancelled — nothing was created.", components: [] });
      }
      if (!pending || pending.expires < Date.now()) {
        pendingImports.delete(userId);
        return interaction.update({ content: "That import preview expired — run `/companion action:import` again.", components: [] });
      }
      pendingImports.delete(userId);
      const account = await store.accountForDiscordUser(userId).catch(() => null);
      const maxSlots = !store.creditsSupported || account?.plan === "premium" ? 1_000_000 : config.freeAdoptionSlots;
      // Fail-closed: this count IS the import cap on the Discord lane — a
      // lookup error must not read as "zero imports held".
      const held = await store.listUnlistedListings(userId).catch(() => null);
      if (!held) {
        return interaction.update({ content: "Couldn't check your imports right now — try again in a moment.", components: [] });
      }
      if (held.length >= config.characterImportCap) {
        return interaction.update({
          content: `You're holding ${config.characterImportCap} imported characters already — publish one to the marketplace or delete one before importing more.`,
          components: [],
        });
      }
      const created = await store.createListing(userId, { ...pending.persona, avatarUrl: pending.avatarUrl }, {
        status: "unlisted",
        personaSource: "card_import",
        importMeta: pending.meta as unknown as Record<string, unknown>,
      });
      if (!created.ok) {
        return interaction.update({ content: "Couldn't save the import — try again in a moment.", components: [] });
      }
      const res = await store.adoptListing(userId, created.listing.id, { maxSlots, maxDaily: config.marketAdoptDailyCap });
      if (!res.ok) {
        // Adoption failed → the private row is orphaned; clean it up so a
        // retry isn't told "already imported".
        await store.deleteUnlistedListing(created.listing.id, userId).catch(() => {});
        const msg = res.reason === "cap"
          ? `Your companion roster is full — free accounts hold ${config.freeAdoptionSlots} adopted companion${config.freeAdoptionSlots === 1 ? "" : "s"}. Drop one with \`/companion action:drop\` or go Premium, then import again: ${config.siteUrl}/dashboard#billing`
          : res.reason === "daily_cap"
            ? "That's a lot of new companions today — try again tomorrow."
            : "Couldn't bring that character in — try again in a moment.";
        return interaction.update({ content: msg, components: [] });
      }
      if (!res.reused) await store.claimDmCompanionIfUnset(userId, res.companion.id);
      const greeted = res.adoption && !res.adoption.dmIntroducedAt
        ? await sendAdoptionGreeting(interaction.user, res.companion, created.listing.greeting)
        : false;
      if (greeted && res.adoption) await store.markDmIntroduced(res.adoption.id);
      inc("market.imported");
      return interaction.update({
        content:
          `**${res.companion.name}** is here! ${greeted ? "They've just introduced themselves in your DMs." : "Say hi in your DMs — or pick them up anytime with `/companion action:switch`."}` +
          `\n\n*Imported personas stay private — publishing to the marketplace is a separate choice (\`/companion action:publish\`).*`,
        components: [],
      });
    }

    // Publish picker — "own" runs the normal awakened flow; a listing id
    // opens the import-publish modal. Errors reply ephemeral so the picker
    // message survives; modals can't replace it anyway.
    // Chat-history import: the picker chose which companion the transcript
    // belongs to — re-parse with their name (flagless exports resolve better),
    // create the import row, hand off to the distillation worker.
    if (sub === "histimp") {
      const companionId = Number(parts[2]);
      const pending = pendingChatImports.get(userId);
      if (!pending || pending.expires < Date.now()) {
        pendingChatImports.delete(userId);
        return interaction.update({ content: "That import preview expired — run `/companion action:import` again.", components: [] });
      }
      const roster = await store.listCompanionsForUser(userId).catch(() => []);
      const target = roster.find(c => c.id === companionId);
      if (!target) {
        return interaction.update({ content: "That companion isn't on your roster — pick again.", components: [] });
      }
      pendingChatImports.delete(userId);
      const reParsed = parseChatFile(pending.bytes, pending.filename, { charName: target.name });
      const chat = reParsed.ok ? reParsed.chat : pending.chat;
      const meta = { ...pending.meta, companionName: target.name };
      const created = await store.createChatImport(userId, target.id, {
        filename: pending.filename, sha256: pending.sha256, format: chat.format,
        turns: chat.turns,
        speakers: { user: chat.userName, char: chat.charName },
        meta,
      });
      await enqueue(sql, `dm:${userId}`, "chat-import", { importId: created.id });
      return interaction.update({
        content: `**${pending.filename}** queued — I'll distill the memories into **${target.name}** a few turns at a time and DM you when they're settled. Their journal stays private to you.`,
        components: [],
      });
    }

    // Undo a chat-history import — confirm step, then the owner-scoped delete
    // cascades every journal entry the import wrote.
    if (sub === "histundo") {
      const importId = Number(parts[2]);
      const imp = await store.chatImportById(importId);
      if (!imp || imp.ownerUserId !== userId) {
        return interaction.update({ content: "That import is already gone.", components: [] });
      }
      const companion = await store.getCompanionById(imp.companionId);
      const what = imp.status === "done"
        ? `the **${imp.keptCount} memories** **${companion?.name ?? "they"}** carried over`
        : `whatever memories the import wrote so far (the rest stops too)`;
      return interaction.update({
        content: `Remove ${what} from **${imp.filename}**? The transcript's already gone — this retracts the memories, permanently.`,
        embeds: [],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`market:histdo:${imp.id}`).setLabel("Remove the memories").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("market:histno").setLabel("Keep them").setStyle(ButtonStyle.Secondary),
        )],
      });
    }
    if (sub === "histdo") {
      const importId = Number(parts[2]);
      const removed = await store.deleteChatImport(userId, importId);
      return interaction.update({
        content: removed
          ? `Done — everything **${removed.filename}** distilled is forgotten. The companion only knows what you've lived here now.`
          : "That import is already gone.",
        embeds: [],
        components: [],
      });
    }
    if (sub === "histno") {
      const view = await buildImportsManager(store, userId);
      return interaction.update({ content: null, ...view });
    }

    if (sub === "pubpick") {
      const pick = parts[2];
      if (pick === "own") {
        const companion = await store.getCompanionByOwner(userId);
        if (!companion || companion.onboardingState !== "active") {
          return interaction.reply({ content: "You need an awakened companion before you can publish them.", ephemeral: true });
        }
        const account = await store.accountForDiscordUser(userId).catch(() => null);
        if (!account) {
          return interaction.reply({ content: `Publishing requires a linked Characterly account — create one at ${config.siteUrl} and run \`/link\` first.`, ephemeral: true });
        }
        const listing = await store.listingForCompanion(companion.id);
        const gateError = await publishGateError(store, userId, !listing);
        if (gateError) return interaction.reply({ content: gateError, ephemeral: true });
        if (!listing || listing.status === "delisted") {
          const slotError = await listingSlotError(store, userId, account);
          if (slotError) return interaction.reply({ content: slotError, ephemeral: true });
        }
        return interaction.showModal(buildPublishModal(companion, listing));
      }
      const listingId = Number(pick);
      if (!Number.isFinite(listingId)) return interaction.reply({ content: "That button is no longer valid.", ephemeral: true });
      const listing = await store.listingById(listingId);
      if (!listing || listing.creatorUserId !== userId || listing.status !== "unlisted") {
        return interaction.reply({ content: "That import isn't available to publish.", ephemeral: true });
      }
      const account = await store.accountForDiscordUser(userId).catch(() => null);
      if (!account) {
        return interaction.reply({ content: `Publishing requires a linked Characterly account — create one at ${config.siteUrl} and run \`/link\` first.`, ephemeral: true });
      }
      // Publishing an import produces a NEW public listing — the daily cap
      // applies just like a fresh awakened publish (publishGateError also
      // covers the creator ban).
      const gateError = await publishGateError(store, userId, true);
      if (gateError) return interaction.reply({ content: gateError, ephemeral: true });
      return interaction.showModal(buildImportPublishModal(listing));
    }

    // Moderator actions on a listing — role-gated, audit-logged.
    if (sub === "mod") {
      const action = parts[2];
      const listingId = Number(parts[3]);
      if (!Number.isFinite(listingId)) return interaction.reply({ content: "That button is no longer valid.", ephemeral: true });
      if (!isMarketplaceMod(interaction)) {
        return interaction.reply({ content: "Moderator role required.", ephemeral: true });
      }
      const listing = await store.listingById(listingId);
      if (!listing) {
        return interaction.update({ content: `Listing ${listingId} no longer exists.`, components: [] });
      }
      const archiveThread = async (threadId: string | null) => {
        if (!threadId || !config.marketplaceChannelId) return;
        const channel = await interaction.client.channels.fetch(config.marketplaceChannelId).catch(() => null);
        const thread = channel && channel.type === ChannelType.GuildForum
          ? await channel.threads.fetch(threadId).catch(() => null)
          : null;
        if (thread) await thread.setLocked(true).then(() => thread.setArchived(true)).catch(() => {});
      };
      if (action === "unflag" || action === "delist" || action === "ban") {
        const updated = await store.modAction(listingId, userId, action);
        if (!updated) {
          return interaction.update({ content: `**${listing.name}** is already ${listing.status} — nothing to do.`, components: [] });
        }
        if (action !== "unflag") await archiveThread(listing.forumThreadId);
        inc(`market.mod_${action}`);
        const verb =
          action === "unflag"
            // banned→flagged lands back in the review queue; flagged and
            // mod-delisted both restore to live.
            ? updated.status === "flagged" ? "Ban softened — back under review (flagged)" : "Restored — listing is back up"
            : action === "delist" ? "Delisted (clones keep their companions)" : "Banned — clones frozen";
        return interaction.update({
          content:
            `${interaction.message.content}\n—\n` +
            `**${verb}** by <@${userId}> · <t:${Math.floor(Date.now() / 1000)}:R>`,
          components: [],
        });
      }
      if (action === "bancreator") {
        const banned = await store.banCreator(listing.creatorUserId, userId);
        for (const l of banned) await archiveThread(l.forumThreadId);
        inc("market.mod_bancreator");
        return interaction.update({
          content:
            `${interaction.message.content}\n—\n` +
            `**Creator <@${listing.creatorUserId}> banned** — ${banned.length} listing${banned.length === 1 ? "" : "s"} banned, clones frozen — by <@${userId}> · <t:${Math.floor(Date.now() / 1000)}:R>`,
          components: [],
        });
      }
      return interaction.reply({ content: "Unknown moderation action.", ephemeral: true });
    }

    // Moderator actions on a reported comment — `market:modmsg:{action}:{channelId}:{messageId}:{authorId}`.
    // The author id travels in the customId but is re-resolved from the report
    // row where possible (forged buttons still need a real mod to click, but
    // don't hand out leverage anyway).
    if (sub === "modmsg") {
      const action = parts[2];
      const channelId = parts[3];
      const messageId = parts[4];
      if (!channelId || !messageId) return interaction.reply({ content: "That button is no longer valid.", ephemeral: true });
      if (!isMarketplaceMod(interaction)) {
        return interaction.reply({ content: "Moderator role required.", ephemeral: true });
      }
      const stamp = `by <@${userId}> · <t:${Math.floor(Date.now() / 1000)}:R>`;
      if (action === "keep") {
        inc("market.modmsg_keep");
        return interaction.update({ content: `${interaction.message.content}\n—\n**Comment kept** — report dismissed ${stamp}`, components: [] });
      }
      if (action === "del") {
        const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
        const target = channel && "messages" in channel
          ? await (channel as TextChannel).messages.fetch(messageId).then(m => m.delete()).then(() => true).catch(() => false)
          : false;
        inc("market.modmsg_del");
        return interaction.update({
          content: `${interaction.message.content}\n—\n**Comment ${target ? "deleted" : "already gone"}** ${stamp}`,
          components: [],
        });
      }
      if (action === "timeout") {
        const rec = await store.commentReportFor(messageId).catch(() => null);
        const authorId = rec?.authorUserId ?? parts[5];
        const timedOut = authorId && interaction.guild
          ? await interaction.guild.members.edit(authorId, {
              communicationDisabledUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
              reason: `comment report: ${messageId}`,
            }).then(() => true).catch(() => false)
          : false;
        inc("market.modmsg_timeout");
        return interaction.update({
          content: `${interaction.message.content}\n—\n**Author ${timedOut ? "timed out for 10m" : "timeout failed — they may have left"}** ${stamp}`,
          components: [],
        });
      }
      return interaction.reply({ content: "Unknown moderation action.", ephemeral: true });
    }

    // Comment report category picked — `market:commentcat:{channelId}:{messageId}:{category}`.
    // The context-command entry checks the thread + author, but customIds are
    // forgeable — the button must re-verify both, or a forged id files a
    // "comment report" on any message anywhere and aims a Timeout button at
    // an innocent user.
    if (sub === "commentcat") {
      const channelId = parts[2];
      const messageId = parts[3];
      const category = COMMENT_REPORT_CATEGORIES.some(([c]) => c === parts[4]) ? parts[4] : "other";
      const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
      if (!channel || !isMarketplaceThread(channel)) {
        return interaction.update({ content: "That button only works inside marketplace listing threads.", components: [] });
      }
      const target = "messages" in channel
        ? await (channel as TextChannel).messages.fetch(messageId).catch(() => null)
        : null;
      if (!target) {
        return interaction.update({ content: "That comment is already gone.", components: [] });
      }
      if (target.author.bot) {
        return interaction.update({ content: "That's a system message — use **Report** on the listing card for listing issues.", components: [] });
      }
      if (target.author.id === userId) {
        return interaction.update({ content: "You can't report your own comment.", components: [] });
      }
      const listing = await store.listingByThreadId(channelId).catch(() => null);
      const rep = await store.reportComment({
        listingId: listing?.id ?? null,
        threadId: channelId,
        messageId,
        authorUserId: target.author.id,
        reporterUserId: userId,
        category,
      }, config.marketReportDailyCap);
      if (!rep.ok) {
        return interaction.update({
          content: rep.reason === "daily_cap"
            ? `You've filed ${config.marketReportDailyCap} reports today — that's the limit.`
            : "You've already reported that comment — the team has it.",
          components: [],
        });
      }
      if (config.marketplaceModChannelId) {
        const catLabel = COMMENT_REPORT_CATEGORIES.find(([c]) => c === category)?.[1] ?? category;
        const modChannel = await interaction.client.channels.fetch(config.marketplaceModChannelId).catch(() => null);
        if (modChannel?.isTextBased() && "send" in modChannel) {
          // Quoted content can carry mentions — suppress parsing entirely, then
          // allow-list just the author/reporter pings we emit ourselves.
          const excerpt = escapeMarkdown(target.content.trim().replace(/\n+/g, " ")).slice(0, 400) || "*(no text)*";
          await (modChannel as TextChannel).send({
            allowedMentions: { parse: [], users: [target.author.id, userId] },
            content:
              `💬 **${catLabel}** — comment report on **${listing?.name ?? "an unlisted thread"}** (listing ${listing?.id ?? "?"}) in <#${channelId}>\n` +
              `Author <@${target.author.id}> · reported by <@${userId}>\n> ${excerpt}\n` +
              `https://discord.com/channels/${interaction.guildId}/${channelId}/${messageId}`,
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId(`market:modmsg:keep:${channelId}:${messageId}:${target.author.id}`).setLabel("Keep").setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`market:modmsg:del:${channelId}:${messageId}:${target.author.id}`).setLabel("Delete comment").setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`market:modmsg:timeout:${channelId}:${messageId}:${target.author.id}`).setLabel("Timeout author (10m)").setStyle(ButtonStyle.Danger),
            )],
          }).catch(() => {});
        }
      }
      inc("market.comment_reported");
      return interaction.update({ content: `Thanks — your **${COMMENT_REPORT_CATEGORIES.find(([c]) => c === category)?.[1] ?? category}** report is with the mods.`, components: [] });
    }

    const id = Number(parts[2]);
    if (!Number.isFinite(id)) return interaction.reply({ content: "That button is no longer valid.", ephemeral: true });

    // Listing rating — `market:rate:{id}` opens an ephemeral ★1–5 picker;
    // `market:rateval:{id}:{stars}` records it. Re-rating is an upsert.
    if (sub === "rate") {
      const listing = await store.listingById(id);
      if (!listing || listing.status !== "active") {
        return interaction.reply({ content: "That listing is no longer available.", ephemeral: true });
      }
      if (listing.creatorUserId === userId) {
        return interaction.reply({ content: "You can't rate your own listing.", ephemeral: true });
      }
      if (!canRateListing(interaction)) {
        return interaction.reply({ content: RATE_GATE_MSG, ephemeral: true });
      }
      return interaction.reply({
        ephemeral: true,
        content: `How's **${listing.name}** treating you?`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...[1, 2, 3, 4, 5].map(n =>
            new ButtonBuilder().setCustomId(`market:rateval:${id}:${n}`).setLabel("★".repeat(n)).setStyle(ButtonStyle.Primary),
          ),
        )],
      });
    }

    // Creator tag picker — `market:tags:{id}` opens the ephemeral select of
    // the forum's non-moderated tags. The `market:tagsel` select (dispatched
    // to handleMarketSelect) does the write.
    if (sub === "tags") {
      const listing = await store.listingById(id);
      if (!listing || listing.creatorUserId !== userId) {
        return interaction.reply({ content: "That's not your listing to tag.", ephemeral: true });
      }
      const row = await tagPickerRow(interaction.client, id);
      if (!row) {
        return interaction.reply({ content: "This marketplace doesn't have any pickable tags yet — moderated badges like New and Top Rated stay automatic.", ephemeral: true });
      }
      return interaction.reply({
        ephemeral: true,
        content: `Pick the tags for **${listing.name}** — curated badges (New, Top Rated…) stay automatic either way.`,
        components: [row],
      });
    }

    if (sub === "rateval") {
      const stars = Number(parts[3]);
      const listing = await store.listingById(id);
      if (!listing || listing.status !== "active") {
        return interaction.update({ content: "That listing is no longer available.", components: [] });
      }
      if (listing.creatorUserId === userId) {
        return interaction.update({ content: "You can't rate your own listing.", components: [] });
      }
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
        return interaction.update({ content: "That rating isn't valid.", components: [] });
      }
      if (!canRateListing(interaction)) {
        return interaction.update({ content: RATE_GATE_MSG, components: [] });
      }
      await store.rateListing(id, userId, stars);
      inc("market.rated");
      await refreshListingCard(interaction.client, listing, store);
      return interaction.update({ content: `Rated **${listing.name}** ${"★".repeat(stars)} — the card's been updated.`, components: [] });
    }

    if (sub === "add") {
      const listing = await store.listingById(id);
      if (!listing || listing.status !== "active") {
        return interaction.reply({ content: "That listing is no longer available.", ephemeral: true });
      }
      // Hosted lane needs a linked account BEFORE the adoption lands — an
      // unlinked adopter otherwise owns a companion they can't chat with and
      // only hits the DM link gate afterwards. undefined = the lookup broke:
      // fail soft with a retry prompt, never a fake "no account". BYOK keeps
      // its lane — a personal key covers chat unlinked, same as the DM gate.
      const account = store.creditsSupported
        ? await store.accountForDiscordUser(userId).catch(() => undefined)
        : null;
      if (store.creditsSupported && account === undefined) {
        return interaction.reply({ content: "Couldn't check your account right now — try again in a moment.", ephemeral: true });
      }
      if (store.creditsSupported && !account
          && !(await store.getGuildKey(`dm:${userId}`).catch(() => null))) {
        return interaction.reply({
          ephemeral: true,
          content: config.houseVerifyChannelId
            ? `You need a linked Characterly account to adopt companions — press **Verify** in <#${config.houseVerifyChannelId}> and it'll walk you through it, then come back.`
            : `You need a linked Characterly account to adopt companions — create one free at ${config.siteUrl} and run \`/link\` in my DMs, then come back.`,
        });
      }
      // Self-host lane has no billing → no adoption cap; hosted free = FREE_ADOPTION_SLOTS, premium uncapped.
      // The daily anti-farming cap is enforced inside the transaction so
      // parallel Add clicks can't both squeeze under it.
      const maxSlots = !store.creditsSupported || account?.plan === "premium"
        ? Number.MAX_SAFE_INTEGER
        : config.freeAdoptionSlots;
      const res = await store.adoptListing(userId, id, { maxSlots, maxDaily: config.marketAdoptDailyCap });
      if (!res.ok) {
        const msg =
          res.reason === "cap" ? `Free accounts can have ${config.freeAdoptionSlots} active adoption${config.freeAdoptionSlots === 1 ? "" : "s"} — drop one first, or go Premium for unlimited: ${config.siteUrl}/dashboard#billing`
          : res.reason === "daily_cap" ? `That's a lot of adoptions for one day — the limit is ${config.marketAdoptDailyCap}. Try again tomorrow.`
          : res.reason === "cooldown" ? `You dropped **${listing.name}** recently — you can adopt them again ${res.cooldownUntil ? `<t:${Math.floor(new Date(res.cooldownUntil).getTime() / 1000)}:R>` : "in about 12 hours"}.`
          : res.reason === "own_listing" ? `**${listing.name}** is your own companion — they're already bound to you.`
          : "That listing is no longer available.";
        return interaction.reply({ content: msg, ephemeral: true });
      }
      await store.setActiveDmCompanion(userId, res.companion.id);
      const greeted = await sendAdoptionGreeting(interaction.user, res.companion, listing.greeting);
      if (greeted) await store.markDmIntroduced(res.adoption.id);
      inc("market.adopted");
      // A user who only ever adopts never sees the DM onboarding path — keep
      // the permanent awakened bond discoverable.
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
      // Two-step: pick a category first — categorized reports triage far
      // better than a bare counter, and each row carries it for the queue.
      const catRows = [0, 4].map(offset =>
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...REPORT_CATEGORIES.slice(offset, offset + 4).map(([cat, label]) =>
            new ButtonBuilder()
              .setCustomId(`market:reportcat:${id}:${cat}`)
              .setLabel(label)
              .setStyle(cat === "minor" ? ButtonStyle.Danger : ButtonStyle.Secondary),
          ),
        ),
      );
      return interaction.reply({
        ephemeral: true,
        content: `What's wrong with **${listing.name}**? Pick the closest reason:`,
        components: catRows,
      });
    }

    if (sub === "reportcat") {
      // parts[3] is attacker-controlled — a forged customId could inject an
      // arbitrary string (incl. @everyone) into the mod-channel ping. Only
      // whitelisted categories reach the store or any message.
      const category = REPORT_CATEGORIES.some(([c]) => c === parts[3]) ? parts[3] : "other";
      const listing = await store.listingById(id);
      if (!listing || listing.status !== "active") {
        return interaction.update({ content: "That listing is no longer available.", components: [] });
      }
      if (listing.creatorUserId === userId) {
        return interaction.update({ content: "This is your own listing.", components: [] });
      }
      // The daily report cap is enforced inside the store transaction —
      // parallel clicks can't bomb past it.
      const rep = await store.reportListing(id, userId, category, "", config.marketReportDailyCap);
      if (!rep.ok) {
        return interaction.update({
          content: rep.reason === "daily_cap"
            ? `You've filed ${config.marketReportDailyCap} reports today — that's the limit.`
            : "You've already reported this listing — the team has it.",
          components: [],
        });
      }
      const count = rep.count;
      const flagged = count >= config.marketplaceReportFlagThreshold && listing.status === "active" && await store.flagListing(id);
      if (config.marketplaceModChannelId) {
        const catLabel = REPORT_CATEGORIES.find(([c]) => c === category)?.[1] ?? category;
        const modChannel = await interaction.client.channels.fetch(config.marketplaceModChannelId).catch(() => null);
        if (modChannel?.isTextBased() && "send" in modChannel) {
          // Imported personas carry their claimed creator + file hash — a
          // theft report can be judged against the card's own stamp. These
          // strings are card-author-controlled: escape + cap them, and never
          // let the content parse mentions (the creator ping is allow-listed).
          const provenance = listing.personaSource === "card_import" && listing.importMeta
            ? `\nImported card · claimed creator: **${escapeMarkdown(String(listing.importMeta.creator || "unknown").slice(0, 120))}** · spec: ${escapeMarkdown(String(listing.importMeta.spec || "?").slice(0, 40))} · sha256: \`${String(listing.importMeta.sha256 || "?").slice(0, 12)}…\``
            : "";
          await (modChannel as TextChannel).send({
            allowedMentions: { parse: [], users: [listing.creatorUserId] },
            content:
              `🚩 **${catLabel}** report on **${escapeMarkdown(listing.name)}** (id ${listing.id}, creator <@${listing.creatorUserId}>) — ` +
              `${count} report${count === 1 ? "" : "s"} total${flagged ? " — **auto-flagged, new Adds blocked**" : ""}.${provenance}`,
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId(`market:mod:unflag:${id}`).setLabel("Keep up").setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`market:mod:delist:${id}`).setLabel("Delist").setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`market:mod:ban:${id}`).setLabel("Ban listing").setStyle(ButtonStyle.Danger),
              new ButtonBuilder().setCustomId(`market:mod:bancreator:${id}`).setLabel("Ban creator").setStyle(ButtonStyle.Danger),
            )],
          }).catch(() => {});
        }
      }
      inc("market.reported");
      return interaction.update({ content: `Thanks — your **${REPORT_CATEGORIES.find(([c]) => c === category)?.[1] ?? category}** report has been recorded${flagged ? " and the listing is now under review" : ""}.`, components: [] });
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
      // A creator-ban freezes their marketplace surface — edits too, not just
      // publishes/relists. Button customIds are forgeable, so check here.
      if (await store.creatorBan(userId).catch(() => null)) {
        return interaction.reply({ content: BANNED_CREATOR_MSG, ephemeral: true });
      }
      if (typeof interaction.showModal !== "function") {
        return interaction.reply({ content: "Editing requires modal support.", ephemeral: true });
      }
      return interaction.showModal(buildMarketPersonaModal(listing));
    }
    if (sub === "cover") {
      const listing = await store.listingById(id);
      if (!listing || listing.creatorUserId !== userId) {
        return interaction.reply({ content: "That's not your listing.", ephemeral: true });
      }
      if (await store.creatorBan(userId).catch(() => null)) {
        return interaction.reply({ content: BANNED_CREATOR_MSG, ephemeral: true });
      }
      if (typeof interaction.showModal !== "function") {
        return interaction.reply({ content: "Setting a cover requires modal support.", ephemeral: true });
      }
      return interaction.showModal(buildCoverModal(listing));
    }
    return;
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

  // server:decline — the card's opt-out is a two-step. Removing is instant
  // and irreversible (GuildDelete purges every stored row), so the first
  // click opens an ephemeral confirm instead of touching the shared card —
  // a stray admin click must not wipe an established guild, and a confirm
  // state on the shared card could strand Enable/Awaken for everyone else.
  // The confirm carries the card's message id so it can be marked on the
  // way out.
  if (parts[0] === "server" && parts[1] === "decline") {
    if (!interaction.guildId) {
      return interaction.reply({ content: "This button can only be used inside a Discord server.", ephemeral: true });
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: "Only server administrators (`Manage Server`) can remove Characterly from this server.",
        ephemeral: true,
      });
    }
    const cardId = interaction.message?.id ?? "";
    return interaction.reply({
      ephemeral: true,
      content:
        "**Remove Characterly from this server?** The bot leaves immediately and every row it stored here — " +
        "members' memories, profiles, settings — is permanently deleted. This can't be undone.",
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`server:declineconfirm:${cardId}`)
          .setLabel("Yes — remove and delete everything")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("server:declinecancel")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary),
      )],
    });
  }

  if (parts[0] === "server" && parts[1] === "declinecancel") {
    return interaction.update({ content: "Cancelled — Characterly stays.", components: [] });
  }

  if (parts[0] === "server" && parts[1] === "declineconfirm") {
    const cardId = parts[2];
    if (!interaction.guildId) {
      return interaction.reply({ content: "This button can only be used inside a Discord server.", ephemeral: true });
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: "Only server administrators (`Manage Server`) can remove Characterly from this server.",
        ephemeral: true,
      });
    }
    // interaction.guild resolves from the guild cache — fall back to a fetch
    // so a cold cache right after a restart doesn't false-refuse a real
    // click, and a second admin's confirm (after the first already left)
    // gets a clean answer instead of a 404.
    const guild = interaction.guild
      ?? await interaction.client.guilds.fetch(interaction.guildId).catch(() => null);
    if (!guild) {
      return interaction.update({ content: "I'm already gone from this server.", components: [] });
    }
    await interaction.update({ content: "Removing Characterly — every stored row is being deleted.", components: [] });
    // Mark the card so nobody clicks Enable on a dead card. If it's already
    // deleted that's fine — leaving is what matters.
    const channel = interaction.channel;
    const card = cardId && channel && "messages" in channel
      ? await (channel as TextChannel).messages.fetch(cardId).catch(() => null)
      : null;
    if (card) {
      await card.edit({
        content: "Characterly is leaving this server — every row it stored here is being deleted. Re-invite anytime.",
        components: [],
      }).catch(() => {});
    }
    // Leave BEFORE any further sends — the bot can't message once it's gone.
    const left = await guild.leave().then(() => true).catch(async error => {
      inc("server.decline_error");
      logError("Decline-and-leave failed", error);
      // A second admin's confirm can land after the first already left — the
      // 404 isn't a failure worth escalating, just say so. Never purge when
      // the bot is still in the guild: it keeps operating on that data.
      const gone = !interaction.client.guilds.cache.has(interaction.guildId!);
      await interaction.followUp({
        content: gone
          ? "I'm already gone from this server."
          : "I couldn't remove myself — kick me manually and I'll still delete every stored row.",
        ephemeral: true,
      }).catch(() => {});
      return false;
    });
    if (left) {
      // Discord normally delivers GuildDelete → handleGuildDelete runs this
      // exact pause+purge — but the event is at-most-once. Running it here
      // too (idempotent) means a dropped gateway event can't leave the
      // card's "every row is deleted" promise unkept.
      pauseGuildClaims(guild.id);
      await store.purgeGuild(guild.id).catch(error => {
        inc("server.decline_purge_error");
        logError("Decline purge failed — GuildDelete or the orphan sweep will retry", error);
      });
    }
    return;
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
            store,
            interaction.guildId,
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
      await sendCompanionSystemMessage(targetGuild, companion, ownerName, "joined", store, targetGuildId);
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

// Comment reports reuse the listing categories minus "stolen persona" —
// a comment can't steal a character; that one's listing-only.
const COMMENT_REPORT_CATEGORIES = REPORT_CATEGORIES.filter(([c]) => c !== "theft");

/** Creator tag select — `market:tagsel:{listingId}`. Re-checks ownership at
 *  submit (picks can arrive long after the ephemeral reply rendered), drops
 *  forged tag ids against the forum's live non-moderated tags, and merges the
 *  moderated curated badges back in so a re-tag can't strip them. */
export async function handleMarketSelect(interaction: StringSelectMenuInteraction, store: MemoryStore) {
  const parts = interaction.customId.split(":");
  if (parts[0] !== "market" || parts[1] !== "tagsel") return;
  const listingId = Number(parts[2]);
  const listing = Number.isFinite(listingId) ? await store.listingById(listingId).catch(() => null) : null;
  if (!listing || listing.creatorUserId !== interaction.user.id) {
    return interaction.update({ content: "That's not your listing to tag.", components: [] });
  }
  const channel = config.marketplaceChannelId
    ? await interaction.client.channels.fetch(config.marketplaceChannelId).catch(() => null)
    : null;
  const thread = channel && channel.type === ChannelType.GuildForum && listing.forumThreadId
    ? await channel.threads.fetch(listing.forumThreadId).catch(() => null)
    : null;
  if (!thread) {
    return interaction.update({ content: "That listing's thread isn't reachable.", components: [] });
  }
  const available = channel && channel.type === ChannelType.GuildForum ? channel.availableTags ?? [] : [];
  const pickable = new Set(available.filter(t => !t.moderated).map(t => t.id));
  const moderated = new Set(available.filter(t => t.moderated).map(t => t.id));
  const picks = interaction.values.filter(v => pickable.has(v)).slice(0, 3);
  // Curated badges are preserved across a re-tag — only the creator's own
  // selections are replaced by `picks`.
  const keep = (thread.appliedTags ?? []).filter(t => moderated.has(t));
  const ok = await thread.setAppliedTags([...keep, ...picks].slice(0, 5))
    .then(() => true).catch(() => false);
  if (!ok) {
    return interaction.update({ content: "I couldn't update the tags — check my permissions on the forum.", components: [] });
  }
  inc("market.tagged");
  return interaction.update({
    content: picks.length
      ? `Tags saved — ${picks.map(id => available.find(t => t.id === id)?.name ?? id).join(", ")} on **${listing.name}**.`
      : `Tags cleared on **${listing.name}**.`,
    components: [],
  });
}
/** "Report message" context-menu entry. Only meaningful on a comment inside
 *  a marketplace listing thread — everywhere else it declines. Shows the
 *  ephemeral category picker; the `market:commentcat` button does the write. */
async function handleReportMessageCommand(interaction: MessageContextMenuCommandInteraction) {
  const target = interaction.targetMessage;
  const channel = target.channel ?? interaction.channel;
  if (!isHouse(interaction.guildId) || !isMarketplaceThread(channel)) {
    return interaction.reply({ content: "This only works on comments inside marketplace listings.", ephemeral: true });
  }
  if (target.author.id === interaction.user.id) {
    return interaction.reply({ content: "You can't report your own comment.", ephemeral: true });
  }
  if (target.author.bot) {
    return interaction.reply({ content: "That's a system message — use **Report** on the listing card for listing issues.", ephemeral: true });
  }
  const catRows = [0, 3].map(offset =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...COMMENT_REPORT_CATEGORIES.slice(offset, offset + 3).map(([cat, label]) =>
        new ButtonBuilder()
          .setCustomId(`market:commentcat:${channel.id}:${target.id}:${cat}`)
          .setLabel(label)
          .setStyle(cat === "minor" ? ButtonStyle.Danger : ButtonStyle.Secondary),
      ),
    ),
  );
  return interaction.reply({
    ephemeral: true,
    content: "What's wrong with this comment? Pick the closest reason:",
    components: catRows,
  });
}

/** "Staff pick" context command — marketplace mods toggle the curated badge
 *  on a listing's thread. The tag is name-matched against the forum's
 *  available tags; it must exist (and should be moderated) in Discord. The
 *  sweep never touches it — this is a manual editorial pick. */
async function handleStaffPickCommand(interaction: MessageContextMenuCommandInteraction, store: MemoryStore) {
  const channel = interaction.targetMessage.channel ?? interaction.channel;
  if (!isHouse(interaction.guildId) || !isMarketplaceThread(channel)) {
    return interaction.reply({ content: "This only works inside marketplace listing threads.", ephemeral: true });
  }
  if (!isMarketplaceMod(interaction)) {
    return interaction.reply({ content: "Moderator role required.", ephemeral: true });
  }
  const forum = await interaction.client.channels.fetch(config.marketplaceChannelId!).catch(() => null);
  const tag = forum && forum.type === ChannelType.GuildForum
    ? forum.availableTags?.find(t => t.name.toLowerCase() === CURATED_TAGS.staffPick.toLowerCase())
    : null;
  if (!tag) {
    return interaction.reply({ content: `There's no "${CURATED_TAGS.staffPick}" tag on the marketplace forum — create it (marked moderated) first.`, ephemeral: true });
  }
  const thread = channel as unknown as { id: string; appliedTags?: string[]; setAppliedTags(t: string[]): Promise<unknown> };
  const applied = thread.appliedTags ?? [];
  const has = applied.includes(tag.id);
  // The badge goes first so it survives the 5-tag cap.
  const next = has ? applied.filter(t => t !== tag.id) : [tag.id, ...applied].slice(0, 5);
  const ok = await thread.setAppliedTags(next).then(() => true).catch(() => false);
  if (!ok) return interaction.reply({ content: "Couldn't update the thread's tags — check my permissions.", ephemeral: true });
  const listing = await store.listingByThreadId(channel.id).catch(() => null);
  inc("market.staffpick");
  return interaction.reply({
    content: has
      ? `Removed **${CURATED_TAGS.staffPick}** from **${listing?.name ?? "this listing"}**.`
      : `**${listing?.name ?? "This listing"}** is now a ⭐ ${CURATED_TAGS.staffPick}!`,
    ephemeral: true,
  });
}

/** Message context-menu dispatcher — "Report message" files a comment
 *  report, "Staff pick" toggles the curated badge. */
export async function handleMarketplaceContext(interaction: MessageContextMenuCommandInteraction, store: MemoryStore) {
  if (interaction.commandName === "Staff pick") return handleStaffPickCommand(interaction, store);
  return handleReportMessageCommand(interaction);
}
