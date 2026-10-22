import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { ComponentType, MessageFlags, type ChatInputCommandInteraction, type StringSelectMenuInteraction } from "discord.js";
import { Brain, type LlmClient } from "./brain.js";
import { createBrainResolver } from "./brains.js";
import { ConversationTracker } from "./conversation.js";
import { sendAsCompanion } from "./webhooks.js";
import { selectCompanionForTurn } from "./scene-router.js";
import { gatherOwnerSubtextForServer, gatherServerDigestForDm } from "./cross-context.js";
import {
  buildApiKeyOnboardingPayload,
  buildAwakenedCompanionPayload,
  buildCompanionEditModal,
  buildOnboardingDraftComponents,
  buildOnboardingDraftEmbed,
  buildCompanionDmPayload,
  buildOnboardingWelcomePayload,
  buildUserApiKeyModal,
  handleCompanionModal,
  handleMarketSelect,
  handleMemoryButton,
  handleMemoryCommand,
  handleSetupModal,
  isAwakenedCompanionActive,
} from "./commands.js";
import { MemoryStore } from "./database.js";
import { makeStore, makeTestSql } from "./test-helpers.js";
import { config } from "./config.js";
import { initOps, resetOpsState, type OpsDeps } from "./ops.js";
import type { GuildCompanion, MessageEvent } from "./types.js";

function msg(content: string, overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    guildId: "g1",
    channelId: "c1",
    messageId: "m1",
    authorId: "u-alice",
    authorName: "Alice",
    content,
    createdAt: new Date(),
    mentionsBot: false,
    ...overrides,
  };
}

function makeCompanion(id: number, ownerUserId: string, name: string): GuildCompanion {
  return {
    id,
    ownerUserId,
    name,
    avatarUrl: null,
    voicePersona: "Dry, witty, observant",
    coreTraits: ["witty", "loyal"],
    ownerDynamic: "Ride-or-die best friend",
    backstory: "Met in a late-night chat",
    onboardingState: "active",
    onboardingTurns: 3,
    kind: "awakened",
    adoptedFromListingId: null,
    listingVersion: 0,
    personaSource: "authored",
    importMeta: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    guildId: "g1",
    summonedBy: ownerUserId,
    active: true,
    summonedAt: new Date().toISOString(),
  };
}

// ── Unit tests (no DB required) ───────────────────────────────────────────────

test("Brain.runOnboardingTurn merges draft state and graduates when complete=true", async () => {
  let capturedPrompt = "";
  const fakeClient: LlmClient = {
    responses: { create: async () => ({ output_text: "{}" }) },
    chat: {
      completions: {
        create: async (params: any) => {
          capturedPrompt = params.messages[0].content;
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    reply_text: "I'm Nyx. Ready when you are.",
                    complete: true,
                    name: "Nyx",
                    voice_persona: "Deadpan and sharp",
                    core_traits: ["deadpan", "protective"],
                    owner_dynamic: "Chaotic co-conspirator",
                    backstory: "Always online",
                  }),
                },
              },
            ],
          };
        },
      },
    },
  };
  const brain = new Brain("test-key", "test-model", undefined, fakeClient);
  const res = await brain.runOnboardingTurn({
    ownerName: "Alice",
    userMessage: "Let's call you Nyx, be deadpan and my chaotic co-conspirator",
    transcript: [],
    currentDraft: { avatarUrl: "https://example.com/nyx.png" },
    turnCount: 2,
  });
  assert.equal(res.complete, true);
  assert.equal(res.spec.name, "Nyx");
  assert.equal(res.spec.voicePersona, "Deadpan and sharp");
  assert.deepEqual(res.spec.coreTraits, ["deadpan", "protective"]);
  assert.equal(res.spec.ownerDynamic, "Chaotic co-conspirator");
  assert.equal(res.spec.avatarUrl, "https://example.com/nyx.png");
  assert.match(capturedPrompt, /Alice/);
});

test("Brain.reply injects CompanionPersona, Vault Rule for ownerSubtext in servers, and serverDigest in DMs", async () => {
  let lastInput = "";
  const fakeClient: LlmClient = {
    responses: { create: async () => ({ output_text: "{}" }) },
    chat: {
      completions: {
        create: async (params: any) => {
          lastInput = params.messages[0].content;
          return { choices: [{ message: { content: JSON.stringify({ text: "Got your back.", end_conversation: false }) } }] };
        },
      },
    },
  };
  const brain = new Brain("test-key", "test-model", undefined, fakeClient);

  // Server reply with private owner subtext
  const serverReply = await brain.reply(
    msg("what do you think Nyx?", { authorId: "u-bob", authorName: "Bob" }),
    [{ authorName: "Nyx", authorId: "companion:1", content: "earlier line" }],
    [],
    [],
    [],
    undefined,
    false,
    "companion:1",
    {
      guildName: "Friend Hangout",
      ownerName: "Alice",
      botName: "Nyx",
      isDm: false,
      companion: {
        companionId: 1,
        name: "Nyx",
        ownerUserId: "u-alice",
        ownerName: "Alice",
        voicePersona: "Dry and sarcastic",
        coreTraits: ["sarcastic", "loyal"],
        ownerDynamic: "Best friend",
        backstory: "Loves late-night gaming",
        ownerSubtext: "- [Private DM memory] Alice is secretly interviewing at Acme Corp",
      },
    },
  );
  assert.equal(serverReply.text, "Got your back.");
  assert.match(lastInput, /VAULT RULE/);
  assert.match(lastInput, /CONFIDENTIAL SUBTEXT/);
  assert.match(lastInput, /you: earlier line/);

  // DM reply with serverDigest
  await brain.reply(
    msg("what happened in the server earlier?", { guildId: "dm:u-alice", authorId: "u-alice", authorName: "Alice" }),
    [],
    [],
    [],
    [],
    undefined,
    false,
    "companion:1",
    {
      guildName: "Direct Message",
      ownerName: "Alice",
      botName: "Nyx",
      isDm: true,
      companion: {
        companionId: 1,
        name: "Nyx",
        ownerUserId: "u-alice",
        ownerName: "Alice",
        voicePersona: "Dry and sarcastic",
        coreTraits: ["sarcastic", "loyal"],
        ownerDynamic: "Best friend",
        backstory: "",
        serverDigest: "[Friend Hangout]\n  • Event: \"The Pizza Debate\"",
      },
    },
  );
  assert.match(lastInput, /Recent activity from shared friend servers/);
  assert.match(lastInput, /The Pizza Debate/);
});

test("createBrainResolver resolves dm:<userId> scopes using operator envKey even when requireGuildKeys=true", async () => {
  const meteredScopes: string[] = [];
  const resolver = createBrainResolver({
    getKey: async () => null,
    envKey: "gsk_operator_env_key",
    envModel: "test-model",
    envBaseUrl: "https://api.groq.com/openai/v1",
    requireGuildKeys: true,
    meter: (scopeId, client) => {
      meteredScopes.push(scopeId);
      return client;
    },
  });

  // Guild without BYOK key stays dormant when requireGuildKeys=true
  assert.equal(await resolver.brainFor("g-no-key"), null);
  // DM scope always resolves via operator envKey and meters against dm:<userId>
  const dmBrain = await resolver.brainFor("dm:u-alice");
  assert.ok(dmBrain, "DM scope should resolve a Brain");
  assert.deepEqual(meteredScopes, ["dm:u-alice"]);
});

