import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType } from "discord.js";
import type { ButtonInteraction, ChatInputCommandInteraction, MessageContextMenuCommandInteraction, ModalSubmitInteraction, StringSelectMenuInteraction } from "discord.js";
import { handleMemoryButton, handleMemoryCommand, handleMarketplaceContext, handleMarketSelect, handleSetupModal, handleCompanionModal, buildCoverModal, buildPublishModal } from "./commands.js";
import { ProfileStore } from "./profiles.js";
import type { MemoryStore } from "./database.js";
import { makeTestSql, makeStore } from "./test-helpers.js";
import type { Brain } from "./brain.js";
import type { EventStore } from "./events.js";
import type { MessageEvent } from "./types.js";
import { config } from "./config.js";
import { decryptSecret } from "./secrets.js";

// ── Interaction stubs ─────────────────────────────────────────────────────────

type Replies = Array<{ content?: string; embeds?: unknown[]; components?: unknown[]; files?: unknown[]; ephemeral?: boolean }>;

function stubCommand(opts: {
  commandName: string;
  userId?: string;
  username?: string;
  admin?: boolean;
  options?: Record<string, unknown>;
  subcommand?: string;
  channel?: { id: string; parentId?: string | null };
}): { interaction: ChatInputCommandInteraction; replies: Replies } {
  const replies: Replies = [];
  const interaction = {
    guildId: "g1",
    channelId: "c1",
    channel: opts.channel ?? { id: "c1" },
    id: "ix-1",
    commandName: opts.commandName,
    user: { id: opts.userId ?? "u-user", username: opts.username ?? "User" },
    memberPermissions: { has: () => !!opts.admin },
    options: {
      getSubcommand: (_required?: boolean) => opts.subcommand ?? null,
      getBoolean: (name: string) => opts.options?.[name] ?? null,
      getInteger: (name: string, _required?: boolean) => opts.options?.[name] ?? null,
      getString: (name: string, _required?: boolean) => opts.options?.[name] ?? null,
      getUser: (name: string) => opts.options?.[name] ?? null,
      getChannel: (name: string) => opts.options?.[name] ?? null,
      getAttachment: (name: string) => opts.options?.[name] ?? null,
    },
    reply: async (r: (typeof replies)[number]) => { replies.push(r); return r; },
    editReply: async (r: string) => { replies.push({ content: r }); return r; },
    deferReply: async () => {},
    showModal: async (m: unknown) => { replies.push({ content: `modal:${(m as { data?: { custom_id?: string } }).data?.custom_id ?? "?"}` }); },
    replied: false,
    deferred: false,
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, replies };
}

function stubButton(opts: {
  customId: string; userId: string; guildId?: string; admin?: boolean; channelId?: string;
  member?: unknown; channels?: Record<string, unknown>; message?: { content: string };
  onMemberEdit?: (userId: string, data: unknown) => Promise<unknown>;
}): { interaction: ButtonInteraction; replies: Replies; updates: Replies } {
  const replies: Replies = [];
  const updates: Replies = [];
  // Empty message fetch → the ingest loop breaks immediately and the build
  // completes on an empty backlog rather than retrying forever on a stub.
  const channel = { type: 0, name: "general", send: async () => {}, messages: { fetch: async () => new Map() } };
  const interaction = {
    customId: opts.customId,
    user: { id: opts.userId },
    guildId: opts.guildId ?? "g1",
    memberPermissions: { has: () => !!opts.admin },
    member: opts.member,
    guild: {
      channels: {
        cache: { get: (id: string) => (id === (opts.channelId ?? "ch-1") ? channel : null) },
        fetch: async () => channel,
      },
      members: { edit: opts.onMemberEdit ?? (async () => ({})) },
    },
    channel: { send: async () => {} },
    message: opts.message ?? { content: "" },
    client: {
      user: { id: "bot-1" },
      channels: { fetch: async (id: string) => opts.channels?.[id] ?? null },
      users: { fetch: async () => null },
    },
    reply: async (r: (typeof replies)[number]) => { replies.push(r); return r; },
    update: async (r: (typeof updates)[number]) => { updates.push(r); return r; },
    showModal: async (m: unknown) => { replies.push({ content: `modal:${(m as { data?: { custom_id?: string } }).data?.custom_id ?? "?"}` }); },
  };
  return { interaction: interaction as unknown as ButtonInteraction, replies, updates };
}

const brain = {} as Brain; // commands under test here never reach the LLM
const brainFor = async () => brain; // resolver signature — guild keys untested at this level
const evStore = { eventsForMemory: async () => [] } as unknown as EventStore;

function msg(content: string, overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    guildId: "g1", channelId: "c1", messageId: `m-${Math.random().toString(36).slice(2)}`,
    authorId: "u-user", authorName: "User",
    content, createdAt: new Date(), mentionsBot: false,
    ...overrides,
  };
}

const candidate = {
  subjectId: "u-user", kind: "person_fact" as const, content: "User has a cat",
  reason: "Heard it somewhere", evidenceType: "reported_by_other" as const, effect: "support" as const,
};

// ── Cross-member read authorization ──────────────────────────────────────────

test("/memory about: a non-admin cannot view another member's memories", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const { interaction, replies } = stubCommand({
      commandName: "memory", userId: "u-user",
      options: { about: { id: "u-other", username: "Other" } },
    });
    await handleMemoryCommand(interaction, store, brainFor);
    assert.match(replies[0].content ?? "", /only view your own/i);
  } finally { await sql.end(); }
});

test("/memory about: an admin can view another member's memories", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.setMemberOptIn("g1", "u-other", true); // derived data requires consent
    const { interaction, replies } = stubCommand({
      commandName: "memory", userId: "u-admin", admin: true,
      options: { about: { id: "u-other", username: "Other" } },
    });
    await handleMemoryCommand(interaction, store, brainFor);
    assert.ok(replies[0].embeds?.length, "expected an embed reply");
  } finally { await sql.end(); }
});

test("/memory memory_id: non-admin cannot inspect another member's memory, admin can", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("I have a cat"), candidate);
    const denied = stubCommand({ commandName: "memory", userId: "u-stranger", options: { memory_id: mem.id } });
    await handleMemoryCommand(denied.interaction, store, brainFor);
    assert.match(denied.replies[0].content ?? "", /couldn't find/i);
    const allowed = stubCommand({ commandName: "memory", userId: "u-admin", admin: true, options: { memory_id: mem.id } });
    await handleMemoryCommand(allowed.interaction, store, brainFor);
    assert.ok(allowed.replies[0].embeds?.length, "expected provenance embed");
  } finally { await sql.end(); }
});

test("/profile user: and /dossier user: block non-admin cross-member views", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    for (const commandName of ["profile", "dossier"]) {
      const { interaction, replies } = stubCommand({
        commandName, userId: "u-stranger",
        options: { user: { id: "u-other", username: "Other" } },
      });
      await handleMemoryCommand(interaction, store, brainFor);
      assert.match(replies[0].content ?? "", /only view your own/i, commandName);
    }
  } finally { await sql.end(); }
});

test("/event memory_id: non-admin cannot inspect another member's memory linkage", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("I have a cat"), candidate);
    const { interaction, replies } = stubCommand({
      commandName: "event", userId: "u-stranger", options: { memory_id: mem.id },
    });
    await handleMemoryCommand(interaction, store, brainFor, evStore);
    assert.match(replies[0].content ?? "", /couldn't find/i);
  } finally { await sql.end(); }
});

// ── Admin gates ───────────────────────────────────────────────────────────────

test("admin commands refuse non-admin callers", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    for (const [commandName, options] of [
      ["memory", { stats: true }],
      ["memory-purge", { older_than_days: 7 }],
      ["memory-pause", {}],
      ["memory-resume", {}],
      ["status", {}],
      ["memory-triage", {}],
      ["memory-settings", {}],
    ] as const) {
      const { interaction, replies } = stubCommand({ commandName, userId: "u-stranger", options });
      await handleMemoryCommand(interaction, store, brainFor);
      assert.match(replies[0].content ?? "", /administrator/i, commandName);
    }
  } finally { await sql.end(); }
});

test("/memory-pause flips both settings flags for admins only", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const { interaction } = stubCommand({ commandName: "memory-pause", userId: "u-admin", admin: true });
    await handleMemoryCommand(interaction, store, brainFor);
    const settings = await store.settings("g1");
    assert.equal(settings.memoryEnabled, 0);
    assert.equal(settings.replyEnabled, 0);
  } finally { await sql.end(); }
});

test("/memory-purge rejects a sub-one-day retention even for admins", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const { interaction, replies } = stubCommand({
      commandName: "memory-purge", userId: "u-admin", admin: true, options: { older_than_days: 0 },
    });
    await handleMemoryCommand(interaction, store, brainFor);
    assert.match(replies[0].content ?? "", /at least one day/i);
  } finally { await sql.end(); }
});

// ── Ownership-gated writes ────────────────────────────────────────────────────

