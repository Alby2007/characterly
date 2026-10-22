export type MessageEvent = {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: Date;
  // The message addresses the bot: @-mention, reply-to-bot, or a wake word
  // (a companion name said in text — see detectWakeWord).
  mentionsBot: boolean;
  // Transient: populated live from Discord attachments, consumed in-flight by
  // describeImage — the attachment refs are never persisted, but the resulting
  // description caches on messages.image_context for reuse across passes.
  imageAttachments?: Array<{ url: string; contentType: string; size: number; name?: string }>;
};

export type MemoryCandidate = {
  subjectId: string;
  // The subject's name exactly as written in the message — resolved to a user ID
  // via the alias map when subjectId can't be determined directly.
  subjectName?: string;
  // story_fact = an in-fiction/roleplay beat — stored on companion_id so it
  // only surfaces for the character it was told to, never as a real-world fact.
  kind: "person_fact" | "person_preference" | "server_lore" | "episode" | "story_fact";
  content: string;
  /** Companion this memory is scoped to — set only for story_fact rows. NULL
   *  means a real-world fact shared by all of the subject's companions. */
  companionId?: number | null;
  // Optional: the LLM does not set these; the database calculates them deterministically.
  confidence?: number;
  importance?: number;
  explicitness?: number;
  reason: string;
  evidenceType?: EvidenceType;
  effect?: EvidenceEffect;
};

/**
 * An LLM-asserted interpersonal dynamic between two chatters.
 * subjectName omitted/empty = the assertion is about the message author.
 */
export type RelationshipAssertion = {
  subjectName?: string;
  otherName: string;
  nature: string;
  // Language judgment like evidenceType: -1 hostile … 0 neutral … +1 close.
  valence: number;
  reason?: string;
};

/** What one message's extraction pass produces. */
export type ExtractionResult = {
  memories: MemoryCandidate[];
  relationships: RelationshipAssertion[];
};

export type RelationshipEdge = {
  id: number; guildId: string; subjectId: string; otherId: string;
  summary: string; valence: number | null; observationCount: number;
  lastObservedAt: string | null; updatedAt: string;
  /** 90d mention/name-ref count stamped from the interaction graph —
   *  deterministic contact frequency, not a claim about the dynamic. */
  behavioralCount: number;
  /** Literal observations authored by an edge party — self-report depth.
   *  Zero means every claim about this pair came from a third party. */
  partyCount: number;
  /** 'warming' | 'cooling' | null — recent-5 weighted valence vs all-time,
   *  only set with ≥3 observations. */
  trend: string | null;
  /** Behavior-only edge: frequent interaction, zero literal claims. Renders
   *  as contact frequency, never as a relationship claim. */
  inferred: boolean;
};

export type Member = {
  guildId: string; userId: string; knownNames: string[];
  firstSeenAt: string; lastSeenAt: string; messageCount: number; optedOut: boolean;
  optedIn: boolean;
  /** v57 — opt-in for the server→DM digest to carry this member's facts into
   *  a companion owner's private DM. Default off: only server lore and the
   *  owner's own data cross that boundary without it. */
  shareFactsWithCompanionOwners: boolean;
};

export type Profile = {
  guildId: string; subjectId: string; displayName: string;
  summary: string; facets: ProfileFacets;
  builtAt: string | null; updatedAt: string;
};

export type ProfileFacets = {
  traits?: string[];
  interests?: string[];
  notableRelationships?: string[];
  roleInServer?: string;
  dossier?: Dossier;
};

// ── Dossier (tier-2 profile) ─────────────────────────────────────────────────
// Detailed per-section synthesis stored under facets_json.dossier. Each section
// is rebuilt only when its own input hash changes.

export type DossierSection = "voice" | "life_situation" | "temperament" | "beliefs" | "relationship_map" | "reputation" | "timeline";

export type DossierSectionResult = {
  hash: string;
  builtAt: string;
  // Section-specific payload (prose, items[] with source_ids, entries[] …).
  data: Record<string, unknown>;
};

export type Dossier = {
  sections: Partial<Record<DossierSection, DossierSectionResult>>;
};

/** A dossier item that cites the memories it was synthesized from. */
export type SourcedItem = { text: string; source_ids?: number[]; confirmed?: boolean };