test("selectCompanionForTurn routes by wake-word name, webhook reply, owner affinity, and caps companion-to-companion chain depth", () => {
  const convo = new ConversationTracker(120_000);
  const nyx = makeCompanion(1, "u-alice", "Nyx");
  const kael = makeCompanion(2, "u-bob", "Kael");
  const companions = [nyx, kael];
  const baseOpts = { speakThreshold: 0.7, maxChainDepth: 2, engagement: true, wakeWord: true };

  // 0 companions → pure companion mode stays silent
  assert.equal(
    selectCompanionForTurn({ event: msg("hello?"), companions: [] }, convo, baseOpts),
    null,
  );

  // @-mentioning the Characterly system bot (mentionsBot: true) NEVER triggers a companion,
  // even when only 1 companion is summoned in the guild.
  assert.equal(
    selectCompanionForTurn(
      { event: msg("hey @Characterly", { mentionsBot: true }), companions: [nyx] },
      convo,
      baseOpts,
    ),
    null,
  );

  // Naming Kael directly selects Kael and suppresses Nyx
  const pickKael = selectCompanionForTurn(
    { event: msg("hey Kael what do you think?"), companions },
    convo,
    baseOpts,
  );
  assert.equal(pickKael?.companion.id, 2);
  assert.equal(pickKael?.isAddressed, true);

  // Replying to Nyx's webhook message selects Nyx even without saying her name
  const pickNyxByReply = selectCompanionForTurn(
    { event: msg("totally disagree with that"), companions, repliedToCompanionId: 1 },
    convo,
    baseOpts,
  );
  assert.equal(pickNyxByReply?.companion.id, 1);
  assert.equal(pickNyxByReply?.isAddressed, true);

  // Companion-to-companion banter: Nyx addresses Kael at chainDepth=0 → Kael replies with nextChainDepth=1
  const c2cHop1 = selectCompanionForTurn(
    {
      event: msg("Kael you know that's nonsense", { authorId: "companion:1", authorName: "Nyx" }),
      companions,
      senderCompanionId: 1,
      chainDepth: 0,
    },
    convo,
    baseOpts,
  );
  assert.equal(c2cHop1?.companion.id, 2);
  assert.equal(c2cHop1?.nextChainDepth, 1);

  // At chainDepth >= maxChainDepth (2), companion-to-companion loop is hard-stopped
  const c2cCapped = selectCompanionForTurn(
    {
      event: msg("Nyx please", { authorId: "companion:2", authorName: "Kael" }),
      companions,
      senderCompanionId: 2,
      chainDepth: 2,
    },
    convo,
    baseOpts,
  );
  assert.equal(c2cCapped, null);
});

test("/companion commands and cross-context bridges enforce privacy boundaries and DM compatibility", async () => {
  const activeComp = makeCompanion(1, "u-alice", "Nyx");
  const summonedGuilds = new Set<string>(["g1"]);

  const fakeStore = {
    getCompanionByOwner: async (uid: string) => (uid === "u-alice" ? activeComp : null),
    listCompanionsForUser: async (uid: string) => (uid === "u-alice" ? [activeComp] : []),
    resolveDmCompanion: async (uid: string) => (uid === "u-alice" ? activeComp : null),
    adoptionForCompanion: async () => null,
    listingForCompanion: async () => null,
    listingById: async () => null,
    setActiveDmCompanion: async () => {},
    dropAdoption: async () => null,
    creditsSupported: false,
    accountForDiscordUser: async () => null,
    summonCompanion: async (gId: string) => { summonedGuilds.add(gId); },
    dismissCompanion: async (gId: string) => summonedGuilds.delete(gId),
    listGuildCompanions: async (gId: string) => (summonedGuilds.has(gId) ? [activeComp] : []),
    getGuildKey: async (scope: string) => (scope === "dm:u-alice" ? { keyHint: "…9876", validatedAt: "2026-10-01T00:00:00Z" } : null),
    usageToday: async () => 12,
    relationshipsFor: async (scope: string, subj: string) =>
      scope === "g1" && subj === "companion:1"
        ? [{ id: 1, guildId: "g1", subjectId: "companion:1", otherId: "u-bob", summary: "playful rivals", valence: 0.4, observationCount: 3, lastObservedAt: null, updatedAt: "", behavioralCount: 8, partyCount: 2, trend: "warming", inferred: false }]
        : [],
    displayNameFor: async (_scope: string, uid: string) => (uid === "u-bob" ? "Bob" : "Alice"),
    // Digest edge consent: u-bob opted into share-facts so the companion's
    // edge with him may be relayed into the owner's DM.
    getMember: async (_scope: string, uid: string) =>
      uid === "u-bob" ? { shareFactsWithCompanionOwners: true } : undefined,
    relevantMemories: async (scope: string, subj: string) =>
      scope === "dm:u-alice" && subj === "u-alice"
        ? [{ id: 10, guildId: "dm:u-alice", subjectId: "u-alice", status: "active", content: "Alice is planning a surprise trip", confidence: 0.92 }]
        : [],
    attributesFor: async (scope: string) =>
      scope === "dm:u-alice"
        ? [{ id: 1, guildId: "dm:u-alice", subjectId: "u-alice", field: "occupation", value: "Designer", valueNorm: "designer", confidence: 0.9, memoryIds: [10], status: "active", supersededBy: null, firstSeenAt: "", lastSeenAt: "" }]
        : [],
    journalFor: async () => [],
    listCompanionGuilds: async () => [...summonedGuilds],
    recentMemories: async () => [
      { id: 20, status: "active", subjectId: "u-bob", subjectLabel: "Bob", content: "Bob burned his toast" },
      // Unresolved-name claims are inert until claimed — even an 'active' one
      // must never cross into the owner's DM digest.
      { id: 21, status: "active", subjectId: "unknown", subjectLabel: "Pete", content: "Pete cheats at cards" },
    ],
  } as unknown as MemoryStore;

  const fakeEventStore = {
    listEvents: async () => ({
      events: [{ title: "Midnight Game Night", summary: "Everyone played until 3am" }],
      total: 1,
      page: 1,
    }),
  } as any;

  // Cross-context: DM → Server subtext
  const subtext = await gatherOwnerSubtextForServer(fakeStore, "u-alice", 1);
  assert.ok(subtext?.includes("Designer"));
  assert.ok(subtext?.includes("Alice is planning a surprise trip"));

  // Cross-context: Server → DM digest
  const digest = await gatherServerDigestForDm(fakeStore, fakeEventStore, "u-alice", activeComp, () => "The Crew");
  assert.ok(digest?.includes("[The Crew]"));
  assert.ok(digest?.includes("Midnight Game Night"));
  assert.ok(digest?.includes("playful rivals"));
  assert.ok(digest?.includes("Bob burned his toast"));
  assert.ok(!digest?.includes("Pete cheats"), "unknown-subject claims must not reach the digest");

  // /companion action:card in DM (guildId = null)
  const replies: any[] = [];
  const cardIx = {
    guildId: null,
    channelId: "dm-ch",
    id: "ix-card",
    commandName: "companion",
    user: { id: "u-alice", username: "Alice" },
    memberPermissions: null,
    options: {
      getString: (n: string) => (n === "action" ? "card" : null),
      getUser: () => null,
    },
    reply: async (r: any) => { replies.push(r); return r; },
  } as unknown as ChatInputCommandInteraction;
  await handleMemoryCommand(cardIx, fakeStore, async () => ({}) as Brain, fakeEventStore);
  assert.equal(replies.length, 1);
  assert.ok(replies[0].embeds?.length === 1);

  // Server-only command invoked in DM is cleanly refused
  const adminDmReplies: any[] = [];
  const pauseIx = {
    ...cardIx,
    commandName: "memory-pause",
    reply: async (r: any) => { adminDmReplies.push(r); return r; },
  } as unknown as ChatInputCommandInteraction;
  await handleMemoryCommand(pauseIx, fakeStore, async () => ({}) as Brain, fakeEventStore);
  assert.match(adminDmReplies[0]?.content ?? "", /only be used inside a Discord server/i);

  // Summoning and dismissing a companion delivers public System embeds to the channel,
  // and sendAsCompanion never roleplays as a companion if webhooks are unavailable.
  const channelSystemMessages: any[] = [];
  const summonIx = {
    ...cardIx,
    guildId: "g1",
    channel: { send: async (p: any) => { channelSystemMessages.push(p); } },
    options: {
      getString: (n: string) => (n === "action" ? "summon" : null),
      getUser: () => null,
    },
    reply: async (r: any) => r,
  } as unknown as ChatInputCommandInteraction;
  await handleMemoryCommand(summonIx, fakeStore, async () => ({}) as Brain, fakeEventStore);
  assert.equal(channelSystemMessages.length, 1);
  assert.match(channelSystemMessages[0].embeds?.[0]?.data?.title ?? "", /System · Nyx joined the chat/);

  const dismissIx = {
    ...summonIx,
    options: {
      getString: (n: string) => (n === "action" ? "dismiss" : null),
      getUser: () => null,
    },
  } as unknown as ChatInputCommandInteraction;
  await handleMemoryCommand(dismissIx, fakeStore, async () => ({}) as Brain, fakeEventStore);
  assert.equal(channelSystemMessages.length, 2);
  assert.match(channelSystemMessages[1].embeds?.[0]?.data?.title ?? "", /System · Nyx left the chat/);

  // Webhook unavailability posts a one-time system notice and returns null (never roleplays)
  const webhookNotices: any[] = [];
  const whResult = await sendAsCompanion(
    {
      channelId: "ch-no-webhook",
      channel: { type: 99 },
      reply: async (r: any) => { webhookNotices.push(r); return r; },
    } as any,
    activeComp,
    "in-character line that must not be spoken by the system bot",
    "bot-1",
  );
  assert.equal(whResult, null);
  assert.equal(webhookNotices.length, 1);
  assert.match(webhookNotices[0].content, /System: Characterly needs the \*\*Manage Webhooks\*\* permission/);
  assert.doesNotMatch(webhookNotices[0].content, /in-character line/);

  // /companion action:list shows active summoned companions in the server
  await handleMemoryCommand(summonIx, fakeStore, async () => ({}) as Brain, fakeEventStore);
  const listReplies: any[] = [];
  const listIx = {
    ...summonIx,
    options: {
      getString: (n: string) => (n === "action" ? "list" : null),
      getUser: () => null,
    },
    reply: async (r: any) => { listReplies.push(r); return r; },
  } as unknown as ChatInputCommandInteraction;
  await handleMemoryCommand(listIx, fakeStore, async () => ({}) as Brain, fakeEventStore);
  assert.equal(listReplies.length, 1);
  assert.match(listReplies[0].embeds?.[0]?.data?.title ?? "", /Active Companions \(1\)/);
  assert.match(listReplies[0].embeds?.[0]?.data?.description ?? "", /Nyx/);

  // /companion action:status shows personal key, active servers, and DM usage
  const statusReplies: any[] = [];
  const statusIx = {
    ...cardIx,
    options: {
      getString: (n: string) => (n === "action" ? "status" : null),
      getUser: () => null,
    },
    reply: async (r: any) => { statusReplies.push(r); return r; },
  } as unknown as ChatInputCommandInteraction;
  await handleMemoryCommand(statusIx, fakeStore, async () => ({}) as Brain, fakeEventStore);
  assert.equal(statusReplies.length, 1);
  const statusJson = JSON.stringify(statusReplies[0].embeds);
  assert.match(statusJson, /…9876/);
  assert.match(statusJson, /12 \/ 250/);

  // /companion action:kick refuses non-admins and allows ManageGuild admins to remove a companion
  const kickDeniedReplies: any[] = [];
  await handleMemoryCommand(
    {
      ...summonIx,
      user: { id: "u-bob", username: "Bob" },
      memberPermissions: { has: () => false },
      options: {
        getString: (n: string) => (n === "action" ? "kick" : null),
        getUser: () => ({ id: "u-alice", username: "Alice" }),
      },
      reply: async (r: any) => { kickDeniedReplies.push(r); return r; },
    } as unknown as ChatInputCommandInteraction,
    fakeStore,
    async () => ({}) as Brain,
    fakeEventStore,
  );
  assert.match(kickDeniedReplies[0]?.content ?? "", /Only server administrators/i);

  const kickAllowedReplies: any[] = [];
  await handleMemoryCommand(
    {
      ...summonIx,
      user: { id: "u-admin", username: "Admin" },
      memberPermissions: { has: () => true },
      options: {
        getString: (n: string) => (n === "action" ? "kick" : null),
        getUser: () => ({ id: "u-alice", username: "Alice" }),
      },
      reply: async (r: any) => { kickAllowedReplies.push(r); return r; },
    } as unknown as ChatInputCommandInteraction,
    fakeStore,
    async () => ({}) as Brain,
    fakeEventStore,
  );
  assert.match(kickAllowedReplies[0]?.content ?? "", /Removed \*\*Nyx\*\*/);
});