test("/forget refuses memories owned by someone else", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("I have a cat", { authorId: "u-owner" }), candidate);
    const { interaction, replies } = stubCommand({
      commandName: "forget", userId: "u-stranger", options: { memory_id: mem.id },
    });
    await handleMemoryCommand(interaction, store, brainFor);
    assert.match(replies[0].content ?? "", /couldn't find/i);
    assert.equal((await store.getMemory("g1", mem.id))?.status, "candidate");
  } finally { await sql.end(); }
});

test("/forget on your own memory offers a confirm button, and the button forgets it", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("I have a cat"), candidate);
    const { interaction, replies } = stubCommand({
      commandName: "forget", userId: "u-user", options: { memory_id: mem.id },
    });
    await handleMemoryCommand(interaction, store, brainFor);
    assert.ok(replies[0].components?.length, "expected a confirmation row");

    const button = stubButton({ customId: `forget:g1:u-user:${mem.id}`, userId: "u-user" });
    await handleMemoryButton(button.interaction, store);
    assert.match(updates_content(button.updates), /forgot memory/i);
    assert.equal((await store.getMemory("g1", mem.id))?.status, "forgotten");
  } finally { await sql.end(); }
});

test("forget button rejects a click from anyone but the owner", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("I have a cat"), candidate);
    const { interaction, replies, updates } = stubButton({ customId: `forget:g1:u-user:${mem.id}`, userId: "u-stranger" });
    await handleMemoryButton(interaction, store);
    assert.equal(updates.length, 0);
    assert.match(replies[0].content ?? "", /not valid for you/i);
    assert.equal((await store.getMemory("g1", mem.id))?.status, "candidate");
  } finally { await sql.end(); }
});

test("/memory-confirm only activates your own candidates", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("I have a cat"), candidate);
    // Someone else's candidate — refused, stays candidate.
    const denied = stubCommand({ commandName: "memory-confirm", userId: "u-stranger", options: { memory_id: mem.id } });
    await handleMemoryCommand(denied.interaction, store, brainFor);
    assert.match(denied.replies[0].content ?? "", /couldn't find/i);
    assert.equal((await store.getMemory("g1", mem.id))?.status, "candidate");
    // The owner — confirmed and active.
    const own = stubCommand({ commandName: "memory-confirm", userId: "u-user", options: { memory_id: mem.id } });
    await handleMemoryCommand(own.interaction, store, brainFor);
    assert.equal((await store.getMemory("g1", mem.id))?.status, "active");
  } finally { await sql.end(); }
});

// ── Opt-out / opt-in ──────────────────────────────────────────────────────────

test("/opt-out forgets memories and deletes the profile; /opt-in re-enables", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const mem = await store.saveMemory(msg("I have a cat"), candidate);
    const out = stubCommand({ commandName: "opt-out", userId: "u-user" });
    await handleMemoryCommand(out.interaction, store, brainFor, undefined, new ProfileStore(sql));
    assert.match(out.replies[0].content ?? "", /opted out/i);
    assert.equal((await store.getMember("g1", "u-user"))?.optedOut, true);
    assert.equal((await store.getMemory("g1", mem.id))?.status, "forgotten");

    const back = stubCommand({ commandName: "opt-in", userId: "u-user" });
    await handleMemoryCommand(back.interaction, store, brainFor);
    const member = await store.getMember("g1", "u-user");
    assert.equal(member?.optedOut, false);
    assert.equal(member?.optedIn, true); // /opt-in now grants derived-data consent
    // Forgotten stays forgotten — opt-in doesn't resurrect.
    assert.equal((await store.getMemory("g1", mem.id))?.status, "forgotten");
  } finally { await sql.end(); }
});

test("/memory for a member who never opted in points at /profile-build", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const { interaction, replies } = stubCommand({ commandName: "memory", userId: "u-user" });
    await handleMemoryCommand(interaction, store, brainFor);
    assert.match(replies[0].content ?? "", /profile-build/i);
  } finally { await sql.end(); }
});

test("/profile-build opts the member in and reports the scan", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const { interaction, replies } = stubCommand({ commandName: "profile-build", userId: "u-user" });
    await handleMemoryCommand(interaction, store, brainFor, undefined, new ProfileStore(sql));
    assert.equal((await store.getMember("g1", "u-user"))?.optedIn, true);
    assert.match(replies.at(-1)?.content ?? "", /scanned 0 messages/i);
  } finally { await sql.end(); }
});

// ── /setup (BYOK) ─────────────────────────────────────────────────────────────

function stubModal(opts: { key?: string; baseUrl?: string; guildId?: string; admin?: boolean }) {
  const replies: Replies = [];
  const interaction = {
    customId: "setup-key",
    guildId: opts.guildId ?? "g1",
    memberPermissions: { has: () => opts.admin !== false },
    fields: { getTextInputValue: (id: string) => id === "api-key" ? (opts.key ?? "") : (opts.baseUrl ?? "") },
    reply: async (r: { content: string }) => { replies.push({ content: r.content }); return r; },
    deferReply: async () => {},
    editReply: async (r: string) => { replies.push({ content: r }); return r; },
  };
  return { interaction: interaction as unknown as ModalSubmitInteraction, replies };
}

test("/setup: non-admin rejected; admin without KEY_ENCRYPTION_SECRET gets the operator message", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const denied = stubCommand({ commandName: "setup", userId: "u-stranger" });
    await handleMemoryCommand(denied.interaction, store, brainFor);
    assert.match(denied.replies[0].content ?? "", /administrator/i);

    const saved = config.keyEncryptionSecret;
    config.keyEncryptionSecret = undefined;
    try {
      const admin = stubCommand({ commandName: "setup", userId: "u-admin", admin: true });
      await handleMemoryCommand(admin.interaction, store, brainFor);
      assert.match(admin.replies[0].content ?? "", /KEY_ENCRYPTION_SECRET/i);
    } finally { config.keyEncryptionSecret = saved; }
  } finally { await sql.end(); }
});

test("/setup modal: valid key stores ciphertext + masked hint and invalidates the cache", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const saved = config.keyEncryptionSecret;
    config.keyEncryptionSecret = "test-master-passphrase";
    try {
      let invalidated = "";
      const { interaction, replies } = stubModal({ key: "gsk_test_secretkey1234" });
      await handleSetupModal(interaction, store, g => { invalidated = g; }, async () => ({ ok: true }));
      const row = await store.getGuildKey("g1");
      assert.ok(row, "guild key row missing");
      assert.equal(row!.keyHint, "…1234");
      assert.equal(decryptSecret(row!.keyEnc), "gsk_test_secretkey1234"); // ciphertext round-trips
      assert.ok(row!.validatedAt, "validated key should carry validated_at");
      assert.equal(invalidated, "g1");
      assert.match(replies.at(-1)?.content ?? "", /…1234/);
      assert.doesNotMatch(replies.at(-1)?.content ?? "", /gsk_test_secretkey1234/); // never echo the key
    } finally { config.keyEncryptionSecret = saved; }
  } finally { await sql.end(); }
});

test("/setup modal: non-admin submit is re-checked and rejected", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const saved = config.keyEncryptionSecret;
    config.keyEncryptionSecret = "test-master-passphrase";
    try {
      const denied = stubModal({ key: "gsk_test_secretkey1234", guildId: "g-setup-nonadmin", admin: false });
      await handleSetupModal(denied.interaction, store, () => {}, async () => ({ ok: true }));
      assert.match(denied.replies[0]?.content ?? "", /Manage Server|permission/i);
      assert.equal(await store.getGuildKey("g-setup-nonadmin"), null, "nothing should be stored for a non-admin submit");
    } finally { config.keyEncryptionSecret = saved; }
  } finally { await sql.end(); }
});

test("/setup modal: rejected key stores nothing; unreachable stores unverified", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const saved = config.keyEncryptionSecret;
    config.keyEncryptionSecret = "test-master-passphrase";
    try {
      const bad = stubModal({ key: "bad-key", guildId: "g-setup-bad" });
      await handleSetupModal(bad.interaction, store, () => {}, async () => ({ ok: false, status: 401 }));
      assert.equal(await store.getGuildKey("g-setup-bad"), null);
      assert.match(bad.replies.at(-1)?.content ?? "", /rejected|auth/i);

      const flaky = stubModal({ key: "gsk_unverified9999", guildId: "g-setup-flaky" });
      await handleSetupModal(flaky.interaction, store, () => {}, async () => ({ ok: false, unreachable: true }));
      const row = await store.getGuildKey("g-setup-flaky");
      assert.ok(row, "unverified key should still be stored");
      assert.equal(row!.validatedAt, null);
      assert.match(flaky.replies.at(-1)?.content ?? "", /unverified|couldn't reach/i);

      const ssrf = stubModal({ key: "gsk_whatever1234", baseUrl: "http://169.254.169.254/v1", guildId: "g-setup-ssrf" });
      await handleSetupModal(ssrf.interaction, store, () => {}, async () => ({ ok: true }));
      assert.equal(await store.getGuildKey("g-setup-ssrf"), null);
      assert.match(ssrf.replies.at(-1)?.content ?? "", /base URL|public http/i);
    } finally { config.keyEncryptionSecret = saved; }
  } finally { await sql.end(); }
});

function updates_content(updates: Replies): string {
  return updates.map(u => u.content ?? "").join("\n");
}