export type VoiceSectionData = {
  prose: string;
  quirks: string[];
  stats: { avgLength: number; capsRatio: number; emojiRatio: number; questionRatio: number; sampleSize: number };
};

export type SourcedListSectionData = { prose?: string; items: SourcedItem[] };

export type RelationshipMapEntry = { name: string; dynamic: string; source_ids?: number[] };
export type RelationshipMapData = { entries: RelationshipMapEntry[] };

export type TimelineEntry = { title: string; date: string; role: string; significance: number };
export type TimelineData = { entries: TimelineEntry[] };

// ── Structured profile attributes ────────────────────────────────────────────
// The source of truth for profile facets: enumerated (field, value) rows with
// memory_ids provenance. profiles.summary/facets_json are renderings of these.
// Status is derived from cited memories except 'superseded', asserted via
// superseded_by — a row can be superseded while its evidence is still live.

export type AttributeStatus = "active" | "contested" | "superseded" | "forgotten";

export type ProfileAttribute = {
  id: number; guildId: string; subjectId: string;
  field: string; value: string; valueNorm: string;
  confidence: number; memoryIds: number[];
  status: AttributeStatus; supersededBy: number | null;
  firstSeenAt: string; lastSeenAt: string;
};

/** A candidate attribute before the upsert-diff decides insert/fold/revive. */
export type AttributeProposal = {
  field: string;
  value: string;
  memoryIds: number[];
  /** value_norm of an existing row this proposal replaces (LLM multi-valued). */
  replaces?: string;
};

/** Deterministic inputs gathered for one subject before profile synthesis. */
export type ProfileSynthesisInput = {
  displayName: string;
  stats: {
    messageCount: number;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    topChannel: string | null;
    activeHours: string;
  };
  /** Confirmed attributes — the structured source the bio renders from. */
  attributes: Array<{ field: string; value: string; confidence: number }>;
  patterns: string[];
  relationships: Array<{ withName: string; summary: string; valence: number | null; observations: number }>;
  events: Array<{ title: string; role: string; significance: number }>;
};

/** LLM output of profile rendering — prose only; facets come from attributes. */
export type ProfileSynthesis = {
  bio: string;
  roleInServer: string;
};

/** Sincerity verdict for a candidate memory, judged against its source message.
 * "misattributed" = the source is quoting/pasting/describing someone other than the poster. */
export type VerificationVerdict = "literal" | "joke" | "unclear" | "misattributed";

export type MemoryStatus = "candidate" | "quarantined" | "active" | "contested" | "superseded" | "forgotten";
export type EvidenceType = "explicit_fact" | "clear_preference" | "direct_observation" | "reported_by_other" | "sarcasm_or_joke" | "uncertain_inference" | "correction" | "in_fiction";
export type EvidenceEffect = "support" | "contradict" | "correct" | "context";

export type Decision = {
  shouldSpeak: boolean;
  score: number;
  reasons: string[];
};

/**
 * The reply contract: the model's text plus its read on whether this human is
 * done. `endConversation` removes the author from the channel's conversation —
 * the model understands "ok cool thanks that's all" better than any regex,
 * while detectDismissal stays the deterministic override for explicit exits.
 */
export type ReplyResult = {
  text: string;
  endConversation: boolean;
};

// ── v0.2 Event types ──────────────────────────────────────────────────────────

export type EventTier = "candidate" | "event";

export type ParticipantRole = "subject" | "antagonist" | "participant" | "observer";

/**
 * What the LLM (or heuristic) decides to do with an incoming message relative
 * to currently open event windows.
 */
export type ContinuityDecision =
  | { action: "attach";    eventId: number }
  | { action: "new" }
  | { action: "reference"; eventId: number }   // message mentions a past event without extending it
  | { action: "bridge";    eventIds: number[] }; // message connects two open events

export type EventParticipant = {
  userId: string;
  userName: string;
  role: ParticipantRole;
};

export type EventCandidate = {
  guildId: string;
  channelId: string;
  title: string;
  summary: string;
  significance: number;
  tier: EventTier;
  occurredAt: Date;
  participants: EventParticipant[];
  messageIds: string[];
  memoryIds: number[];
};