test("onboarding UX: bare greeting guard, welcome/draft/awakened cards, proactive DM bridge, and permanent 1-companion-per-account lock", async () => {
  const fakeClient: LlmClient = {
    responses: { create: async () => ({ output_text: "{}" }) },
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  reply_text: "Hey! How about we call me Vex?",
                  complete: true,
                  name: "Vex",
                  voice_persona: "Sharp and mischievous",
                  core_traits: ["sharp", "mischievous"],
                  owner_dynamic: "Chaotic co-conspirator",
                  backstory: "Late-night schemer",
                }),
              },
            },
          ],
        }),
      },
    },
  };
  const brain = new Brain("test-key", "test-model", undefined, fakeClient);

  // 1. Bare opening greeting ("hi" at turnCount=0) never prematurely completes,
  //    giving the user a chance to see and confirm the draft card.
  const greetingTurn = await brain.runOnboardingTurn({
    ownerName: "Alice",
    userMessage: "hi",
    transcript: [],
    turnCount: 0,
  });
  assert.equal(greetingTurn.complete, false);
  assert.equal(greetingTurn.isReady, true);
  assert.equal(greetingTurn.spec.name, "Vex");

  // 2. UI builders clearly communicate the permanent 1-companion-per-account rule
  //    and omit post-awakening edit buttons.
  const welcome = buildOnboardingWelcomePayload("u-bob");
  assert.equal(welcome.embeds.length, 1);
  assert.match(welcome.embeds[0].data.description ?? "", /permanently locked/i);
  assert.equal(welcome.components[0].components.length, 5);

  const draftEmbed = buildOnboardingDraftEmbed(greetingTurn.spec, 1);
  assert.match(draftEmbed.data.title ?? "", /Vex/);
  assert.match(draftEmbed.data.description ?? "", /one permanent companion/i);
  const draftRow = buildOnboardingDraftComponents("u-bob", greetingTurn.spec);
  assert.equal(draftRow.components.length, 3, "ready draft includes Awaken & Lock In + Edit Draft + Surprise Draft buttons");

  const awakenedPayload = buildAwakenedCompanionPayload(
    makeCompanion(7, "u-bob", "Vex"),
    "Bob",
    [{ id: "g1", name: "The Hangout" }],
  );
  assert.equal(awakenedPayload.embeds.length, 1);
  assert.match(awakenedPayload.embeds[0].data.title ?? "", /Locked In/i);
  assert.equal(awakenedPayload.components[0].components.length, 1, "only Summon to server button (no Edit button once locked)");

  // No mutual guilds → the awakened card becomes the server funnel: join
  // button + house copy instead of a summon hint that leads nowhere.
  const noGuildPayload = buildAwakenedCompanionPayload(
    makeCompanion(7, "u-bob", "Vex"), "Bob", [], "https://discord.gg/test",
  );
  assert.match(noGuildPayload.embeds[0].data.description ?? "", /Characterly server/);
  const funnelBtn = noGuildPayload.components[0].components[0] as { data: { url?: string; label?: string } };
  assert.equal(funnelBtn.data.url, "https://discord.gg/test");
  assert.match(funnelBtn.data.label ?? "", /Join the Characterly server/);

  // 3. Un-onboarded user running /companion action:summon in a server proactively receives a DM
  //    welcome card + ephemeral reply with inline action buttons.
  const dmsSent: any[] = [];
  const summonReplies: any[] = [];
  let stateComp: any = null;
  const summonedInGuilds: string[] = [];
  const onboardingStore = {
    getCompanionByOwner: async () => stateComp,
    upsertCompanionOnboarding: async (_uid: string, spec: any) => {
      if (stateComp?.onboardingState === "active") return stateComp;
      stateComp = {
        ...makeCompanion(9, "u-bob", spec.name || ""),
        voicePersona: spec.voicePersona || "",
        coreTraits: spec.coreTraits || [],
        ownerDynamic: spec.ownerDynamic || "",
        onboardingState: "onboarding",
        onboardingTurns: 1,
      };
      return stateComp;
    },
    activateCompanion: async (_uid: string, _name: string, spec: any) => {
      if (stateComp?.onboardingState === "active") return stateComp;
      stateComp = {
        ...makeCompanion(9, "u-bob", spec.name || "Vex"),
        voicePersona: spec.voicePersona,
        coreTraits: spec.coreTraits,
        ownerDynamic: spec.ownerDynamic,
        backstory: spec.backstory,
        onboardingState: "active",
      };
      return stateComp;
    },
    listCompanionGuilds: async () => summonedInGuilds,
    summonCompanion: async (gId: string) => { summonedInGuilds.push(gId); },
    listCompanionsForUser: async () => (stateComp ? [stateComp] : []),
    resolveDmCompanion: async () => stateComp,
    adoptionForCompanion: async () => null,
  } as unknown as MemoryStore;

  const unawakenedSummonIx = {
    guildId: "g1",
    channelId: "c1",
    id: "ix-unawakened",
    commandName: "companion",
    user: {
      id: "u-bob",
      username: "Bob",
      send: async (p: any) => { dmsSent.push(p); return { channelId: "dm-bob" }; },
    },
    memberPermissions: { has: () => false },
    options: {
      getString: (n: string) => (n === "action" ? "summon" : null),
      getUser: () => null,
    },
    reply: async (r: any) => { summonReplies.push(r); return r; },
  } as unknown as ChatInputCommandInteraction;

  await handleMemoryCommand(unawakenedSummonIx, onboardingStore, async () => brain);
  assert.equal(dmsSent.length, 1, "proactively sent welcome DM to un-onboarded user");
  assert.equal(summonReplies.length, 1);
  assert.match(summonReplies[0].content, /dm-bob/);
  assert.match(summonReplies[0].content, /one permanent companion/i);
  assert.ok(summonReplies[0].components?.length === 1);

  // 4. Clicking onboard:preset:co_conspirator updates draft (stays in 'onboarding' for review).
  const presetUpdates: any[] = [];
  await handleMemoryButton(
    {
      customId: "onboard:preset:co_conspirator:u-bob",
      user: { id: "u-bob", username: "Bob" },
      guildId: null,
      client: { guilds: { cache: new Map([["g1", { id: "g1", name: "Crew", ownerId: "u-bob" }]]) } },
      reply: async () => {},
      update: async (u: any) => { presetUpdates.push(u); },
    } as any,
    onboardingStore,
    async () => brain,
  );
  assert.equal(presetUpdates.length, 1);
  assert.equal(stateComp?.name, "Vex");
  assert.equal(stateComp?.onboardingState, "onboarding", "preset produces a reviewable draft before permanent lock");

  // 5. Submitting the companion-edit modal while still in 'onboarding' awakens and locks in the companion.
  const modalReplies: any[] = [];
  const editModal = buildCompanionEditModal(stateComp);
  assert.equal(editModal.data.custom_id, "companion-edit");
  await handleCompanionModal(
    {
      customId: "companion-edit",
      user: { id: "u-bob", username: "Bob" },
      client: { guilds: { cache: new Map() } },
      fields: {
        getTextInputValue: (id: string) => {
          if (id === "companion-name") return "Zephyr";
          if (id === "voice-persona") return "Calm and philosophical";
          if (id === "core-traits") return "calm, wise";
          if (id === "owner-dynamic") return "Trusted advisor";
          return "Old soul";
        },
      },
      reply: async (r: any) => { modalReplies.push(r); return r; },
    } as any,
    onboardingStore,
  );
  assert.equal(modalReplies.length, 1);
  assert.equal(stateComp.name, "Zephyr");
  assert.equal(stateComp.onboardingState, "active");

  // 6. Once awakened, any attempt to edit or re-awaken via modal or button is refused — locked!
  const lockedReplies: any[] = [];
  await handleCompanionModal(
    {
      customId: "companion-edit",
      user: { id: "u-bob", username: "Bob" },
      client: { guilds: { cache: new Map() } },
      fields: {
        getTextInputValue: () => "AttemptedRewrite",
      },
      reply: async (r: any) => { lockedReplies.push(r); return r; },
    } as any,
    onboardingStore,
  );
  assert.equal(lockedReplies.length, 1);
  assert.match(lockedReplies[0].content, /permanently locked/i);
  assert.equal(stateComp.name, "Zephyr", "companion name remains locked to Zephyr");

  const lockedBtnReplies: any[] = [];
  await handleMemoryButton(
    {
      customId: "onboard:edit:u-bob",
      user: { id: "u-bob", username: "Bob" },
      guildId: null,
      reply: async (r: any) => { lockedBtnReplies.push(r); return r; },
      update: async () => {},
    } as any,
    onboardingStore,
  );
  assert.equal(lockedBtnReplies.length, 1);
  assert.match(lockedBtnReplies[0].content, /permanently locked/i);

  // 7. Personal API Key Onboarding (user-key modal with blank Base URL auto-detects provider
  //    and immediately returns the Awaken Welcome Card for an un-onboarded user) + 1-click server:enable.
  const keyCard = buildApiKeyOnboardingPayload("u-new");
  assert.match(keyCard.embeds[0].data.description ?? "", /leave the Base URL field completely blank/i);
  const keyModal = buildUserApiKeyModal("user-key");
  assert.equal(keyModal.data.custom_id, "user-key");

  const storedKeys = new Map<string, any>();
  let pausedState = true;
  const purgedGuilds: string[] = [];
  const keyStore = {
    upsertGuildKey: async (scope: string, k: any) => { storedKeys.set(scope, k); },
    getCompanionByOwner: async () => null,
    setPaused: async (_gId: string, paused: boolean) => { pausedState = paused; },
    purgeGuild: async (gId: string) => { purgedGuilds.push(gId); },
  } as unknown as MemoryStore;

  const keyEditReplies: any[] = [];
  let validatedUrl = "";
  const prevSecret = config.keyEncryptionSecret;
  config.keyEncryptionSecret = "test-master-passphrase";
  try {
    await handleSetupModal(
      {
        customId: "user-key",
        guildId: null,
        user: { id: "u-new", username: "NewUser" },
        fields: {
          getTextInputValue: (id: string) => (id === "api-key" ? "sk-or-v1-testkey9876" : ""),
        },
        deferReply: async () => {},
        editReply: async (r: any) => { keyEditReplies.push(r); return r; },
        reply: async (r: any) => { keyEditReplies.push(r); return r; },
      } as any,
      keyStore,
      () => {},
      async (_k, url) => {
        validatedUrl = url;
        return { ok: true };
      },
    );
  } finally {
    config.keyEncryptionSecret = prevSecret;
  }
  assert.equal(validatedUrl, "https://openrouter.ai/api/v1", "blank Base URL auto-detected OpenRouter from sk-or- prefix");
  assert.ok(storedKeys.has("dm:u-new"), "stored personal key under dm:<userId>");
  assert.match(keyEditReplies[0]?.content ?? "", /OpenRouter auto-detected/i);
  assert.equal(keyEditReplies[0]?.embeds?.length, 1, "immediately attaches the Companion Welcome Card after key setup");

  // 8. 1-click server:enable button unpauses Characterly for server admins without needing a server key.
  const enableReplies: any[] = [];
  await handleMemoryButton(
    {
      customId: "server:enable",
      guildId: "g1",
      user: { id: "u-admin", username: "Admin" },
      memberPermissions: { has: () => true },
      reply: async (r: any) => { enableReplies.push(r); return r; },
      update: async () => {},
    } as any,
    keyStore,
  );
  assert.equal(pausedState, false, "server:enable unpaused the guild");
  assert.match(enableReplies[0]?.content ?? "", /Characterly is now \*\*enabled\*\*/i);

  // 9. server:decline — two-step: the click opens an ephemeral confirm and
  //    leaves the shared card untouched; the confirm edits the card, then
  //    leaves (GuildDelete purges every row). Non-admins refused at both
  //    steps; a cold guild cache falls back to fetch; a failed leave gets an
  //    ephemeral kick-me-manually fallback.
  let leftGuild = false;
  const declineReplies: any[] = [];
  await handleMemoryButton(
    {
      customId: "server:decline",
      guildId: "g1",
      guild: { leave: async () => { leftGuild = true; } },
      user: { id: "u-admin", username: "Admin" },
      memberPermissions: { has: () => true },
      message: { id: "m-card" },
      reply: async (r: any) => { declineReplies.push(r); return r; },
      update: async () => {},
    } as any,
    keyStore,
  );
  assert.equal(leftGuild, false, "decline alone never leaves — it only confirms");
  assert.equal(declineReplies.length, 1);
  assert.equal(declineReplies[0]?.ephemeral, true, "confirm prompt is ephemeral");
  assert.match(declineReplies[0]?.content ?? "", /can't be undone/i);
  const confirmId = declineReplies[0]?.components?.[0]?.components?.[0]?.data?.custom_id ?? "";
  assert.equal(confirmId, "server:declineconfirm:m-card", "confirm carries the card message id");

  // Confirm: updates the ephemeral, edits the card, then leaves.
  const cardEdits: any[] = [];
  const confirmUpdates: any[] = [];
  await handleMemoryButton(
    {
      customId: confirmId,
      guildId: "g1",
      guild: { id: "g1", leave: async () => { leftGuild = true; } },
      user: { id: "u-admin", username: "Admin" },
      memberPermissions: { has: () => true },
      channel: { messages: { fetch: async (id: string) => ({ edit: async (r: any) => { cardEdits.push({ id, ...r }); } }) } },
      client: { guilds: { fetch: async () => null, cache: { has: () => true } } },
      update: async (r: any) => { confirmUpdates.push(r); return r; },
      reply: async () => {},
      followUp: async () => {},
    } as any,
    keyStore,
  );
  assert.equal(leftGuild, true, "confirmed decline left the guild");
  assert.equal(confirmUpdates.length, 1);
  assert.deepEqual(confirmUpdates[0]?.components, []);
  assert.equal(cardEdits[0]?.id, "m-card", "the card message was edited on the way out");
  assert.match(cardEdits[0]?.content ?? "", /leaving this server/i);
  assert.deepEqual(cardEdits[0]?.components, []);
  assert.deepEqual(purgedGuilds, ["g1"], "successful leave purges directly — a dropped GuildDelete can't strand the privacy promise");

  // Cold cache: interaction.guild is null → falls back to guilds.fetch.
  let leftViaFetch = false;
  await handleMemoryButton(
    {
      customId: "server:declineconfirm:m-card",
      guildId: "g1",
      guild: null,
      user: { id: "u-admin", username: "Admin" },
      memberPermissions: { has: () => true },
      channel: { messages: { fetch: async () => null } },
      client: { guilds: { fetch: async () => ({ id: "g1", leave: async () => { leftViaFetch = true; } }), cache: { has: () => true } } },
      update: async () => {},
      reply: async () => {},
      followUp: async () => {},
    } as any,
    keyStore,
  );
  assert.equal(leftViaFetch, true, "cold-cache confirm fetches the guild");
  assert.equal(purgedGuilds.length, 2, "fetched-guild leave purges too");

  // Leave failure → ephemeral fallback says kick manually (purge still runs
  // on a real kick); an already-gone guild gets the benign message instead.
  const failFollowUps: any[] = [];
  await handleMemoryButton(
    {
      customId: "server:declineconfirm:m-card",
      guildId: "g1",
      guild: { leave: async () => { throw new Error("boom"); } },
      user: { id: "u-admin", username: "Admin" },
      memberPermissions: { has: () => true },
      channel: { messages: { fetch: async () => null } },
      client: { guilds: { fetch: async () => null, cache: { has: () => true } } },
      update: async () => {},
      reply: async () => {},
      followUp: async (r: any) => { failFollowUps.push(r); return r; },
    } as any,
    keyStore,
  );
  assert.match(failFollowUps[0]?.content ?? "", /kick me manually/i);
  assert.equal(purgedGuilds.length, 2, "a failed leave must NOT purge — the bot is still serving the guild");

  const goneUpdates: any[] = [];
  await handleMemoryButton(
    {
      customId: "server:declineconfirm:m-card",
      guildId: "g1",
      guild: null,
      user: { id: "u-admin", username: "Admin" },
      memberPermissions: { has: () => true },
      channel: { messages: { fetch: async () => null } },
      client: { guilds: { fetch: async () => { throw new Error("unknown guild"); }, cache: { has: () => false } } },
      update: async (r: any) => { goneUpdates.push(r); return r; },
      reply: async () => {},
      followUp: async () => {},
    } as any,
    keyStore,
  );
  assert.match(goneUpdates[0]?.content ?? "", /already gone/i, "double-confirm says already gone");

  // Non-admins are refused at both steps and nothing leaves.
  let leftGuildDenied = false;
  const deniedReplies: any[] = [];
  const deniedGuild = { leave: async () => { leftGuildDenied = true; } };
  for (const customId of ["server:decline", "server:declineconfirm:m-card"]) {
    await handleMemoryButton(
      {
        customId,
        guildId: "g1",
        guild: deniedGuild,
        user: { id: "u-member", username: "Member" },
        memberPermissions: { has: () => false },
        message: { id: "m-card" },
        channel: { messages: { fetch: async () => null } },
        client: { guilds: { fetch: async () => deniedGuild, cache: { has: () => true } } },
        reply: async (r: any) => { deniedReplies.push(r); return r; },
        update: async () => {},
        followUp: async () => {},
      } as any,
      keyStore,
    );
  }
  assert.equal(leftGuildDenied, false, "non-admin decline/confirm never leaves");
  assert.equal(deniedReplies.length, 2);
  assert.match(deniedReplies[0]?.content ?? "", /administrators/i);
  assert.equal(purgedGuilds.length, 2, "refused paths never purge");
});