// ── /privacy ────────────────────────────────────────────────────────────────────

test("/privacy is ephemeral and reflects the caller's consent state", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const anon = stubCommand({ commandName: "privacy", userId: "u-anon" });
    await handleMemoryCommand(anon.interaction, store, brainFor);
    assert.equal(anon.replies[0].ephemeral, true, "privacy replies must be ephemeral");
    const fields = JSON.stringify(anon.replies[0].embeds);
    assert.match(fields, /not opted in/i);
    assert.match(fields, /\*\*30 days\*\*|30 days/, "retention should be shown");

    await store.setMemberOptIn("g1", "u-consented", true);
    const consented = stubCommand({ commandName: "privacy", userId: "u-consented" });
    await handleMemoryCommand(consented.interaction, store, brainFor);
    assert.match(JSON.stringify(consented.replies[0].embeds), /opted in/i);
  } finally { await sql.end(); }
});

test("/privacy status reflects the effective posture, not just memory_enabled", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    // Fresh guild: dormant default → "Dormant" regardless of the brain.
    const dormant = stubCommand({ commandName: "privacy", userId: "u-x" });
    await handleMemoryCommand(dormant.interaction, store, brainFor);
    assert.match(JSON.stringify(dormant.replies[0].embeds), /Dormant/);

    // Resumed but no resolvable key — handleMessage would bail at brainFor, so
    // "Observing" would be a lie; the third state must show instead.
    await store.setPaused("g1", false); // memory_enabled=1, reply_enabled=1
    const noKey = stubCommand({ commandName: "privacy", userId: "u-x" });
    await handleMemoryCommand(noKey.interaction, store, async () => null);
    const fields = JSON.stringify(noKey.replies[0].embeds);
    assert.match(fields, /no active companion key/i);
    assert.doesNotMatch(fields, /Observing/);

    // Resumed WITH a key → the full observing message.
    const live = stubCommand({ commandName: "privacy", userId: "u-x" });
    await handleMemoryCommand(live.interaction, store, brainFor);
    assert.match(JSON.stringify(live.replies[0].embeds), /Observing/);
  } finally { await sql.end(); }
});

// ── /limits + ignored channels + /status usage panel ─────────────────────────

test("/limits validates the range and writes llm_daily_cap", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const nonAdmin = stubCommand({ commandName: "limits", userId: "u-stranger", options: { daily_cap: 500 } });
    await handleMemoryCommand(nonAdmin.interaction, store, brainFor);
    assert.match(nonAdmin.replies[0]?.content ?? "", /administrator/i);

    for (const bad of [-1, 200000]) {
      const cmd = stubCommand({ commandName: "limits", userId: "u-admin", admin: true, options: { daily_cap: bad } });
      await handleMemoryCommand(cmd.interaction, store, brainFor);
      assert.match(cmd.replies[0]?.content ?? "", /between/i, `cap ${bad} should be rejected`);
    }

    const ok = stubCommand({ commandName: "limits", userId: "u-admin", admin: true, options: { daily_cap: 250 } });
    await handleMemoryCommand(ok.interaction, store, brainFor);
    assert.match(ok.replies[0]?.content ?? "", /250/);
    assert.equal((await store.settings("g1")).llmDailyCap, 250);

    // 0 is the documented block-all lever.
    const zero = stubCommand({ commandName: "limits", userId: "u-admin", admin: true, options: { daily_cap: 0 } });
    await handleMemoryCommand(zero.interaction, store, brainFor);
    assert.match(zero.replies[0]?.content ?? "", /blocked/i);
    assert.equal((await store.settings("g1")).llmDailyCap, 0);
  } finally { await sql.end(); }
});

test("/ignore-channel + /unignore-channel manage the ignored set; /memory-settings lists it", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const deny = stubCommand({ commandName: "ignore-channel", userId: "u-stranger", options: { channel: { id: "ch-9" } } });
    await handleMemoryCommand(deny.interaction, store, brainFor);
    assert.match(deny.replies[0]?.content ?? "", /administrator/i);
    assert.deepEqual((await store.settings("g1")).ignoredChannels, []);

    const add = stubCommand({ commandName: "ignore-channel", userId: "u-admin", admin: true, options: { channel: { id: "ch-9" } } });
    await handleMemoryCommand(add.interaction, store, brainFor);
    assert.match(add.replies[0]?.content ?? "", /invisible/i);
    assert.deepEqual((await store.settings("g1")).ignoredChannels, ["ch-9"]);

    // Idempotent add → "already ignored".
    const again = stubCommand({ commandName: "ignore-channel", userId: "u-admin", admin: true, options: { channel: { id: "ch-9" } } });
    await handleMemoryCommand(again.interaction, store, brainFor);
    assert.match(again.replies[0]?.content ?? "", /already/i);
    assert.equal((await store.settings("g1")).ignoredChannels.length, 1);

    // /memory-settings surfaces the list.
    const view = stubCommand({ commandName: "memory-settings", userId: "u-admin", admin: true });
    await handleMemoryCommand(view.interaction, store, brainFor);
    assert.match(view.replies[0]?.content ?? "", /ch-9|Ignored channels/i);

    const remove = stubCommand({ commandName: "unignore-channel", userId: "u-admin", admin: true, options: { channel: { id: "ch-9" } } });
    await handleMemoryCommand(remove.interaction, store, brainFor);
    assert.match(remove.replies[0]?.content ?? "", /visible/i);
    assert.deepEqual((await store.settings("g1")).ignoredChannels, []);
  } finally { await sql.end(); }
});

test("/quiet-channel + /unquiet-channel manage the quiet set; /memory-settings lists it", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const deny = stubCommand({ commandName: "quiet-channel", userId: "u-stranger", options: { channel: { id: "ch-9" } } });
    await handleMemoryCommand(deny.interaction, store, brainFor);
    assert.match(deny.replies[0]?.content ?? "", /administrator/i);
    assert.deepEqual((await store.settings("g1")).quietChannels, []);

    // No channel option → defaults to the invoking channel.
    const def = stubCommand({ commandName: "quiet-channel", userId: "u-admin", admin: true, channel: { id: "c1" } });
    await handleMemoryCommand(def.interaction, store, brainFor);
    assert.match(def.replies[0]?.content ?? "", /still observes|still observing/i);
    assert.deepEqual((await store.settings("g1")).quietChannels, ["c1"]);

    // Explicit target adds a second channel; re-quiet is idempotent.
    const add = stubCommand({ commandName: "quiet-channel", userId: "u-admin", admin: true, options: { channel: { id: "ch-9" } } });
    await handleMemoryCommand(add.interaction, store, brainFor);
    assert.deepEqual((await store.settings("g1")).quietChannels, ["c1", "ch-9"]);
    const again = stubCommand({ commandName: "quiet-channel", userId: "u-admin", admin: true, options: { channel: { id: "ch-9" } } });
    await handleMemoryCommand(again.interaction, store, brainFor);
    assert.match(again.replies[0]?.content ?? "", /already/i);
    assert.equal((await store.settings("g1")).quietChannels.length, 2);

    // /memory-settings distinguishes quiet (still observing) from ignored.
    const view = stubCommand({ commandName: "memory-settings", userId: "u-admin", admin: true });
    await handleMemoryCommand(view.interaction, store, brainFor);
    assert.match(view.replies[0]?.content ?? "", /Quiet channels.*still observing/si);
    assert.match(view.replies[0]?.content ?? "", /ch-9/);

    const rm = stubCommand({ commandName: "unquiet-channel", userId: "u-admin", admin: true, options: { channel: { id: "ch-9" } } });
    await handleMemoryCommand(rm.interaction, store, brainFor);
    assert.match(rm.replies[0]?.content ?? "", /speak.*again/i);
    assert.deepEqual((await store.settings("g1")).quietChannels, ["c1"]);

    const notQuiet = stubCommand({ commandName: "unquiet-channel", userId: "u-admin", admin: true, options: { channel: { id: "ch-9" } } });
    await handleMemoryCommand(notQuiet.interaction, store, brainFor);
    assert.match(notQuiet.replies[0]?.content ?? "", /isn't quiet/i);
  } finally { await sql.end(); }
});

test("/companions-pause flips only reply_enabled — memory keeps running; resume restores", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const deny = stubCommand({ commandName: "companions-pause", userId: "u-stranger" });
    await handleMemoryCommand(deny.interaction, store, brainFor);
    assert.match(deny.replies[0]?.content ?? "", /administrator/i);

    // Guilds are dormant by default (v16) — enable first, as the enable
    // button would, so the pause/resume deltas are observable.
    await store.setPaused("g1", false);

    const pause = stubCommand({ commandName: "companions-pause", userId: "u-admin", admin: true });
    await handleMemoryCommand(pause.interaction, store, brainFor);
    assert.match(pause.replies[0]?.content ?? "", /still observes|still.*remember/i);
    let settings = await store.settings("g1");
    assert.equal(settings.replyEnabled, 0, "replies silenced");
    assert.equal(settings.memoryEnabled, 1, "memory collection must stay on");

    const resume = stubCommand({ commandName: "companions-resume", userId: "u-admin", admin: true });
    await handleMemoryCommand(resume.interaction, store, brainFor);
    assert.equal((await store.settings("g1")).replyEnabled, 1);

    // Independence both ways: a full pause then companions-resume must not
    // resurrect memory collection.
    await store.setPaused("g1", true);
    const resume2 = stubCommand({ commandName: "companions-resume", userId: "u-admin", admin: true });
    await handleMemoryCommand(resume2.interaction, store, brainFor);
    settings = await store.settings("g1");
    assert.equal(settings.replyEnabled, 1);
    assert.equal(settings.memoryEnabled, 0, "companions-resume must not unpause memory");
  } finally { await sql.end(); }
});