export type StoredEvent = EventCandidate & {
  id: number;
  closedAt: Date | null;
  referenceCount: number;
  /** Re-classification passes spent on this event — capped so a
   * 'discard'-verdict candidate stops paying a full LLM call per reference. */
  classifications: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * Pairwise relationship context for the reply prompt — what two specific
 * people assert about each other, separate from either one's standalone
 * profile. Direction is load-bearing: aToB is what A (subject_id, the
 * asserting side) says about B; bToA is the reverse. Claims are attributed
 * assertions, not facts about the subject.
 */
export type PairContextEdge = {
  summary: string; valence: number | null; observationCount: number;
  partyCount: number; trend: string | null; lastObservedAt: string | null;
  /** Behavior-only edge — render as contact frequency, never a claim. */
  inferred: boolean;
};

export type PairContext = {
  aName: string;
  bName: string;
  aToB?: PairContextEdge;
  bToA?: PairContextEdge;
  /** Interaction-graph count for the pair — behavior signal, not a claim.
   *  Surfaces as "frequent interaction" when no edge exists. */
  behavioralCount: number;
  reasons: Array<{ fromName: string; reason: string; at: string }>;
  claimsAboutA: string[];   // things B asserted about A
  claimsAboutB: string[];   // things A asserted about B
  sharedEvents: string[];   // "Title (Sep 2026)"
};

// ── Personal Companions (v21) ─────────────────────────────────────────────────

export type OnboardingState = "onboarding" | "active";

export type CompanionKind = "awakened" | "adopted";

export type Companion = {
  id: number;
  ownerUserId: string;
  name: string;
  avatarUrl: string | null;
  voicePersona: string;
  coreTraits: string[];
  ownerDynamic: string;
  backstory: string;
  onboardingState: OnboardingState;
  onboardingTurns: number;
  /** 'awakened' = the one permanent companion per account (uniqueness enforced
   *  by a partial index); 'adopted' = a marketplace clone owned by the adopter
   *  and synced from its listing. */
  kind: CompanionKind;
  /** For adopted companions: the marketplace listing they were cloned from. */
  adoptedFromListingId: number | null;
  /** Persona version the adopted clone was last synced to. */
  listingVersion: number;
  /** 'authored' = written here; 'card_import' = parsed from an uploaded
   *  character card. Carried onto marketplace listings on publish so the
   *  provenance survives into moderation. */
  personaSource: string;
  /** Provenance snapshot for imports — claimed creator, spec, filename,
   *  sha256 of the source file. Not shown as authoritative authorship. */
  importMeta: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

/** A marketplace listing — a publishable persona projected from a creator's
 * awakened companion. Editable + versioned; adopters clone it into their own
 * companions row, so creator edits propagate without ever mutating the
 * creator's (permanently locked) awakened bond. */
/** One alternate opening a listing can greet with. v1 fills `text` only —
 *  `label` (picker title) and `premise` (per-scene prompt overlay) are
 *  reserved so a scenes v2 lands without a column reshape. The primary
 *  `greeting` stays the canonical first opening; these are the alternates. */
export type SceneOpening = { text: string; label?: string; premise?: string };

/** Alternate-opening bounds. 4 alternates + the primary greeting = 5 ways to
 *  meet; the per-opening cap matches the authored greeting modal (1000) and
 *  keeps the scenes editor's serialized field inside Discord's 4000 limit. */
export const LISTING_MAX_OPENINGS = 4;
export const LISTING_OPENING_MAX_CHARS = 1000;

/** One authored lore entry — the listing's world canon, surfaced into a
 *  reply when a trigger key appears in recent conversation. `constant` fires
 *  every turn; `selective` additionally requires a secondaryKeys hit.
 *  `caseSensitive`/`wholeWords` refine key matching; `order` sorts injected
 *  entries; `enabled:false` keeps an authored entry off the air without
 *  deleting it. Imported cards' `character_book` lands here (v69). */
export type LoreEntry = {
  keys: string[];
  content: string;
  /** Creator-facing label for the entry — never injected. */
  comment?: string;
  constant?: boolean;
  selective?: boolean;
  secondaryKeys?: string[];
  caseSensitive?: boolean;
  wholeWords?: boolean;
  enabled?: boolean;
  order?: number;
};

/** Lorebook bounds. 25 authored entries is a generous canon for one listing;
 *  the per-entry cap keeps a single injected block readable, and the match-
 *  side caps (in lorebook.ts) bound prompt spend per turn. */
export const LISTING_MAX_LORE_ENTRIES = 25;
export const LISTING_LORE_ENTRY_MAX_CHARS = 1200;
export const LISTING_LORE_MAX_KEYS = 8;
export const LISTING_LORE_KEY_MAX_CHARS = 64;

export type CompanionListing = {
  id: number;
  creatorUserId: string;
  /** The awakened companion this listing projects — null for freehand
   *  creator-authored characters (v35). */
  sourceCompanionId: number | null;
  name: string;
  tagline: string;
  voicePersona: string;
  coreTraits: string[];
  ownerDynamic: string;
  backstory: string;
  greeting: string;
  /** Alternate openings picked at Meet time (v68) — card `alternate_greetings`
   *  or creator-authored. Empty = the greeting is the only way in. */
  openings: SceneOpening[];
  /** Authored world lore (v69) — card `character_book` entries or creator-
   *  authored. Resolved per turn via adopted_from_listing_id; listing edits
   *  are live for every adopter instantly. Empty = no canon block. */
  lorebook: LoreEntry[];
  avatarUrl: string | null;
  /** House forum thread id — the canonical post. Mirrors in partner servers
   *  live in listing_posts (v59); this column stays the house pointer. */
  forumThreadId: string | null;
  /** Creator-picked forum tag NAMES (not ids — ids differ per deployed
   *  forum; names are the sync currency across mirrors). */
  creatorTags: string[];
  version: number;
  /** 'unlisted' = private import — browsable nowhere, adoptable only by its
   *  creator, free of the live-listing cap until published. */
  status: "active" | "flagged" | "delisted" | "banned" | "unlisted";
  personaSource: string;
  importMeta: Record<string, unknown> | null;
  reportCount: number;
  addCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CompanionAdoption = {
  id: number;
  userId: string;
  listingId: number;
  companionId: number;
  adoptedAt: string;
  droppedAt: string | null;
  cooldownUntil: string | null;
  dmIntroducedAt: string | null;
  /** Private thread under #adoptees where this companion chats (v54). With
   *  v59 it can live in any deployed server — see chatGuildId. */
  chatThreadId: string | null;
  /** Guild hosting chatThreadId — NULL means the house server. */
  chatGuildId: string | null;
  /** The adoptees channel the thread sits under (rebuilds target it). */
  chatChannelId: string | null;
};

/** One server's Characterly deployment (v59): the marketplace forum +
 *  adoptees surface a partner guild self-provisions via /marketplace deploy.
 *  status: granted (ops allowed it, not yet deployed) | active | disabled. */
export type GuildDeployment = {
  guildId: string;
  status: "granted" | "active" | "disabled";
  marketplaceChannelId: string | null;
  adopteesChannelId: string | null;
  categoryId: string | null;
  /** v63 — the deployed #log-in link surface (NULL on pre-v63 deploys). */
  loginChannelId: string | null;
  /** v63 — 'ops' = granted by an operator; 'self' = auto-granted to a
   *  linked-account deployer under self-serve. */
  grantKind: "ops" | "self";
  deployedBy: string | null;
  deployedAt: string | null;
  lastError: string | null;
};

/** A listing's forum thread in one server — the mirror map (v59). The house
 *  post also keeps companion_listings.forum_thread_id in sync. */
export type ListingPost = {
  listingId: number;
  guildId: string;
  /** NULL on failed/pending rows — no thread was ever created. */
  threadId: string | null;
  status: "live" | "archived" | "failed" | "pending";
  lastError: string | null;
};

export type CompanionSpec = {
  name: string;
  voicePersona: string;
  coreTraits: string[];
  ownerDynamic: string;
  backstory: string;
  avatarUrl?: string | null;
};

export type OnboardingTurnResult = {
  replyText: string;
  complete: boolean;
  isReady?: boolean;
  spec: CompanionSpec;
};

/** A first-person journal entry — what the companion itself experienced.
 * originScope tags where it formed; recall is origin-scoped. */
export type JournalEntry = {
  id: number;
  companionId: number;
  originScope: string;
  kind: "moment" | "opinion" | "inside_joke" | "promise" | "bond";
  content: string;
  aboutSubjectIds: string[];
  importance: number;
  status: "active" | "forgotten";
  sourceMessageId?: string | null;
  /** 'live' = written after a real reply; 'import' = distilled from an
   *  uploaded chat history (import_id traces it back). */
  source?: "live" | "import";
  importId?: number | null;
  /** v57 — owner-pinned entries always ride recall and never get pruned. */
  pinned?: boolean;
  createdAt: string;
};

export type JournalCandidate = {
  kind: JournalEntry["kind"];
  content: string;
  importance?: number;
  aboutSubjects?: string[];
};

/** Rolling "story so far" recap for one (companion, scope, channel) — the
 *  always-on continuity layer that outlives the 25-message transcript window.
 *  coveredUntil is the watermark; msgs_since counts replies waiting to fold in. */
export type ConversationSummary = {
  id: number;
  companionId: number;
  originScope: string;
  channelId: string;
  summary: string;
  /** True once the owner rewrote the summary — the summarizer treats it as
   *  authoritative prior state instead of proposing freely. */
  userEdited: boolean;
  coveredUntil: string | null;
  msgsSince: number;
  createdAt: string;
  updatedAt: string;
};

/** A queued/running/finished chat-history import (v44). The transcript lives
 *  in `turns` only until status='done' — distill-and-discard. */
export type ChatImport = {
  id: number;
  ownerUserId: string;
  companionId: number;
  filename: string;
  sha256: string;
  format: string;
  status: "queued" | "distilling" | "done" | "failed";
  turns: Array<{ speaker: "user" | "char"; text: string; ts: string | null }>;
  speakers: { user?: string; char?: string; dropped?: number };
  messageCount: number;
  keptCount: number;
  processedTurns: number;
  error: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

/** A Discord app-install webhook event (v47) — the install-greeting ledger.
 *  `greetedAt` stays NULL until the bot's install-greet sweep sends the
 *  welcome DM; `deauthorizedAt` marks revoked installs. */
export type AppInstall = {
  discordUserId: string;
  event: "authorized" | "deauthorized" | string;
  meta: Record<string, unknown> | null;
  greetedAt: string | null;
  deauthorizedAt: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A house support ticket (v48) — one private thread per ticket under
 *  #support-ticket. `status` is 'open' | 'closed'; the partial unique index
 *  enforces one open ticket per opener. `category` (v66) comes from the
 *  open-time picker; `lastStaffReplyAt`/`staleNotifiedAt` feed the reaper's
 *  unanswered-ticket nudge. */
export type SupportTicket = {
  threadId: string;
  guildId: string;
  openerId: string;
  subject: string;
  details: string;
  status: "open" | "closed" | string;
  openedAt: string;
  closedAt: string | null;
  closerId: string | null;
  category: string;
  lastStaffReplyAt: string | null;
  staleNotifiedAt: string | null;
};

/** One row of the moderation audit ledger (v66) — automod actions, report
 *  resolutions, and staff actions on house members. `actor` is "automod"
 *  for rule-driven actions, the mod's user id otherwise. `action` is the
 *  verb ('delete' | 'timeout' | 'kick' | 'warn' | 'report_keep' |
 *  'report_del' | 'report_timeout'); `rule` names the automod rule or the
 *  report category that motivated it. */
export type ModAction = {
  id: number;
  guildId: string;
  targetId: string;
  actor: string;
  action: string;
  rule: string | null;
  detail: string;
  messageId: string | null;
  channelId: string | null;
  createdAt: string;
};

export type CompanionPersona = {
  companionId: number;
  name: string;
  ownerUserId: string;
  ownerName?: string;
  voicePersona: string;
  coreTraits: string[];
  ownerDynamic: string;
  backstory: string;
  /** Private DM bond context injected only as subtext when speaking in a server. */
  ownerSubtext?: string;
  /** Recent server activity digest injected when speaking in 1:1 DMs with the owner. */
  serverDigest?: string;
  /** The companion's own first-person journal entries, origin-scoped to where it's speaking. */
  journal?: JournalEntry[];
  /** Rolling recap of this conversation older than the live transcript window. */
  storySummary?: string;
  /** Matched lorebook entry contents for this turn (v69) — canon that the
   *  conversation just touched. Populated by lorebook.ts matchLore. */
  lore?: string[];
};

export type GuildCompanion = Companion & {
  guildId: string;
  summonedBy: string;
  active: boolean;
  summonedAt: string;
};

export type WebhookMessageRecord = {
  messageId: string;
  guildId: string;
  channelId: string;
  companionId: number;
  chainDepth: number;
  createdAt: string;
};