test("DM lane: awakening owns DMs; adopted companions get private #adoptees threads", async () => {
  const awakenedActive = makeCompanion(1, "u-pat", "Nyx");
  const adopted = {
    ...makeCompanion(2, "u-pat", "Wren"),
    kind: "adopted",
    adoptedFromListingId: 11,
  } as GuildCompanion;

  // The DM gate predicate — fresh linked account, in-progress draft, and
  // awakened-active. The awakening flow owns DMs in the first two states;
  // adopted companions never enter this lane at all.
  assert.equal(isAwakenedCompanionActive(null), false, "fresh linked user → onboarding owns the DM");
  assert.equal(isAwakenedCompanionActive({ ...awakenedActive, onboardingState: "onboarding" }), false, "draft resumes onboarding");
  assert.equal(isAwakenedCompanionActive(awakenedActive), true, "awakened companion → normal chat");

  // Fake ops so adopteeThreadResult creates the private thread for real —
  // this is the adoption path's thread wiring end to end.
  const sentPayloads: unknown[] = [];
  const addedMembers: string[] = [];
  const thread = {
    id: "t-wren",
    members: { add: async (uid: string) => { addedMembers.push(uid); } },
    send: async (p: unknown) => { sentPayloads.push(p); },
    setLocked: async () => {}, setArchived: async () => {},
  };
  const createdThreads: Array<Record<string, unknown>> = [];
  const stampedThreads: string[] = [];
  const introduced: number[] = [];
  const adoption = { id: 9, userId: "u-pat", chatThreadId: null as string | null, dmIntroducedAt: null };
  const listing = { id: 11, name: "Wren", status: "active", greeting: "*waves*", creatorUserId: "u-creator" };
  const store = {
    listCompanionsForUser: async () => [adopted],
    getCompanionByOwner: async () => null,
    adoptionForCompanion: async () => adoption,
    listingById: async () => listing,
    listingForCompanion: async () => null,
    setAdoptionThread: async (_a: number, t: string) => { stampedThreads.push(t); adoption.chatThreadId = t; },
    setAdoptionLocation: async (_a: number, loc: { threadId?: string | null }) => { stampedThreads.push(loc.threadId ?? ""); adoption.chatThreadId = loc.threadId ?? null; },
    markDmIntroduced: async (a: number) => { introduced.push(a); },
    creatorBan: async () => null,
    accountForDiscordUser: async () => null,
    creditsSupported: false,
    trackEvent: async () => {},
    adoptListing: async () => ({ ok: true, companion: adopted, adoption, reused: false, revived: false }),
  } as unknown as MemoryStore;
  const savedAdoptees = config.houseAdopteesChannelId;
  const savedHouse = config.houseGuildId;
  config.houseAdopteesChannelId = "c-adoptees";
  config.houseGuildId = "g-house";
  initOps({
    store,
    fetchMember: async () => ({ user: { id: "u-pat", username: "Pat" } }),
    fetchChannel: async (id: string) => id === "c-adoptees"
      ? { send: async () => {}, threads: { create: async (o: Record<string, unknown>) => { createdThreads.push(o); return thread; } } }
      : id === thread.id ? thread : { send: async () => {} },
    fetchGuild: async () => null,
    botId: "bot-1",
  } as unknown as OpsDeps);
  const ix = (customId: string) => {
    const box: { replied: any } = { replied: null };
    return {
      box,
      interaction: {
        customId,
        user: { id: "u-pat", username: "Pat" },
        reply: async (r: any) => { box.replied = r; },
        update: async (r: any) => { box.replied = r; },
      } as any,
    };
  };
  try {
    // market:add — the adoption lands DEFERRED: no thread is created at the
    // click; the reply points at the Meet button instead of a channel link.
    const add = ix(`market:add:${listing.id}`);
    await handleMemoryButton(add.interaction, store);
    assert.match(add.box.replied?.content ?? "", /has joined your companions/);
    assert.match(add.box.replied?.content ?? "", /Meet/);
    assert.match(add.box.replied?.content ?? "", /\/companion summon/);
    assert.doesNotMatch(add.box.replied?.content ?? "", /<#t-wren>|answer your DMs|in your DMs/i);
    assert.ok(JSON.stringify(add.box.replied?.components ?? []).includes(`market:talk:${adopted.id}`), "the Meet button is the pointer");
    assert.ok(JSON.stringify(add.box.replied?.components ?? []).includes("onboard:start"), "awaken nudge offered while unawakened");
    assert.equal(createdThreads.length, 0, "adopt never creates — Meet does");

    // market:talk — the Meet click — opens the private thread, greets as the
    // companion, and points the clicker at it. No DM pick is involved.
    const talk = ix(`market:talk:${adopted.id}`);
    await handleMemoryButton(talk.interaction, store);
    assert.match(talk.box.replied?.content ?? "", /<#t-wren>/);
    assert.equal(createdThreads.length, 1);
    assert.equal(createdThreads[0].name, "Wren");
    assert.deepEqual(addedMembers, ["u-pat"]);
    assert.deepEqual(stampedThreads, ["t-wren"]);
    assert.deepEqual(introduced, [9]);
    assert.equal(sentPayloads.length, 2, "the greeting + pinned manage row posted");
    assert.ok(JSON.stringify(sentPayloads[1]).includes("market:drop:"), "manage row carries the drop button");

    // market:talk on the awakened companion → permanent-bond copy, no threads.
    const storeWoke = { ...store, listCompanionsForUser: async () => [awakenedActive] } as unknown as MemoryStore;
    const woke = ix(`market:talk:${awakenedActive.id}`);
    await handleMemoryButton(woke.interaction, storeWoke);
    assert.match(woke.box.replied?.content ?? "", /lives in my DMs/i);
    assert.equal(createdThreads.length, 1, "the awakened bond has no adoptee thread");

    // Re-clicking a listing they already hold (reused, not revived) names the
    // existing bond and offers the Drop escape hatch — no fake re-adopt copy.
    const storeDup = {
      ...store,
      adoptListing: async () => ({ ok: true, companion: adopted, adoption, reused: true, revived: false }),
    } as unknown as MemoryStore;
    const again = ix(`market:add:${listing.id}`);
    await handleMemoryButton(again.interaction, storeDup);
    assert.match(again.box.replied?.content ?? "", /already in your companions/);
    assert.ok(JSON.stringify(again.box.replied?.components ?? []).includes("market:drop:"), "drop button offered on re-click");
    assert.ok(JSON.stringify(again.box.replied?.components ?? []).includes("market:talk:"), "the Open button rides the re-click");
  } finally {
    config.houseAdopteesChannelId = savedAdoptees;
    config.houseGuildId = savedHouse;
    initOps(null as unknown as OpsDeps);
    resetOpsState();
  }
});

test("Meet picker: a multi-opening listing offers the scene select; the pick becomes the greeting", async () => {
  const adopted = {
    ...makeCompanion(2, "u-pat", "Wren"),
    kind: "adopted",
    adoptedFromListingId: 11,
  } as GuildCompanion;
  const sentPayloads: unknown[] = [];
  const thread = {
    id: "t-wren",
    members: { add: async () => {} },
    send: async (p: unknown) => { sentPayloads.push(p); return p; },
    setLocked: async () => {}, setArchived: async () => {},
    messages: { fetchPinned: async () => new Map(), fetch: async () => new Map() },
  };
  const createdThreads: Array<Record<string, unknown>> = [];
  const adoption = { id: 9, userId: "u-pat", chatGuildId: null, chatChannelId: null, chatThreadId: null as string | null, dmIntroducedAt: null as Date | null };
  const listing = {
    id: 11, name: "Wren", status: "active", creatorUserId: "u-creator",
    greeting: "*waves*",
    openings: [{ text: "*a bell rings*" }, { text: "a letter arrives" }],
  };
  const store = {
    listCompanionsForUser: async (uid: string) => (uid === "u-pat" ? [adopted] : []),
    adoptionForCompanion: async () => adoption,
    listingById: async () => listing,
    listingForCompanion: async () => null,
    setAdoptionLocation: async (_a: number, loc: { threadId?: string | null }) => { adoption.chatThreadId = loc.threadId ?? null; },
    setAdoptionThread: async (_a: number, t: string) => { adoption.chatThreadId = t; },
    markDmIntroduced: async () => { adoption.dmIntroducedAt = new Date(); },
    creatorBan: async () => null,
    accountForDiscordUser: async () => null,
    creditsSupported: false,
    trackEvent: async () => {},
  } as unknown as MemoryStore;
  const savedAdoptees = config.houseAdopteesChannelId;
  const savedHouse = config.houseGuildId;
  config.houseAdopteesChannelId = "c-adoptees";
  config.houseGuildId = "g-house";
  initOps({
    store,
    fetchMember: async () => ({ user: { id: "u-pat", username: "Pat" } }),
    fetchChannel: async (id: string) => id === "c-adoptees"
      ? { send: async () => {}, threads: { create: async (o: Record<string, unknown>) => { createdThreads.push(o); return thread; } } }
      : id === thread.id ? thread : { send: async () => {} },
    fetchGuild: async () => null,
    botId: "bot-1",
  } as unknown as OpsDeps);
  const ix = (customId: string) => {
    const box: { replied: any } = { replied: null };
    return {
      box,
      interaction: {
        customId,
        user: { id: "u-pat", username: "Pat" },
        reply: async (r: any) => { box.replied = r; },
        update: async (r: any) => { box.replied = r; },
      } as any,
    };
  };
  try {
    // Meet on a fresh adoption + multi-opening listing → the picker, not a
    // thread. Index 0 is the greeting; each opening follows; surprise is last.
    const talk = ix(`market:talk:${adopted.id}`);
    await handleMemoryButton(talk.interaction, store);
    assert.equal(createdThreads.length, 0, "the picker shows instead of creating");
    const menuJson = JSON.stringify(talk.box.replied?.components ?? []);
    assert.ok(menuJson.includes(`market:scenesel:${adopted.id}`), "the select is keyed to the companion");
    assert.ok(menuJson.includes("Surprise me"), "surprise rides the menu");
    assert.ok(menuJson.includes("Opening 2"), "unlabeled openings get ordinal labels");

    // Picking opening #2 → that text greets the fresh thread.
    const selBox: { replied: any } = { replied: null };
    await handleMarketSelect({
      customId: `market:scenesel:${adopted.id}`,
      user: { id: "u-pat", username: "Pat" },
      values: ["2"],
      update: async (r: any) => { selBox.replied = r; },
      reply: async (r: any) => { selBox.replied = r; },
    } as unknown as StringSelectMenuInteraction, store);
    assert.equal(createdThreads.length, 1, "the pick materializes the room");
    assert.match(selBox.replied?.content ?? "", /<#t-wren>/);
    assert.ok(JSON.stringify(sentPayloads[0]).includes("a letter arrives"), "the picked opening is the greeting");
    assert.ok(!JSON.stringify(sentPayloads[0]).includes("*waves*"), "the default greeting was replaced");

    // Once met, Meet is the plain Open — no picker, live thread reattaches.
    sentPayloads.length = 0;
    const reopen = ix(`market:talk:${adopted.id}`);
    await handleMemoryButton(reopen.interaction, store);
    assert.match(reopen.box.replied?.content ?? "", /<#t-wren>/);
    assert.ok(!JSON.stringify(reopen.box.replied?.components ?? []).includes("scenesel"), "an Open never re-picks the scene");
  } finally {
    config.houseAdopteesChannelId = savedAdoptees;
    config.houseGuildId = savedHouse;
    initOps(null as unknown as OpsDeps);
    resetOpsState();
  }
});

test("Meet picker: single-opening and greeting-only listings keep the one-click Meet", async () => {
  const adopted = {
    ...makeCompanion(2, "u-pat", "Wren"),
    kind: "adopted",
    adoptedFromListingId: 11,
  } as GuildCompanion;
  const sentPayloads: unknown[] = [];
  const thread = {
    id: "t-wren",
    members: { add: async () => {} },
    send: async (p: unknown) => { sentPayloads.push(p); return p; },
    setLocked: async () => {}, setArchived: async () => {},
    messages: { fetchPinned: async () => new Map(), fetch: async () => new Map() },
  };
  const createdThreads: Array<Record<string, unknown>> = [];
  const adoption = { id: 9, userId: "u-pat", chatGuildId: null, chatChannelId: null, chatThreadId: null as string | null, dmIntroducedAt: null as Date | null };
  const listing = { id: 11, name: "Wren", status: "active", creatorUserId: "u-creator", greeting: "*waves*", openings: [] };
  const store = {
    listCompanionsForUser: async (uid: string) => (uid === "u-pat" ? [adopted] : []),
    adoptionForCompanion: async () => adoption,
    listingById: async () => listing,
    listingForCompanion: async () => null,
    setAdoptionLocation: async (_a: number, loc: { threadId?: string | null }) => { adoption.chatThreadId = loc.threadId ?? null; },
    setAdoptionThread: async (_a: number, t: string) => { adoption.chatThreadId = t; },
    markDmIntroduced: async () => { adoption.dmIntroducedAt = new Date(); },
    creatorBan: async () => null,
    accountForDiscordUser: async () => null,
    creditsSupported: false,
    trackEvent: async () => {},
  } as unknown as MemoryStore;
  const savedAdoptees = config.houseAdopteesChannelId;
  const savedHouse = config.houseGuildId;
  config.houseAdopteesChannelId = "c-adoptees";
  config.houseGuildId = "g-house";
  initOps({
    store,
    fetchMember: async () => ({ user: { id: "u-pat" } }),
    fetchChannel: async (id: string) => id === "c-adoptees"
      ? { send: async () => {}, threads: { create: async (o: Record<string, unknown>) => { createdThreads.push(o); return thread; } } }
      : id === thread.id ? thread : { send: async () => {} },
    fetchGuild: async () => null,
    botId: "bot-1",
  } as unknown as OpsDeps);
  try {
    const talk = {
      replied: null as any,
      interaction: {
        customId: `market:talk:${adopted.id}`,
        user: { id: "u-pat", username: "Pat" },
        reply: async (r: any) => { talk.replied = r; },
        update: async (r: any) => { talk.replied = r; },
      } as any,
    };
    await handleMemoryButton(talk.interaction, store);
    assert.equal(createdThreads.length, 1, "no openings → straight to the room");
    assert.ok(!JSON.stringify(talk.replied?.components ?? []).includes("scenesel"));
    assert.ok(JSON.stringify(sentPayloads[0]).includes("*waves*"), "the canonical greeting posts");

    // A forged scenesel on a listing without openings can't inject text —
    // the pool is just the greeting, and an out-of-range index clamps to it.
    const selBox: { replied: any } = { replied: null };
    adoption.chatThreadId = null; adoption.dmIntroducedAt = null; createdThreads.length = 0; sentPayloads.length = 0;
    await handleMarketSelect({
      customId: `market:scenesel:${adopted.id}`,
      user: { id: "u-pat", username: "Pat" },
      values: ["<script>alert(1)</script>"],
      update: async (r: any) => { selBox.replied = r; },
      reply: async (r: any) => { selBox.replied = r; },
    } as unknown as StringSelectMenuInteraction, store);
    assert.ok(JSON.stringify(sentPayloads[0]).includes("*waves*"), "forged value resolves to the greeting");
    assert.ok(!JSON.stringify(sentPayloads[0]).includes("script"), "the value is an index, never text");

    // Someone else's roster → hard refuse.
    const deniedBox: { replied: any } = { replied: null };
    await handleMarketSelect({
      customId: `market:scenesel:${adopted.id}`,
      user: { id: "u-stranger", username: "Stranger" },
      values: ["1"],
      update: async (r: any) => { deniedBox.replied = r; },
      reply: async (r: any) => { deniedBox.replied = r; },
    } as unknown as StringSelectMenuInteraction, store);
    assert.match(deniedBox.replied?.content ?? "", /isn't on your roster/i);
  } finally {
    config.houseAdopteesChannelId = savedAdoptees;
    config.houseGuildId = savedHouse;
    initOps(null as unknown as OpsDeps);
    resetOpsState();
  }
});

test("DM persona header: CV2 payload carries name + avatar, degrades without one", () => {
  // With an avatar: section holds the bold name header, the reply text, and a
  // thumbnail accessory — the whole message is Components V2 (no `content`).
  const withAvatar = buildCompanionDmPayload({ name: "Wren", avatarUrl: "https://cdn.discordapp.com/a.png" }, "hello there");
  assert.equal(withAvatar.flags, MessageFlags.IsComponentsV2);
  assert.equal("content" in withAvatar, false, "CV2 forbids a content field");
  const section = withAvatar.components[0].toJSON();
  assert.equal(section.type, ComponentType.Section);
  assert.equal(section.components.length, 2);
  assert.equal(section.components[0].type, ComponentType.TextDisplay);
  assert.match(section.components[0].content, /\*\*Wren\*\*/);
  assert.equal(section.components[1].content, "hello there");
  assert.equal(section.accessory?.type, ComponentType.Thumbnail);
  assert.equal((section.accessory as any)?.media?.url ?? (section.accessory as any)?.url, "https://cdn.discordapp.com/a.png");

  // No avatar → no accessory, so no Section (Discord requires one per section);
  // bare text displays carry the name header instead.
  const bare = buildCompanionDmPayload({ name: "Nyx", avatarUrl: null }, "hi");
  assert.equal(bare.flags, MessageFlags.IsComponentsV2);
  assert.equal(bare.components.length, 2);
  const bareJson = bare.components.map(c => c.toJSON() as { type: ComponentType; content: string });
  assert.equal(bareJson[0].type, ComponentType.TextDisplay);
  assert.match(bareJson[0].content, /\*\*Nyx\*\*/);
  assert.equal(bareJson[1].content, "hi");

  // Markdown in a companion name can't break the header; empty name falls back.
  const tricky = buildCompanionDmPayload({ name: "Wre**n_1", avatarUrl: null }, "x");
  assert.match((tricky.components[0].toJSON() as { content: string }).content, /Wre\\\*\\\*n\\_1/);
  const unnamed = buildCompanionDmPayload({ name: "  ", avatarUrl: null }, "x");
  assert.match((unnamed.components[0].toJSON() as { content: string }).content, /\*\*Companion\*\*/);
});

// ── DB-backed integration tests ───────────────────────────────────────────────

test("companion lifecycle, /companion commands, and DM ↔ Server cross-context bridge", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const sql = makeTestSql();
  try {
    const { store, eventStore } = await makeStore(sql);

    // 1. Onboarding draft → activation
    const draft = await store.upsertCompanionOnboarding("u-alice", { name: "Nyx" }, true);
    assert.equal(draft.onboardingState, "onboarding");
    assert.equal(draft.onboardingTurns, 1);

    const active = await store.activateCompanion("u-alice", "Alice", {
      name: "Nyx",
      voicePersona: "Dry and observant",
      coreTraits: ["observant", "loyal"],
      ownerDynamic: "Ride-or-die confidant",
      backstory: "Born in DMs",
      avatarUrl: "https://example.com/nyx.png",
    });
    assert.equal(active.onboardingState, "active");
    assert.equal(active.name, "Nyx");

    // DM scope should never be flagged as a zombie guild by guildsNotIn
    await store.recordMessage(
      msg("secret DM message", { guildId: "dm:u-alice", authorId: "u-alice", authorName: "Alice" }),
    );
    // Promotion requires corroboration — two independent sightings cross the
    // gate; a single save stays a candidate now.
    const dmMem = {
      subjectId: "u-alice",
      kind: "person_fact" as const,
      content: "Alice is secretly interviewing at Acme Corp",
      reason: "stated in DM",
      evidenceType: "explicit_fact" as const,
      effect: "support" as const,
    };
    await store.saveMemory(
      msg("I am interviewing at Acme Corp", { guildId: "dm:u-alice", authorId: "u-alice", authorName: "Alice" }),
      dmMem,
      0.5,
    );
    await store.saveMemory(
      msg("the Acme Corp interview is next week", { guildId: "dm:u-alice", authorId: "u-alice", authorName: "Alice", messageId: "m2" }),
      dmMem,
      0.5,
    );
    const zombies = await store.guildsNotIn(["g1"]);
    assert.ok(!zombies.includes("dm:u-alice"), "dm:<userId> must never be treated as an orphan guild");

    // 2. Summon into guild g1 via /companion action:summon
    const replies: any[] = [];
    const makeIx = (opts: { guildId: string | null; action: string; userId?: string }) =>
      ({
        guildId: opts.guildId,
        channelId: "c1",
        id: "ix-comp",
        commandName: "companion",
        user: { id: opts.userId ?? "u-alice", username: "Alice" },
        memberPermissions: { has: () => false },
        options: {
          getString: (n: string) => (n === "action" ? opts.action : null),
          getUser: () => null,
        },
        reply: async (r: any) => { replies.push(r); return r; },
      }) as unknown as ChatInputCommandInteraction;

    await handleMemoryCommand(makeIx({ guildId: "g1", action: "summon" }), store, async () => ({}) as Brain, eventStore);
    assert.equal(replies.length, 1);
    const summoned = await store.listGuildCompanions("g1");
    assert.equal(summoned.length, 1);
    assert.equal(summoned[0].name, "Nyx");

    // 3. Webhook message tracking
    await store.recordWebhookMessage("wh-msg-1", "g1", "c1", active.id, 1);
    const wh = await store.getWebhookMessage("wh-msg-1");
    assert.equal(wh?.companionId, active.id);
    assert.equal(wh?.chainDepth, 1);

    // 4. Cross-context: DM → Server owner subtext & Server → DM digest
    const subtext = await gatherOwnerSubtextForServer(store, "u-alice", active.id);
    assert.ok(subtext?.includes("Acme Corp"), "owner subtext should include active private DM memories");

    await eventStore.createEvent({
      guildId: "g1",
      channelId: "c1",
      title: "Great Pasta Argument",
      summary: "Alice and Bob debated pasta shapes for an hour",
      significance: 0.8,
      tier: "event",
      occurredAt: new Date(),
      participants: [{ userId: "u-alice", userName: "Alice", role: "subject" }],
    });
    const digest = await gatherServerDigestForDm(store, eventStore, "u-alice", active, () => "Friend Server");
    assert.ok(digest?.includes("Friend Server"));
    assert.ok(digest?.includes("Great Pasta Argument"));

    // 5. Permanent 1-companion-per-account lock: once active, activateCompanion and
    //    upsertCompanionOnboarding cannot overwrite the locked persona, and edit/reset are refused.
    const attemptedOverwrite = await store.activateCompanion("u-alice", "Alice", {
      name: "Impostor",
      voicePersona: "Completely different",
      coreTraits: ["different"],
      ownerDynamic: "Stranger",
      backstory: "None",
    });
    assert.equal(attemptedOverwrite.name, "Nyx", "activateCompanion must not overwrite an already-active companion");
    const attemptedDraft = await store.upsertCompanionOnboarding("u-alice", { name: "DraftOverwrite" }, true);
    assert.equal(attemptedDraft.name, "Nyx", "upsertCompanionOnboarding must not mutate an already-active companion");
    assert.equal(attemptedDraft.onboardingState, "active");

    const resetReplies: any[] = [];
    const resetIx = {
      ...makeIx({ guildId: null, action: "reset" }),
      reply: async (r: any) => { resetReplies.push(r); return r; },
    } as unknown as ChatInputCommandInteraction;
    await handleMemoryCommand(resetIx, store, async () => ({}) as Brain, eventStore);
    assert.match(resetReplies[0]?.content ?? "", /permanently locked/i);
    assert.equal((await store.getCompanionByOwner("u-alice"))?.name, "Nyx");
  } finally {
    await sql.end();
  }
});