test("/status renders the LLM usage panel", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.setDailyCap("g1", 500);
    await store.chargeLlmCall("g1", 500);
    await sql`INSERT INTO jobs (guild_id, type, payload) VALUES ('g1', 'extract', '{}')`;
    const cmd = stubCommand({ commandName: "status", userId: "u-admin", admin: true });
    await handleMemoryCommand(cmd.interaction, store, brainFor);
    const desc = JSON.stringify(cmd.replies[0]?.embeds ?? []);
    assert.match(desc, /LLM usage/i);
    assert.match(desc, /500/);
    assert.match(desc, /queue/i);
    assert.match(desc, /companions/i);
  } finally { await sql.end(); }
});

test("/opt-out deletes consolidated behavioral patterns", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.setMemberOptIn("g1", "u-user", true);
    // Three active episodes consolidate into a behavioral pattern — derived
    // person data that must die with the rest on opt-out, or it resurfaces
    // into the rebuilt profile on re-opt-in.
    for (let i = 0; i < 3; i++) {
      const mem = await store.saveMemory(msg(`did activity ${i}`), {
        subjectId: "u-user", kind: "episode", content: `User did activity ${i}`,
        reason: "observed", evidenceType: "explicit_fact", effect: "support",
      });
      await store.confirm("g1", mem.id);
    }
    assert.equal(await store.consolidateEpisodes("g1", "u-user"), 1);
    assert.equal((await store.patterns("g1", "u-user")).length, 1);

    const { interaction } = stubCommand({ commandName: "opt-out", userId: "u-user" });
    await handleMemoryCommand(interaction, store, brainFor, evStore, new ProfileStore(sql as never));
    assert.equal((await store.patterns("g1", "u-user")).length, 0, "opt-out must delete derived patterns");
    assert.equal((await store.listMemories("g1", "u-user", {})).memories.filter(m => m.status !== "forgotten").length, 0);
  } finally { await sql.end(); }
});

// ── Marketplace: ratings ─────────────────────────────────────────────────────

async function makeListingRow(store: Awaited<ReturnType<typeof makeStore>>["store"], creatorId: string, name = "Shelf") {
  const res = await store.createListing(creatorId, {
    name, tagline: "t", voicePersona: "v", coreTraits: [],
    ownerDynamic: "d", backstory: "", greeting: "g", avatarUrl: null,
  });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error("makeListingRow failed");
  return res.listing;
}

test("market:rate opens an ephemeral ★1–5 picker; creators can't self-rate", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const listing = await makeListingRow(store, "u-creator");

    const own = stubButton({ customId: `market:rate:${listing.id}`, userId: "u-creator" });
    await handleMemoryButton(own.interaction, store);
    assert.match(own.replies[0]?.content ?? "", /own listing/i);
    assert.equal(own.replies[0]?.components, undefined, "no picker for the creator");

    const picker = stubButton({ customId: `market:rate:${listing.id}`, userId: "u-rater" });
    await handleMemoryButton(picker.interaction, store);
    assert.equal(picker.replies[0]?.ephemeral, true);
    const ids = JSON.stringify(picker.replies[0]?.components);
    for (const n of [1, 2, 3, 4, 5]) assert.match(ids, new RegExp(`rateval:${listing.id}:${n}`));
  } finally { await sql.end(); }
});

test("market:rateval writes the rating; out-of-range and non-member clicks refused", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const listing = await makeListingRow(store, "u-creator2");

    const rate = stubButton({ customId: `market:rateval:${listing.id}:4`, userId: "u-rater" });
    await handleMemoryButton(rate.interaction, store);
    assert.match(updates_content(rate.updates), /★★★★/);
    assert.deepEqual(await store.listingRatingStats(listing.id), { avg: 4, count: 1 });

    // Forged star value — the picker only emits 1–5 but customIds aren't proof.
    const forged = stubButton({ customId: `market:rateval:${listing.id}:9`, userId: "u-rater2" });
    await handleMemoryButton(forged.interaction, store);
    assert.match(updates_content(forged.updates), /isn't valid/i);
    assert.equal((await store.listingRatingStats(listing.id)).count, 1, "forged rating must not write");

    // House gate: without the Member role the click is refused.
    const saved = { g: config.houseGuildId, r: config.houseMemberRoleId };
    config.houseGuildId = "g1";
    config.houseMemberRoleId = "r-member";
    try {
      const outsider = stubButton({ customId: `market:rate:${listing.id}`, userId: "u-outsider", member: { roles: { cache: { has: () => false } } } });
      await handleMemoryButton(outsider.interaction, store);
      assert.match(outsider.replies[0]?.content ?? "", /Verify your Characterly account/i);

      const member = stubButton({ customId: `market:rate:${listing.id}`, userId: "u-member", member: { roles: { cache: { has: (id: string) => id === "r-member" } } } });
      await handleMemoryButton(member.interaction, store);
      assert.match(member.replies[0]?.content ?? "", /treating you/i, "verified Member gets the picker");

      // Marketplace staff may rate without Member (they may not carry it).
      const mod = stubButton({ customId: `market:rate:${listing.id}`, userId: "u-mod", admin: true, member: { roles: { cache: { has: () => false } } } });
      await handleMemoryButton(mod.interaction, store);
      assert.match(mod.replies[0]?.content ?? "", /treating you/i);
    } finally { config.houseGuildId = saved.g; config.houseMemberRoleId = saved.r; }
  } finally { await sql.end(); }
});

// ── Marketplace: comment reports ─────────────────────────────────────────────

test("market:commentcat files the report and pings mods with quoted content + mod buttons", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const listing = await makeListingRow(store, "u-creator3");
    await store.setListingThread(listing.id, "t-1");

    const modSent: Array<{ content?: string; components?: unknown[]; allowedMentions?: unknown }> = [];
    const target = { author: { id: "u-author" }, content: "@everyone free robux" };
    const channels = {
      "t-1": { isThread: () => true, parentId: "c-forum", messages: { fetch: async () => target } },
      "c-mods": { isTextBased: () => true, send: async (p: (typeof modSent)[number]) => { modSent.push(p); } },
    };
    const saved = { m: config.marketplaceModChannelId, f: config.marketplaceChannelId };
    config.marketplaceModChannelId = "c-mods";
    config.marketplaceChannelId = "c-forum";
    try {
      const ix = stubButton({ customId: `market:commentcat:t-1:m-1:spam`, userId: "u-reporter", channels });
      await handleMemoryButton(ix.interaction, store);
      assert.match(updates_content(ix.updates), /report is with the mods/i);
      assert.equal(modSent.length, 1);
      const ping = modSent[0];
      assert.match(ping.content ?? "", /u-author/);
      assert.match(ping.content ?? "", /https:\/\/discord\.com\/channels\/g1\/t-1\/m-1/);
      assert.match(JSON.stringify(ping.components), /market:modmsg:(keep|del|timeout)/);
      // The quoted comment must not be able to ping — parse is suppressed.
      assert.deepEqual((ping.allowedMentions as { parse: string[] }).parse, []);

      // Same reporter re-filing on the same comment is deduped.
      const again = stubButton({ customId: `market:commentcat:t-1:m-1:hate`, userId: "u-reporter", channels });
      await handleMemoryButton(again.interaction, store);
      assert.match(updates_content(again.updates), /already reported/i);
    } finally { config.marketplaceModChannelId = saved.m; config.marketplaceChannelId = saved.f; }

    const row = await store.commentReportFor("m-1");
    assert.equal(row?.authorUserId, "u-author");
  } finally { await sql.end(); }
});

test("market:commentcat refuses self-reports and sanitizes forged categories", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const listing = await makeListingRow(store, "u-creator4");
    await store.setListingThread(listing.id, "t-2");
    const channels = {
      "t-2": { isThread: () => true, parentId: "c-forum", messages: { fetch: async () => ({ author: { id: "u-me" }, content: "hi" }) } },
    };
    const savedF = config.marketplaceChannelId;
    config.marketplaceChannelId = "c-forum";
    const self = stubButton({ customId: `market:commentcat:t-2:m-2:spam`, userId: "u-me", channels });
    await handleMemoryButton(self.interaction, store);
    assert.match(updates_content(self.updates), /own comment/i);

    // Forged category string — allowlisted down to 'other' before any write.
    const modSent2: Array<{ content?: string }> = [];
    const channels2 = {
      "t-2": { isThread: () => true, parentId: "c-forum", messages: { fetch: async () => ({ author: { id: "u-author2" }, content: "ok" }) } },
      "c-mods": { isTextBased: () => true, send: async (p: { content?: string }) => { modSent2.push(p); } },
    };
    const saved = config.marketplaceModChannelId;
    config.marketplaceModChannelId = "c-mods";
    try {
      const forged = stubButton({ customId: `market:commentcat:t-2:m-3:@everyone`, userId: "u-r", channels: channels2 });
      await handleMemoryButton(forged.interaction, store);
      assert.match(updates_content(forged.updates), /Something else|report is with the mods/i);
      assert.equal(modSent2.length, 1);
      assert.match(modSent2[0].content ?? "", /Something else/);
      assert.doesNotMatch(modSent2[0].content ?? "", /@everyone/);
    } finally { config.marketplaceModChannelId = saved; config.marketplaceChannelId = savedF; }
    const rows = await sql<Array<{ category: string }>>`SELECT category FROM comment_reports WHERE message_id = 'm-3'`;
    assert.equal(rows[0]?.category, "other");
  } finally { await sql.end(); }
});

test("market:commentcat refuses forged channel ids — non-marketplace messages aren't reportable", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const modSent: Array<{ content?: string }> = [];
    const saved = { m: config.marketplaceModChannelId, f: config.marketplaceChannelId };
    config.marketplaceModChannelId = "c-mods";
    config.marketplaceChannelId = "c-forum";
    try {
      // A forged button pointing at a message in a regular channel — the
      // context-menu entry can't produce this, but customIds are forgeable.
      const channels = {
        "c-chat": { isThread: () => false, parentId: null, messages: { fetch: async () => ({ author: { id: "u-victim" }, content: "hi" }) } },
        "t-else": { isThread: () => true, parentId: "c-other-forum", messages: { fetch: async () => ({ author: { id: "u-victim" }, content: "hi" }) } },
        "c-mods": { isTextBased: () => true, send: async (p: { content?: string }) => { modSent.push(p); } },
      };
      const plain = stubButton({ customId: `market:commentcat:c-chat:m-x:spam`, userId: "u-r", channels });
      await handleMemoryButton(plain.interaction, store);
      assert.match(updates_content(plain.updates), /only works inside marketplace/i);
      const wrongParent = stubButton({ customId: `market:commentcat:t-else:m-x:spam`, userId: "u-r", channels });
      await handleMemoryButton(wrongParent.interaction, store);
      assert.match(updates_content(wrongParent.updates), /only works inside marketplace/i);
    } finally { config.marketplaceModChannelId = saved.m; config.marketplaceChannelId = saved.f; }
    assert.equal(modSent.length, 0, "forged reports must never ping mods");
    const rows = await sql`SELECT COUNT(*)::int AS n FROM comment_reports`;
    assert.equal(rows[0].n, 0, "forged reports must never reach the table");
  } finally { await sql.end(); }
});

test("market:modmsg — mod gate, keep/del/timeout actions resolve the report row", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const listing = await makeListingRow(store, "u-creator5");
    await store.setListingThread(listing.id, "t-3");
    await store.reportComment({ listingId: listing.id, threadId: "t-3", messageId: "m-9", authorUserId: "u-real-author", reporterUserId: "u-r" });

    // Non-mod refused.
    const denied = stubButton({ customId: `market:modmsg:keep:t-3:m-9:u-real-author`, userId: "u-rando" });
    await handleMemoryButton(denied.interaction, store);
    assert.match(denied.replies[0]?.content ?? "", /Moderator role/i);

    // Keep dismisses with an audit stamp.
    const keep = stubButton({ customId: `market:modmsg:keep:t-3:m-9:u-real-author`, userId: "u-mod", admin: true, message: { content: "report ping" } });
    await handleMemoryButton(keep.interaction, store);
    assert.match(updates_content(keep.updates), /Comment kept.*u-mod/s);

    // Delete removes the comment through the channel it was reported in.
    let deleted = false;
    const delChannels = { "t-3": { messages: { fetch: async () => ({ delete: async () => { deleted = true; } }) } } };
    const del = stubButton({ customId: `market:modmsg:del:t-3:m-9:u-real-author`, userId: "u-mod", admin: true, message: { content: "report ping" }, channels: delChannels });
    await handleMemoryButton(del.interaction, store);
    assert.equal(deleted, true);
    assert.match(updates_content(del.updates), /deleted/i);

    // Timeout resolves the author from the report row — a forged authorId in
    // the customId ("u-fake") must not be trusted over the stored row.
    const edits: Array<{ userId: string; data: unknown }> = [];
    const timeout = stubButton({
      customId: `market:modmsg:timeout:t-3:m-9:u-fake`, userId: "u-mod", admin: true,
      message: { content: "report ping" },
      onMemberEdit: async (userId: string, data: unknown) => { edits.push({ userId, data }); return {}; },
    });
    await handleMemoryButton(timeout.interaction, store);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].userId, "u-real-author", "author resolved from comment_reports, not the button");
    assert.ok(String((edits[0].data as { communicationDisabledUntil?: string }).communicationDisabledUntil ?? "").length > 0);
    assert.match(updates_content(timeout.updates), /timed out/i);
  } finally { await sql.end(); }
});

// ── Marketplace: adoption link gate ─────────────────────────────────────────

// Hosted lane needs web_profiles — stand it up like credits.test.ts does.
async function webProfilesFixture(sql: ReturnType<typeof makeTestSql>) {
  await sql`
    CREATE TABLE IF NOT EXISTS web_profiles (
      id UUID PRIMARY KEY, display_name TEXT, discord_user_id TEXT UNIQUE,
      discord_username TEXT, discord_avatar_url TEXT,
      plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','premium')),
      credit_balance INT NOT NULL DEFAULT 0,
      last_daily_grant_on DATE, last_weekly_grant_on DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

test("market:add refuses unlinked users ephemerally — verify pointer, no adoption", async () => {
  const sql = makeTestSql();
  try {
    await webProfilesFixture(sql);
    const { store } = await makeStore(sql);
    assert.equal(await store.initCreditsSupport(), true);
    const listing = await makeListingRow(store, "u-creator-gate");
    const saved = config.houseVerifyChannelId;
    config.houseVerifyChannelId = "c-login";
    try {
      const ix = stubButton({ customId: `market:add:${listing.id}`, userId: "u-windowshopper" });
      await handleMemoryButton(ix.interaction, store);
      assert.equal(ix.replies[0]?.ephemeral, true);
      assert.match(ix.replies[0]?.content ?? "", /log in/i);
      assert.match(ix.replies[0]?.content ?? "", /<#c-login>/, "points at the verify channel");
      assert.equal((await store.listCompanionsForUser("u-windowshopper")).length, 0, "no adoption must be written");
    } finally { config.houseVerifyChannelId = saved; }
  } finally { await sql.end(); }
});

test("market:add — linked and BYOK-unlinked users adopt; a lookup error says retry", async () => {
  const sql = makeTestSql();
  try {
    await webProfilesFixture(sql);
    const { store } = await makeStore(sql);
    assert.equal(await store.initCreditsSupport(), true);
    const listing = await makeListingRow(store, "u-creator-gate2");

    // Linked account → the adoption lands.
    await sql`INSERT INTO web_profiles (id, discord_user_id, plan) VALUES (gen_random_uuid(), 'u-linked-adopter', 'free')`;
    const linked = stubButton({ customId: `market:add:${listing.id}`, userId: "u-linked-adopter" });
    await handleMemoryButton(linked.interaction, store);
    assert.match(linked.replies[0]?.content ?? "", /has joined your companions/);
    assert.equal((await store.listCompanionsForUser("u-linked-adopter")).length, 1);

    // Unlinked but carrying a personal key — the DM gate's own lane.
    const listing2 = await makeListingRow(store, "u-creator-gate3", "Shelf2");
    await store.upsertGuildKey("dm:u-byok", { keyEnc: Buffer.from("k"), keyHint: "hint", baseUrl: null, validatedAt: null });
    const byok = stubButton({ customId: `market:add:${listing2.id}`, userId: "u-byok" });
    await handleMemoryButton(byok.interaction, store);
    assert.match(byok.replies[0]?.content ?? "", /has joined your companions/, "BYOK covers chat unlinked");

    // A lookup THROW is unknown, not unlinked — never the signup pointer.
    const orig = store.accountForDiscordUser.bind(store);
    store.accountForDiscordUser = async () => { throw new Error("db is down"); };
    try {
      const flaky = stubButton({ customId: `market:add:${listing.id}`, userId: "u-flaky" });
      await handleMemoryButton(flaky.interaction, store);
      assert.match(flaky.replies[0]?.content ?? "", /try again/i);
      assert.doesNotMatch(flaky.replies[0]?.content ?? "", /linked Characterly account/);
      assert.equal((await store.listCompanionsForUser("u-flaky")).length, 0);
    } finally { store.accountForDiscordUser = orig; }
  } finally { await sql.end(); }
});

test("market:add — house members need Member to adopt; Administrator bypasses", async () => {
  const sql = makeTestSql();
  try {
    await webProfilesFixture(sql);
    const { store } = await makeStore(sql);
    assert.equal(await store.initCreditsSupport(), true);
    const listing = await makeListingRow(store, "u-creator-gate4");
    // Link the clicker so the account gate passes and the Member gate decides.
    await sql`INSERT INTO web_profiles (id, discord_user_id, plan) VALUES (gen_random_uuid(), 'u-linked-2', 'free')`;
    await sql`INSERT INTO web_profiles (id, discord_user_id, plan) VALUES (gen_random_uuid(), 'u-owner', 'premium')`;

    const saved = { g: config.houseGuildId, r: config.houseMemberRoleId, v: config.houseVerifyChannelId };
    config.houseGuildId = "g1"; // stubButton's default guild
    config.houseMemberRoleId = "r-member";
    config.houseVerifyChannelId = "c-verify";
    try {
      // Unverified member → refused before the adoption lands.
      const outsider = stubButton({ customId: `market:add:${listing.id}`, userId: "u-linked-2",
        member: { roles: { cache: { has: () => false } }, permissions: { has: () => false } } });
      await handleMemoryButton(outsider.interaction, store);
      assert.match(outsider.replies[0]?.content ?? "", /log in/i);
      assert.match(outsider.replies[0]?.content ?? "", /<#c-verify>/);
      assert.equal((await store.listCompanionsForUser("u-linked-2")).length, 0, "no adoption while unverified");

      // Member → adoption lands.
      const member = stubButton({ customId: `market:add:${listing.id}`, userId: "u-linked-2",
        member: { roles: { cache: { has: (id: string) => id === "r-member" } }, permissions: { has: () => false } } });
      await handleMemoryButton(member.interaction, store);
      assert.match(member.replies[0]?.content ?? "", /has joined your companions/);
      assert.equal((await store.listCompanionsForUser("u-linked-2")).length, 1);

      // Administrator bypass — the owner never holds Member.
      const listing2 = await makeListingRow(store, "u-creator-gate5", "Shelf3");
      const admin = stubButton({ customId: `market:add:${listing2.id}`, userId: "u-owner", admin: true,
        member: { roles: { cache: { has: () => false } } } });
      await handleMemoryButton(admin.interaction, store);
      assert.match(admin.replies[0]?.content ?? "", /has joined your companions/);
    } finally { config.houseGuildId = saved.g; config.houseMemberRoleId = saved.r; config.houseVerifyChannelId = saved.v; }
  } finally { await sql.end(); }
});

// ── "Report message" context command ─────────────────────────────────────────

// The report path never touches the store — the dispatcher only needs it for
// Staff pick, which these tests stub separately.
const nullCtxStore = { listingByThreadId: async () => null } as unknown as MemoryStore;

function stubCtxMenu(opts: {
  userId?: string; guildId?: string; admin?: boolean; commandName?: string; channels?: Record<string, unknown>;
  target: { id: string; author: { id: string; bot?: boolean }; channel: { id: string; parentId?: string | null; isThread?: () => boolean; appliedTags?: string[]; setAppliedTags?: (t: string[]) => Promise<unknown> }; content?: string };
}): { interaction: MessageContextMenuCommandInteraction; replies: Replies } {
  const replies: Replies = [];
  const channel = { isThread: () => true, ...opts.target.channel };
  const interaction = {
    guildId: opts.guildId ?? "g1",
    user: { id: opts.userId ?? "u-user" },
    commandName: opts.commandName ?? "Report message",
    memberPermissions: { has: () => !!opts.admin },
    member: { roles: { cache: { has: () => false } } },
    client: { channels: { fetch: async (id: string) => opts.channels?.[id] ?? null } },
    targetMessage: { id: opts.target.id, author: opts.target.author, content: opts.target.content ?? "hi", channel },
    channel,
    reply: async (r: (typeof replies)[number]) => { replies.push(r); return r; },
  };
  return { interaction: interaction as unknown as MessageContextMenuCommandInteraction, replies };
}

test("Report message: only marketplace-thread comments are reportable", async () => {
  const saved = { g: config.houseGuildId, f: config.marketplaceChannelId };
  config.houseGuildId = "g1";
  config.marketplaceChannelId = "c-forum";
  try {
    // Outside the house guild entirely.
    const foreign = stubCtxMenu({ guildId: "g-other", target: { id: "m1", author: { id: "u-a" }, channel: { id: "t-x", parentId: "c-forum" } } });
    await handleMarketplaceContext(foreign.interaction, nullCtxStore);
    assert.match(foreign.replies[0]?.content ?? "", /only works on comments inside marketplace/i);

    // A regular (non-thread, or other-parent) channel in the house.
    const channelMsg = stubCtxMenu({ target: { id: "m1", author: { id: "u-a" }, channel: { id: "c-chat", parentId: null, isThread: () => false } } });
    await handleMarketplaceContext(channelMsg.interaction, nullCtxStore);
    assert.match(channelMsg.replies[0]?.content ?? "", /only works/i);

    // A thread in some other forum.
    const otherThread = stubCtxMenu({ target: { id: "m1", author: { id: "u-a" }, channel: { id: "t-y", parentId: "c-elsewhere" } } });
    await handleMarketplaceContext(otherThread.interaction, nullCtxStore);
    assert.match(otherThread.replies[0]?.content ?? "", /only works/i);

    // Own comment + bot messages refused.
    const self = stubCtxMenu({ userId: "u-a", target: { id: "m1", author: { id: "u-a" }, channel: { id: "t-1", parentId: "c-forum" } } });
    await handleMarketplaceContext(self.interaction, nullCtxStore);
    assert.match(self.replies[0]?.content ?? "", /own comment/i);
    const bot = stubCtxMenu({ target: { id: "m1", author: { id: "b-1", bot: true }, channel: { id: "t-1", parentId: "c-forum" } } });
    await handleMarketplaceContext(bot.interaction, nullCtxStore);
    assert.match(bot.replies[0]?.content ?? "", /system message/i);

    // A real comment in a listing thread → ephemeral category picker carrying
    // the thread + message ids forward to market:commentcat.
    const ok = stubCtxMenu({ target: { id: "m-77", author: { id: "u-author" }, channel: { id: "t-1", parentId: "c-forum" } } });
    await handleMarketplaceContext(ok.interaction, nullCtxStore);
    assert.equal(ok.replies[0]?.ephemeral, true);
    assert.match(JSON.stringify(ok.replies[0]?.components), /market:commentcat:t-1:m-77:/);
  } finally { config.houseGuildId = saved.g; config.marketplaceChannelId = saved.f; }
});

// ── Marketplace listing tags ─────────────────────────────────────────────────

const FORUM_TAGS = [
  { id: "tag-new", name: "New", moderated: true },
  { id: "tag-top", name: "Top Rated", moderated: true },
  { id: "tag-staff", name: "Staff Pick", moderated: true },
  { id: "tag-genre", name: "Slice of Life" },
  { id: "tag-genre2", name: "Horror" },
];

function fakeForum(threads: Record<string, unknown> = {}) {
  return {
    type: ChannelType.GuildForum,
    availableTags: FORUM_TAGS,
    threads: { fetch: async (id: string) => threads[id] ?? null },
  };
}

function fakeTagThread(id: string, appliedTags: string[] = []) {
  const calls: string[][] = [];
  return { id, appliedTags: [...appliedTags], calls, setAppliedTags: async (tags: string[]) => { calls.push(tags); } };
}

test("market:tags — creator gets the picker; non-creator refused; only non-moderated tags offered", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const res = await store.createListing("u-creator", {
      name: "TagMe", tagline: "t", voicePersona: "v", coreTraits: [],
      ownerDynamic: "d", backstory: "", greeting: "g", avatarUrl: null,
    });
    assert.ok(res.ok);
    const listing = res.listing;

    const stranger = stubButton({ customId: `market:tags:${listing.id}`, userId: "u-nope" });
    await handleMemoryButton(stranger.interaction, store);
    assert.match(stranger.replies[0]?.content ?? "", /not your listing/i);

    const saved = config.marketplaceChannelId;
    config.marketplaceChannelId = "c-forum";
    try {
      const creator = stubButton({ customId: `market:tags:${listing.id}`, userId: "u-creator", channels: { "c-forum": fakeForum() } });
      await handleMemoryButton(creator.interaction, store);
      const row = JSON.stringify(creator.replies[0]?.components);
      assert.match(row, /market:tagsel:/);
      assert.match(row, /Slice of Life/);
      assert.match(row, /Horror/);
      assert.doesNotMatch(row, /Staff Pick|tag-new|tag-top|tag-staff/, "moderated curated tags are never offered to creators");
    } finally { config.marketplaceChannelId = saved; }
  } finally { await sql.end(); }
});

test("market:tagsel — forged ids dropped, curated badges preserved, non-owner refused", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const res = await store.createListing("u-creator", {
      name: "TagMe", tagline: "t", voicePersona: "v", coreTraits: [],
      ownerDynamic: "d", backstory: "", greeting: "g", avatarUrl: null,
    });
    assert.ok(res.ok);
    const listing = res.listing;
    await store.setListingThread(listing.id, "t-1");

    const saved = config.marketplaceChannelId;
    config.marketplaceChannelId = "c-forum";
    try {
      const thread = fakeTagThread("t-1", ["tag-new", "tag-genre2"]);
      const updates: Replies = [];
      const interaction = {
        customId: `market:tagsel:${listing.id}`,
        user: { id: "u-creator" },
        // tag-forged isn't on the forum; tag-new is moderated — both must be
        // rejected as creator picks. genre2 was the previous pick and is
        // replaced by the new selection.
        values: ["tag-genre", "tag-forged", "tag-new"],
        client: { channels: { fetch: async () => fakeForum({ "t-1": thread }) } },
        update: async (r: (typeof updates)[number]) => { updates.push(r); return r; },
      };
      await handleMarketSelect(interaction as unknown as StringSelectMenuInteraction, store);
      assert.deepEqual(thread.calls[0], ["tag-new", "tag-genre"], "moderated badge kept + only the valid pick applied");
      assert.match(updates[0]?.content ?? "", /Slice of Life/);

      // Non-owner re-tag refused — no write.
      const thread2 = fakeTagThread("t-1", ["tag-new"]);
      const denied: Replies = [];
      await handleMarketSelect({
        customId: `market:tagsel:${listing.id}`,
        user: { id: "u-nope" },
        values: ["tag-genre"],
        client: { channels: { fetch: async () => fakeForum({ "t-1": thread2 }) } },
        update: async (r: (typeof denied)[number]) => { denied.push(r); return r; },
      } as unknown as StringSelectMenuInteraction, store);
      assert.equal(thread2.calls.length, 0);
      assert.match(denied[0]?.content ?? "", /not your listing/i);
    } finally { config.marketplaceChannelId = saved; }
  } finally { await sql.end(); }
});

test("Staff pick — mod toggles the badge on/off; non-mod and non-marketplace refused", async () => {
  const saved = { g: config.houseGuildId, f: config.marketplaceChannelId };
  config.houseGuildId = "g1";
  config.marketplaceChannelId = "c-forum";
  try {
    const sql = makeTestSql();
    try {
      const { store } = await makeStore(sql);
      const res = await store.createListing("u-creator", {
        name: "Picked", tagline: "t", voicePersona: "v", coreTraits: [],
        ownerDynamic: "d", backstory: "", greeting: "g", avatarUrl: null,
      });
      assert.ok(res.ok);
      await store.setListingThread(res.listing.id, "t-1");

      // Non-mod refused.
      const noMod = stubCtxMenu({
        commandName: "Staff pick",
        target: { id: "m1", author: { id: "u-a" }, channel: { id: "t-1", parentId: "c-forum" } },
      });
      await handleMarketplaceContext(noMod.interaction, store);
      assert.match(noMod.replies[0]?.content ?? "", /Moderator role required/i);

      // Outside the forum entirely — even an admin is refused.
      const foreign = stubCtxMenu({
        commandName: "Staff pick", admin: true,
        target: { id: "m1", author: { id: "u-a" }, channel: { id: "c-chat", parentId: null, isThread: () => false } },
      });
      await handleMarketplaceContext(foreign.interaction, store);
      assert.match(foreign.replies[0]?.content ?? "", /only works inside marketplace/i);

      // Mod applies the badge.
      const on = fakeTagThread("t-1", []);
      const mod = stubCtxMenu({
        commandName: "Staff pick", admin: true,
        channels: { "c-forum": fakeForum() },
        target: { id: "m1", author: { id: "u-a" }, channel: { id: "t-1", parentId: "c-forum", appliedTags: on.appliedTags, setAppliedTags: on.setAppliedTags } },
      });
      await handleMarketplaceContext(mod.interaction, store);
      assert.deepEqual(on.calls[0], ["tag-staff"]);
      assert.match(mod.replies[0]?.content ?? "", /Staff Pick/i);

      // Second thread already carrying it — toggles off.
      const off = fakeTagThread("t-1", ["tag-staff", "tag-genre"]);
      const mod2 = stubCtxMenu({
        commandName: "Staff pick", admin: true,
        channels: { "c-forum": fakeForum() },
        target: { id: "m1", author: { id: "u-a" }, channel: { id: "t-1", parentId: "c-forum", appliedTags: off.appliedTags, setAppliedTags: off.setAppliedTags } },
      });
      await handleMarketplaceContext(mod2.interaction, store);
      assert.deepEqual(off.calls[0], ["tag-genre"]);
      assert.match(mod2.replies[0]?.content ?? "", /Removed/i);
    } finally { await sql.end(); }
  } finally { config.houseGuildId = saved.g; config.marketplaceChannelId = saved.f; }
});

// ── Marketplace: cover image ─────────────────────────────────────────────────

function stubCoverSubmit(opts: { listingId: number; userId: string; coverUrl?: string; edits?: unknown[] }) {
  const replies: Replies = [];
  const edits = opts.edits ?? [];
  const starter = { edit: async (p: unknown) => { edits.push(p); return p; } };
  const thread = { fetchStarterMessage: async () => starter };
  const forum = { type: ChannelType.GuildForum, threads: { fetch: async () => thread } };
  const interaction = {
    customId: `market_cover:${opts.listingId}`,
    user: { id: opts.userId, username: "C" },
    fields: { getTextInputValue: () => opts.coverUrl ?? "" },
    client: {
      channels: { fetch: async () => forum },
      users: { fetch: async () => ({ globalName: "The Creator", username: "C" }) },
    },
    reply: async (r: (typeof replies)[number]) => { replies.push(r); return r; },
  };
  return { interaction: interaction as unknown as ModalSubmitInteraction, replies, edits };
}

test("market:cover button — creator gets the modal, others and banned creators don't", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const listing = await makeListingRow(store, "u-cover");

    const stranger = stubButton({ customId: `market:cover:${listing.id}`, userId: "u-rando" });
    await handleMemoryButton(stranger.interaction, store);
    assert.match(stranger.replies[0]?.content ?? "", /not your listing/i);

    await store.banCreator("u-cover", "u-mod");
    const banned = stubButton({ customId: `market:cover:${listing.id}`, userId: "u-cover" });
    await handleMemoryButton(banned.interaction, store);
    assert.match(banned.replies[0]?.content ?? "", /suspended|banned|removed/i);
    await sql`DELETE FROM marketplace_bans`;

    const own = stubButton({ customId: `market:cover:${listing.id}`, userId: "u-cover" });
    await handleMemoryButton(own.interaction, store);
    assert.equal(own.replies[0]?.content, `modal:market_cover:${listing.id}`);
  } finally { await sql.end(); }
});

test("market_cover submit — sets the cover and re-renders the OP card in place", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const listing = await makeListingRow(store, "u-cover2");
    await store.setListingThread(listing.id, "t-99");

    // refreshListingCard no-ops without a configured marketplace forum.
    const savedF = config.marketplaceChannelId;
    config.marketplaceChannelId = "c-forum";
    try {
      const { interaction, replies, edits } = stubCoverSubmit({
        listingId: listing.id, userId: "u-cover2", coverUrl: "https://example.com/art.png",
      });
      await handleCompanionModal(interaction, store);
      assert.match(replies[0]?.content ?? "", /Cover updated/i);
      assert.equal((await store.listingById(listing.id))!.avatarUrl, "https://example.com/art.png");
      assert.equal(edits.length, 1, "starter message must be edited in place — not reposted");
      const embed = (edits[0] as { embeds: { data: { image?: { url?: string } } }[] }).embeds[0];
      assert.equal(embed.data.image?.url, "https://example.com/art.png");
    } finally { config.marketplaceChannelId = savedF; }
  } finally { await sql.end(); }
});

test("market_cover submit — rejects private/forged URLs and non-owners; blank clears", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const listing = await makeListingRow(store, "u-cover3");

    const stranger = stubCoverSubmit({ listingId: listing.id, userId: "u-other", coverUrl: "https://example.com/x.png" });
    await handleCompanionModal(stranger.interaction, store);
    assert.match(stranger.replies[0]?.content ?? "", /not your listing/i);

    const bad = stubCoverSubmit({ listingId: listing.id, userId: "u-cover3", coverUrl: "http://169.254.169.254/latest" });
    await handleCompanionModal(bad.interaction, store);
    assert.match(bad.replies[0]?.content ?? "", /valid public/i);
    assert.equal((await store.listingById(listing.id))!.avatarUrl, null, "rejected URL must not persist");

    await store.updateListing(listing.id, "u-cover3", {
      name: listing.name, tagline: listing.tagline, voicePersona: listing.voicePersona,
      coreTraits: listing.coreTraits, ownerDynamic: listing.ownerDynamic,
      backstory: listing.backstory, greeting: listing.greeting, avatarUrl: "https://example.com/old.png",
    });
    const clear = stubCoverSubmit({ listingId: listing.id, userId: "u-cover3", coverUrl: "" });
    await handleCompanionModal(clear.interaction, store);
    assert.match(clear.replies[0]?.content ?? "", /Cover removed/i);
    assert.equal((await store.listingById(listing.id))!.avatarUrl, null);
  } finally { await sql.end(); }
});

test("cover modals — buildCoverModal prefills; buildPublishModal exposes the field", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    const res = await store.createListing("u-cover4", {
      name: "Arted", tagline: "t", voicePersona: "v", coreTraits: [],
      ownerDynamic: "d", backstory: "", greeting: "g", avatarUrl: "https://example.com/cur.png",
    });
    if (!res.ok) throw new Error("listing failed");
    const modal = buildCoverModal(res.listing).toJSON();
    assert.equal(modal.custom_id, `market_cover:${res.listing.id}`);
    assert.equal((modal.components[0] as any).components[0].custom_id, "cover-url");
    assert.equal((modal.components[0] as any).components[0].value, "https://example.com/cur.png");

    const companion = await store.activateCompanion("u-cover4", "Owner", {
      name: "Nyx", voicePersona: "dry", coreTraits: [], ownerDynamic: "d",
      backstory: "", avatarUrl: "https://example.com/comp.png",
    });
    const pub = buildPublishModal(companion, null).toJSON();
    const fieldIds = pub.components.map((r: any) => r.components[0].custom_id);
    assert.ok(fieldIds.includes("listing-cover"), "publish modal must expose a cover field");
    const coverRow = pub.components.find((r: any) => r.components[0].custom_id === "listing-cover") as any;
    assert.equal(coverRow.components[0].value, "https://example.com/comp.png", "prefills the companion avatar");
    assert.equal(coverRow.components[0].required, false);
  } finally { await sql.end(); }
});

test("/companion action:avatar — file upload wins over URL path, both-refused, non-image refused", async () => {
  const sql = makeTestSql();
  try {
    const { store } = await makeStore(sql);
    await store.activateCompanion("u-av", "Owner", {
      name: "Nyx", voicePersona: "dry", coreTraits: [], ownerDynamic: "d",
      backstory: "", avatarUrl: null,
    });

    const both = stubCommand({
      commandName: "companion", userId: "u-av",
      options: { action: "avatar", avatar_url: "https://example.com/a.png", avatar_file: { url: "https://cdn.discordapp.com/x.png", contentType: "image/png" } },
    });
    await handleMemoryCommand(both.interaction, store, brainFor);
    assert.match(both.replies[0]?.content ?? "", /Pick one/i);

    const notImg = stubCommand({
      commandName: "companion", userId: "u-av",
      options: { action: "avatar", avatar_file: { url: "https://cdn.discordapp.com/x.pdf", contentType: "application/pdf" } },
    });
    await handleMemoryCommand(notImg.interaction, store, brainFor);
    assert.match(notImg.replies[0]?.content ?? "", /image upload/i);

    const file = stubCommand({
      commandName: "companion", userId: "u-av",
      options: { action: "avatar", avatar_file: { url: "https://cdn.discordapp.com/attachments/1/art.png", contentType: "image/png" } },
    });
    await handleMemoryCommand(file.interaction, store, brainFor);
    assert.match(file.replies[0]?.content ?? "", /avatar/i);
    assert.equal((await store.getCompanionByOwner("u-av"))!.avatarUrl, "https://cdn.discordapp.com/attachments/1/art.png");

    const neither = stubCommand({ commandName: "companion", userId: "u-av", options: { action: "avatar" } });
    await handleMemoryCommand(neither.interaction, store, brainFor);
    assert.match(neither.replies[0]?.content ?? "", /avatar_url|avatar_file/);
  } finally { await sql.end(); }
});

test("/companion homes — subcommand path; each adopted companion gets its Drop button", async () => {
  const store = {
    listCompanionsForUser: async () => [
      { id: 1, name: "Sage", kind: "awakened", onboardingState: "active" },
      { id: 2, name: "Wren", kind: "adopted", onboardingState: "active" },
      { id: 3, name: "Beans", kind: "adopted", onboardingState: "active" },
    ],
    adoptionForCompanion: async (id: number) => ({ chatThreadId: `t-${id}` }),
  } as unknown as MemoryStore;

  // New-style invocation — the subcommand name resolves the action even
  // when a stale client still echoes the old action string.
  const sub = stubCommand({ commandName: "companion", subcommand: "homes", options: { action: "summon" } });
  await handleMemoryCommand(sub.interaction, store, brainFor);
  const reply = sub.replies[0];
  assert.match(reply?.content ?? "", /Where your companions live/);
  const rowJson = JSON.stringify(reply?.components ?? []);
  assert.ok(rowJson.includes("market:drop:2"), "Wren gets a Drop button");
  assert.ok(rowJson.includes("market:drop:3"), "Beans gets a Drop button");
  // The awakened bond is permanent — no Drop affordance for it.
  assert.ok(!rowJson.includes("market:drop:1"));

  // Legacy invocation — action: "switch" still lands on the homes roster.
  const legacy = stubCommand({ commandName: "companion", options: { action: "switch" } });
  await handleMemoryCommand(legacy.interaction, store, brainFor);
  assert.match(legacy.replies[0]?.content ?? "", /Where your companions live/);
});

test("/companion tokens — balance, refill amount, relative reset timestamp", async () => {
  const store = {
    creditsSupported: true,
    accountForDiscordUser: async () => ({ creditBalance: 28, plan: "free" }),
    getGuildKey: async () => null,
  } as unknown as MemoryStore;

  const cmd = stubCommand({ commandName: "companion", subcommand: "tokens" });
  await handleMemoryCommand(cmd.interaction, store, brainFor);
  const reply = cmd.replies[0]?.content ?? "";
  assert.match(reply, /\*\*28 tokens\*\*/, "balance shows");
  assert.match(reply, /refills to \*\*30\*\*/, "free-plan refill amount");
  assert.match(reply, /<t:\d+:R>/, "relative reset timestamp renders");
  assert.equal(cmd.replies[0]?.ephemeral, true, "token counts stay private");

  // BYOK connected — the reply notes chats don't spend tokens anyway.
  const byokStore = {
    ...store,
    getGuildKey: async () => ({ keyHint: "…abc" }),
  } as unknown as MemoryStore;
  const cmd2 = stubCommand({ commandName: "companion", subcommand: "tokens" });
  await handleMemoryCommand(cmd2.interaction, byokStore, brainFor);
  assert.match(cmd2.replies[0]?.content ?? "", /chats don't spend tokens/);

  // Premium shows the 150 refill.
  const premStore = { ...store, accountForDiscordUser: async () => ({ creditBalance: 150, plan: "premium" }) } as unknown as MemoryStore;
  const cmd3 = stubCommand({ commandName: "companion", subcommand: "tokens" });
  await handleMemoryCommand(cmd3.interaction, premStore, brainFor);
  assert.match(cmd3.replies[0]?.content ?? "", /refills to \*\*150\*\*/);

  // Unlinked — signup pointer, no balance claim.
  const unlinked = { ...store, accountForDiscordUser: async () => null } as unknown as MemoryStore;
  const cmd4 = stubCommand({ commandName: "companion", subcommand: "tokens" });
  await handleMemoryCommand(cmd4.interaction, unlinked, brainFor);
  assert.match(cmd4.replies[0]?.content ?? "", /No hosted account yet/);
});

test("market:drop is two-click — confirm drops, cancel restores the row, stale confirm refuses", async () => {
  const adopted = { id: 2, name: "Wren", kind: "adopted", onboardingState: "active" };
  let drops = 0;
  const store = {
    listCompanionsForUser: async () => [adopted],
    dropAdoption: async () => {
      drops++;
      return { chatThreadId: null, cooldownUntil: new Date(Date.now() + 43200000).toISOString() };
    },
  } as unknown as MemoryStore;

  // Click 1 — confirm prompt renders, nothing dropped.
  const open = stubButton({ customId: "market:drop:2", userId: "u-1" });
  await handleMemoryButton(open.interaction, store, brainFor);
  assert.equal(drops, 0);
  assert.match(open.updates[0]?.content ?? "", /Really drop \*\*Wren\*\*/);
  const confirmJson = JSON.stringify(open.updates[0]?.components ?? []);
  assert.ok(confirmJson.includes("market:dropconfirm:2:"), "confirm carries the timestamp");
  assert.ok(confirmJson.includes("market:dropcancel:2"), "cancel offered");

  // Cancel — the manage row comes back, still nothing dropped.
  const cancel = stubButton({ customId: "market:dropcancel:2", userId: "u-1" });
  await handleMemoryButton(cancel.interaction, store, brainFor);
  assert.equal(drops, 0);
  assert.ok(JSON.stringify(cancel.updates[0]?.components ?? []).includes("market:drop:2"), "drop row restored");

  // Stale confirm (>10m) — refuses and restores the row.
  const stale = stubButton({ customId: `market:dropconfirm:2:${Date.now() - 11 * 60 * 1000}`, userId: "u-1" });
  await handleMemoryButton(stale.interaction, store, brainFor);
  assert.equal(drops, 0);
  assert.match(stale.updates[0]?.content ?? "", /expired/i);

  // Fresh confirm — actually drops.
  const ok = stubButton({ customId: `market:dropconfirm:2:${Date.now()}`, userId: "u-1" });
  await handleMemoryButton(ok.interaction, store, brainFor);
  assert.equal(drops, 1);
  assert.match(ok.updates[0]?.content ?? "", /Dropped — you can't re-adopt/);
});
