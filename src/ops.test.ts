import { test, beforeEach } from "node:test";
import assert from "node:assert";
import {
  isHouse, isMarketplaceThread, isAdopteeThread, automodMessage, handleHouseMemberAdd, handleHouseMemberUpdate,
  handleHouseMemberRemove, ensureHouseLayout, collectHostHealth,
  runWatchdogTick, handleOpsCommand, initOps, resetOpsState, WANTED_LAYOUT,
  ensureVerifyGate, handleHouseButton, runMemberLinkSweep, runTagSweep, ensureResourcePosts,
  ensureTicketPanel, handleTicketButton, handleTicketModal,
  ensureAdopteeThread, setAdopteeThreadLocked, backfillAdopteeThreads,
  TERMS_VERSION, RESOURCE_POSTS,
  type OpsDeps, type AutomodMessage, type MemberLike,
} from "./ops.js";
import { PermissionFlagsBits } from "discord.js";
import { config } from "./config.js";
import { SEED_LISTINGS } from "./seed-personas.js";
import type { MemoryStore } from "./database.js";

// Config is a plain object — tests pin house/ops ids and restore on exit.
const prev = {
  houseGuildId: config.houseGuildId, opsChannelId: config.opsChannelId,
  opsUserIds: config.opsUserIds, houseMemberRoleId: config.houseMemberRoleId,
  houseWelcomeChannelId: config.houseWelcomeChannelId, houseRulesChannelId: config.houseRulesChannelId,
  houseAnnounceChannelId: config.houseAnnounceChannelId, automodRaidJoins: config.automodRaidJoins,
  houseVerifyChannelId: config.houseVerifyChannelId,
  automodRaidKick: config.automodRaidKick, automodBurstCount: config.automodBurstCount,
  automodMentionMax: config.automodMentionMax, automodNewAccountDays: config.automodNewAccountDays,
  hostHeapPct: config.hostHeapPct, hostDiskPct: config.hostDiskPct, hostLagMs: config.hostLagMs,
  opsRepoDir: config.opsRepoDir, marketplaceChannelId: config.marketplaceChannelId,
  houseAdopteesChannelId: config.houseAdopteesChannelId,
};

const HOUSE = "g-house";
const OPS = "c-ops";

beforeEach(() => {
  resetOpsState();
  config.houseGuildId = HOUSE;
  config.opsChannelId = OPS;
  config.opsUserIds = ["u-op"];
  config.houseMemberRoleId = "r-member";
  config.houseWelcomeChannelId = "c-welcome";
  config.houseRulesChannelId = "c-rules";
  config.houseAnnounceChannelId = "c-announce";
  config.houseVerifyChannelId = "c-verify";
  config.automodRaidJoins = 3;
  config.automodRaidKick = false;
  config.automodBurstCount = 4;
  config.automodMentionMax = 8;
  config.automodNewAccountDays = 7;
  config.hostHeapPct = 90;
  config.hostDiskPct = 85;
  config.hostLagMs = 1000;
  config.opsRepoDir = "~/characterly";
  config.marketplaceChannelId = "c-forum";
  config.houseAdopteesChannelId = "c-adoptees";
});

process.on("exit", () => Object.assign(config, prev));

// ── Fakes ────────────────────────────────────────────────────────────────────

function makeDeps(over: Partial<OpsDeps> = {}): OpsDeps & { sent: Array<{ id: string; payload: any }> } {
  const sent: Array<{ id: string; payload: any }> = [];
  const deps: OpsDeps & { sent: typeof sent } = {
    sent,
    store: {
      queueStats: async () => ({ pending: 2, dead: 1, oldestPendingAt: null }),
      creditsSupported: true,
      accountForDiscordUser: async () => null,
      getGuildKey: async () => null,
      tosAcceptance: async () => null,
      recordTosAcceptance: async () => {},
    } as unknown as MemoryStore,
    fetchChannel: async id => ({ send: async (p: unknown) => { sent.push({ id, payload: p }); } }),
    fetchGuild: async () => null,
    fetchMember: async () => null,
    listMembers: async () => [],
    botId: "bot-1",
    exec: async () => ({ stdout: "", stderr: "" }),
    exit: () => {},
    dbPing: async () => 4,
    lagMs: () => 5,
    gitSha: "abc1234",
    ...over,
  };
  return deps;
}

const makeMember = (over: Partial<MemberLike> & { id?: string; hasRole?: boolean } = {}): MemberLike & { added: string[]; removed: string[]; kicked: string[] } => {
  const added: string[] = [];
  const removed: string[] = [];
  const kicked: string[] = [];
  const roleSet = new Set<string>(over.hasRole ? ["r-member"] : []);
  const { hasRole, ...rest } = over;
  return {
    added, removed, kicked,
    pending: false,
    user: { id: over.id ?? "u1", bot: false, username: "Joiner", createdTimestamp: Date.now() - 90 * 86_400_000 },
    guild: { id: HOUSE },
    roles: {
      add: async (id: string) => { added.push(id); roleSet.add(id); },
      remove: async (id: string) => { removed.push(id); roleSet.delete(id); },
      cache: { has: (id: string) => roleSet.has(id) },
    },
    kick: async (r?: string) => { kicked.push(r ?? ""); },
    ...rest,
  };
};

const makeMsg = (over: Partial<AutomodMessage> & { content?: string } = {}): AutomodMessage & { deleted: boolean; timeouts: number[] } => {
  const state = { deleted: false, timeouts: [] as number[] };
  return {
    ...state,
    get deleted() { return state.deleted; },
    get timeouts() { return state.timeouts; },
    id: "m1",
    guildId: HOUSE,
    channelId: "c1",
    content: "hello world",
    url: "https://discord.com/channels/g/c/m1",
    author: { id: "u1", bot: false, username: "User", createdTimestamp: Date.now() - 90 * 86_400_000 },
    member: {
      permissions: { has: () => false },
      timeout: async (ms: number) => { state.timeouts.push(ms); },
    },
    mentions: { users: { size: 0 }, everyone: false },
    delete: async () => { state.deleted = true; },
    ...over,
  };
};

const opsAlertText = (deps: ReturnType<typeof makeDeps>) =>
  deps.sent.filter(s => s.id === OPS).map(s => s.payload.content).join("\n");

// ── Member ops ───────────────────────────────────────────────────────────────

test("house member add: posts welcome pointing at rules+verify; no auto-role; non-house and bots skipped", async () => {
  const deps = makeDeps();
  const m = makeMember();
  await handleHouseMemberAdd(m, deps);
  assert.equal(m.added.length, 0, "Member is granted by verification, not on join");
  const welcome = deps.sent.find(s => s.id === "c-welcome");
  assert.ok(welcome, "welcome posted");
  assert.match(welcome.payload.content, /<@u1>/);
  assert.match(welcome.payload.content, /<#c-rules>/);
  assert.match(welcome.payload.content, /<#c-verify>/);

  const foreign = makeMember({ guild: { id: "g-other" } });
  await handleHouseMemberAdd(foreign, deps);
  assert.equal(foreign.added.length, 0);

  const bot = makeMember({ id: "u-bot", user: { id: "u-bot", bot: true, username: "B" } });
  await handleHouseMemberAdd(bot, deps);
  assert.equal(bot.added.length, 0);
});

test("member screening: pending joins are welcomed at join; the flip never double-greets", async () => {
  const deps = makeDeps();
  const m = makeMember({ pending: true });
  await handleHouseMemberAdd(m, deps);
  assert.equal(m.added.length, 0);
  assert.equal(deps.sent.filter(s => s.id === "c-welcome").length, 1, "welcome lands at join, not after rules acceptance");

  // guildMemberUpdate pending→false flip must not greet them a second time.
  const settled = makeMember({ pending: false });
  await handleHouseMemberUpdate({ pending: true }, settled, deps);
  assert.equal(settled.added.length, 0, "screening pass still doesn't grant Member — verify does");
  assert.equal(deps.sent.filter(s => s.id === "c-welcome").length, 1, "no double welcome on the flip");

  // A stale/non-flip update (uncached partial: pending undefined→false) does nothing.
  const again = makeMember({ pending: false });
  await handleHouseMemberUpdate({ pending: false }, again, deps);
  assert.equal(deps.sent.filter(s => s.id === "c-welcome").length, 1, "no welcome on a non-flip update");
});

test("raid-suppressed pending join is welcomed when they accept the rules", async () => {
  const deps = makeDeps();
  for (let i = 0; i < 4; i++) await handleHouseMemberAdd(makeMember({ id: `u-p${i}` }), deps); // hot
  const late = makeMember({ id: "u-pending", pending: true });
  await handleHouseMemberAdd(late, deps);
  assert.equal(deps.sent.filter(s => s.id === "c-welcome").length, 3, "hot window suppresses the pending join's welcome too");

  // They rode out the raid window and accepted the rules — greet them now.
  await handleHouseMemberUpdate({ pending: true }, makeMember({ id: "u-pending", pending: false }), deps);
  assert.equal(deps.sent.filter(s => s.id === "c-welcome").length, 4, "screening flip backfills a suppressed welcome");
});

test("a rejoin earns a fresh welcome (leave clears the dedupe)", async () => {
  const deps = makeDeps();
  await handleHouseMemberAdd(makeMember({ id: "u-boomerang" }), deps);
  assert.equal(deps.sent.filter(s => s.id === "c-welcome").length, 1);
  await handleHouseMemberRemove(makeMember({ id: "u-boomerang" }), deps);
  await handleHouseMemberAdd(makeMember({ id: "u-boomerang" }), deps);
  assert.equal(deps.sent.filter(s => s.id === "c-welcome").length, 2, "rejoin greets again");
});

test("member remove logs to ops channel", async () => {
  const deps = makeDeps();
  await handleHouseMemberRemove(makeMember({ id: "u-leaver" }), deps);
  assert.match(opsAlertText(deps), /left the server/);
});

test("raid window: alert once when joins exceed threshold; auto-kick when armed", async () => {
  const deps = makeDeps();
  for (let i = 0; i < 3; i++) await handleHouseMemberAdd(makeMember({ id: `u-j${i}` }), deps);
  assert.equal(opsAlertText(deps).match(/Possible raid/g)?.length ?? 0, 0, "at threshold = no alert");
  await handleHouseMemberAdd(makeMember({ id: "u-j3" }), deps);
  assert.match(opsAlertText(deps), /Possible raid.*4 joins/, "crossing the threshold alerts");
  await handleHouseMemberAdd(makeMember({ id: "u-j4" }), deps);
  assert.equal(opsAlertText(deps).match(/Possible raid/g)?.length, 1, "alert is once per hot window");

  resetOpsState();
  config.automodRaidKick = true;
  const deps2 = makeDeps();
  for (let i = 0; i < 3; i++) await handleHouseMemberAdd(makeMember({ id: `u-k${i}` }), deps2);
  const raider = makeMember({ id: "u-k3" });
  await handleHouseMemberAdd(raider, deps2);
  assert.equal(raider.kicked.length, 1, "hot window + armed = auto-kick");
  assert.equal(raider.added.length, 0, "kicked raider never gets the member role");
});

test("raid window: hot window suppresses welcome spam (alert-only mode)", async () => {
  const deps = makeDeps();
  for (let i = 0; i < 4; i++) await handleHouseMemberAdd(makeMember({ id: `u-r${i}` }), deps); // hot
  const raider = makeMember({ id: "u-raider" });
  await handleHouseMemberAdd(raider, deps);
  assert.equal(raider.added.length, 0, "no role grants in the join path at all — verify owns that");
  const welcomes = deps.sent.filter(s => s.id === "c-welcome");
  assert.equal(welcomes.length, 3, "no welcome posted once the window is hot — one greeting per raider would flood the channel");
});

// ── Verify gate ──────────────────────────────────────────────────────────────

test("ensureVerifyGate posts the card once; existing card is a no-op", async () => {
  const deps = makeDeps();
  assert.equal(await ensureVerifyGate(deps), true, "posts when the channel has no card");
  const card = deps.sent.find(s => s.id === "c-verify");
  assert.ok(card, "card posted to the gate channel");
  assert.match(JSON.stringify(card.payload.components), /house:verify/);

  // Real discord.js message fetches return a Collection — iterating yields
  // [snowflake, msg] pairs, NOT messages. The dedupe must unwrap them or it
  // can never match (the repost-per-boot regression).
  const deps2 = makeDeps({
    fetchChannel: async () => ({
      send: async () => {},
      messages: { fetch: async () => new Map([["m-card", { author: { id: "bot-1" }, components: card.payload.components }]]) },
    }),
  });
  assert.equal(await ensureVerifyGate(deps2), false, "existing card detected — no repost");
});

test("ensureVerifyGate deletes duplicate cards but leaves other messages", async () => {
  const deps = makeDeps();
  await ensureVerifyGate(deps);
  const card = deps.sent.find(s => s.id === "c-verify");
  const deleted: string[] = [];
  const msg = (id: string, author: string, withCard = true) => ({
    author: { id: author },
    components: withCard ? card!.payload.components : [],
    delete: async () => { deleted.push(id); },
  });
  const deps2 = makeDeps({
    fetchChannel: async () => ({
      send: async () => {},
      // Collection shape: pairs. Two bot cards + a human message in between.
      messages: { fetch: async () => new Map([
        ["m-new", msg("m-new", "bot-1")],
        ["m-human", msg("m-human", "u-1", false)],
        ["m-old", msg("m-old", "bot-1")],
      ]) },
    }),
  });
  assert.equal(await ensureVerifyGate(deps2), false);
  assert.deepEqual(deleted, ["m-old"], "only the duplicate bot card is deleted");
});

const makeButtonIx = (over: any = {}) => {
  const replies: any[] = [];
  return {
    replies,
    customId: "house:verify",
    guildId: HOUSE,
    user: { id: "u1" },
    reply: async (r: any) => { replies.push(r); return r; },
    ...over,
  };
};

const consentedStore = (account: object | null = { id: "acc-1", plan: "free", creditBalance: 0 }) => ({
  creditsSupported: true,
  accountForDiscordUser: async () => account,
  tosAcceptance: async () => ({ version: TERMS_VERSION, acceptedAt: "2026-01-01T00:00:00Z" }),
  recordTosAcceptance: async () => {},
}) as unknown as MemoryStore;

test("house:verify — linked account grants Member; unlinked gets the signup pointer", async () => {
  const linked = makeMember();
  initOps(makeDeps({
    fetchMember: async () => linked,
    store: consentedStore(),
  }));
  const ix = makeButtonIx();
  await handleHouseButton(ix as any);
  assert.deepEqual(linked.added, ["r-member"], "linked+consented account ⇒ Member granted");
  assert.match(ix.replies[0].content, /Verified/);

  const unlinked = makeMember();
  initOps(makeDeps({ fetchMember: async () => unlinked }));
  const ix2 = makeButtonIx();
  await handleHouseButton(ix2 as any);
  assert.equal(unlinked.added.length, 0, "no linked account ⇒ no role");
  assert.match(ix2.replies[0].content, /No linked Characterly account/);
  assert.match(ix2.replies[0].content, /\/link/);
});

test("house:verify — passes the linked account id to the consent lookup", async () => {
  // A web_signup acceptance lives on account_id only (no discord_user_id) —
  // the gate must hand the account over or those rows never count.
  let seen: Array<[string, unknown]> = [];
  initOps(makeDeps({
    fetchMember: async () => makeMember(),
    store: {
      creditsSupported: true,
      accountForDiscordUser: async () => ({ id: "acc-web", plan: "free", creditBalance: 0 }),
      tosAcceptance: async (uid: string, accountId?: unknown) => { seen.push([uid, accountId]); return { version: TERMS_VERSION, acceptedAt: "2026-01-01T00:00:00Z" }; },
      recordTosAcceptance: async () => {},
    } as unknown as MemoryStore,
  }));
  await handleHouseButton(makeButtonIx() as any);
  assert.deepEqual(seen, [["u1", "acc-web"]], "consent lookup should key on user + linked account");
});

test("house:verify — pending members are told to accept rules; non-house + already-verified refused", async () => {
  initOps(makeDeps({ fetchMember: async () => makeMember({ pending: true }) }));
  const ix = makeButtonIx();
  await handleHouseButton(ix as any);
  assert.match(ix.replies[0].content, /rules first/i);

  initOps(makeDeps());
  const foreign = makeButtonIx({ guildId: "g-other" });
  await handleHouseButton(foreign as any);
  assert.match(foreign.replies[0].content, /community server/);

  initOps(makeDeps({ fetchMember: async () => makeMember({ hasRole: true }), store: consentedStore() }));
  const done = makeButtonIx();
  await handleHouseButton(done as any);
  assert.match(done.replies[0].content, /Already verified/);
});

test("house:verify — a lookup error says retry, not 'no account'", async () => {
  const member = makeMember();
  initOps(makeDeps({
    fetchMember: async () => member,
    store: {
      creditsSupported: true,
      accountForDiscordUser: async () => { throw new Error("db is down"); },
    } as unknown as MemoryStore,
  }));
  const ix = makeButtonIx();
  await handleHouseButton(ix as any);
  assert.equal(member.added.length, 0, "an errored lookup never grants the role");
  assert.match(ix.replies[0].content, /try again/i);
  assert.doesNotMatch(ix.replies[0].content, /No linked/);
});

test("house:verify — linked but unconsented gets the accept prompt, not the role", async () => {
  const member = makeMember();
  const store = {
    creditsSupported: true,
    accountForDiscordUser: async () => ({ id: "acc-1", plan: "free", creditBalance: 0 }),
    tosAcceptance: async () => null,           // never accepted
    recordTosAcceptance: async () => {},
  } as unknown as MemoryStore;
  initOps(makeDeps({ fetchMember: async () => member, store }));
  const ix = makeButtonIx();
  await handleHouseButton(ix as any);
  assert.equal(member.added.length, 0, "no consent ⇒ no role");
  assert.match(ix.replies[0].content, /Terms of Service/);
  assert.match(ix.replies[0].content, /Privacy Policy/);
  assert.match(JSON.stringify(ix.replies[0].components), new RegExp(`house:consent:${TERMS_VERSION}`));

  // A stale acceptance (pre-bump) re-prompts instead of granting.
  const stale = makeMember();
  initOps(makeDeps({
    fetchMember: async () => stale,
    store: {
      creditsSupported: true,
      accountForDiscordUser: async () => ({ id: "acc-1", plan: "free", creditBalance: 0 }),
      tosAcceptance: async () => ({ version: TERMS_VERSION - 1, acceptedAt: "2025-01-01T00:00:00Z" }),
      recordTosAcceptance: async () => {},
    } as unknown as MemoryStore,
  }));
  const ix2 = makeButtonIx();
  await handleHouseButton(ix2 as any);
  assert.equal(stale.added.length, 0, "an older version doesn't satisfy the current one");
  assert.match(ix2.replies[0].content, /Terms of Service/);
});

test("house:consent — accept records the stamped version, then grants Member", async () => {
  const member = makeMember();
  const recorded: Array<{ user: string; account: string | null; version: number; source: string }> = [];
  let acceptedVersion = 0;
  initOps(makeDeps({
    fetchMember: async () => member,
    store: {
      creditsSupported: true,
      accountForDiscordUser: async () => ({ id: "acc-1", plan: "free", creditBalance: 0 }),
      tosAcceptance: async () => acceptedVersion ? { version: acceptedVersion, acceptedAt: "2026-01-01T00:00:00Z" } : null,
      recordTosAcceptance: async (u: string, a: string | null, v: number, s: string) => {
        recorded.push({ user: u, account: a, version: v, source: s });
        acceptedVersion = v;
      },
    } as unknown as MemoryStore,
  }));
  const ix = makeButtonIx({ customId: `house:consent:${TERMS_VERSION}` });
  await handleHouseButton(ix as any);
  assert.deepEqual(recorded, [{ user: "u1", account: "acc-1", version: TERMS_VERSION, source: "discord_verify" }]);
  assert.deepEqual(member.added, ["r-member"], "accepted ⇒ Member granted");
  assert.match(ix.replies[0].content, /Verified/);
});

test("house:consent — record failure grants nothing; pending/unlinked refuse", async () => {
  // Record throws → no role.
  const member = makeMember();
  initOps(makeDeps({
    fetchMember: async () => member,
    store: {
      creditsSupported: true,
      accountForDiscordUser: async () => ({ id: "acc-1", plan: "free", creditBalance: 0 }),
      tosAcceptance: async () => null,
      recordTosAcceptance: async () => { throw new Error("db is down"); },
    } as unknown as MemoryStore,
  }));
  const ix = makeButtonIx({ customId: `house:consent:${TERMS_VERSION}` });
  await handleHouseButton(ix as any);
  assert.equal(member.added.length, 0, "a failed record never grants");
  assert.match(ix.replies[0].content, /again in a moment/i);

  // Pending member clicking a forged/stale accept button → refused, no record.
  let recordCalls = 0;
  initOps(makeDeps({
    fetchMember: async () => makeMember({ pending: true }),
    store: {
      creditsSupported: true,
      accountForDiscordUser: async () => ({ id: "acc-1", plan: "free", creditBalance: 0 }),
      tosAcceptance: async () => null,
      recordTosAcceptance: async () => { recordCalls++; },
    } as unknown as MemoryStore,
  }));
  const pending = makeButtonIx({ customId: `house:consent:${TERMS_VERSION}` });
  await handleHouseButton(pending as any);
  assert.match(pending.replies[0].content, /rules first/i);
  assert.equal(recordCalls, 0, "pending member's click records nothing");

  // Unlinked user clicking accept → signup pointer, no record.
  initOps(makeDeps({
    fetchMember: async () => makeMember(),
    store: {
      creditsSupported: true,
      accountForDiscordUser: async () => null,
      getGuildKey: async () => null,
      recordTosAcceptance: async () => { recordCalls++; },
    } as unknown as MemoryStore,
  }));
  const unlinked = makeButtonIx({ customId: `house:consent:${TERMS_VERSION}` });
  await handleHouseButton(unlinked as any);
  assert.match(unlinked.replies[0].content, /No linked Characterly account/);
  assert.equal(recordCalls, 0, "unlinked click records nothing");
});

test("house:consent — already-Member clicking accept records and confirms", async () => {
  const member = makeMember({ hasRole: true });
  const recorded: number[] = [];
  initOps(makeDeps({
    fetchMember: async () => member,
    store: {
      creditsSupported: true,
      accountForDiscordUser: async () => ({ id: "acc-1", plan: "free", creditBalance: 0 }),
      tosAcceptance: async () => ({ version: TERMS_VERSION, acceptedAt: "2026-01-01T00:00:00Z" }),
      recordTosAcceptance: async (_u: string, _a: string | null, v: number) => { recorded.push(v); },
    } as unknown as MemoryStore,
  }));
  const ix = makeButtonIx({ customId: `house:consent:${TERMS_VERSION}` });
  await handleHouseButton(ix as any);
  assert.deepEqual(recorded, [TERMS_VERSION], "re-acceptance still records (self-heal path)");
  assert.equal(member.added.length, 0, "no double role grant");
  assert.match(ix.replies[0].content, /Already verified/);
});

test("house:verify — BYOK-only users (no account, personal key) verify through consent; accountId null", async () => {
  const member = makeMember();
  const recorded: Array<{ user: string; account: string | null; version: number; source: string }> = [];
  let acceptedVersion = 0;
  const store = {
    creditsSupported: true,
    accountForDiscordUser: async () => null, // never linked — a personal key covers chat
    getGuildKey: async (scope: string) =>
      scope === "dm:u1" ? { keyEnc: Buffer.from("k"), keyHint: "h", baseUrl: null, model: null, validatedAt: null } : null,
    tosAcceptance: async () => acceptedVersion ? { version: acceptedVersion, acceptedAt: "2026-01-01T00:00:00Z" } : null,
    recordTosAcceptance: async (u: string, a: string | null, v: number, s: string) => {
      recorded.push({ user: u, account: a, version: v, source: s });
      acceptedVersion = v;
    },
  } as unknown as MemoryStore;
  initOps(makeDeps({ fetchMember: async () => member, store }));

  // Verify click → no account but a personal key ⇒ consent prompt, not the
  // "no linked account" refusal.
  const ix = makeButtonIx();
  await handleHouseButton(ix as any);
  assert.equal(member.added.length, 0);
  assert.match(ix.replies[0].content, /Terms of Service/);
  assert.doesNotMatch(ix.replies[0].content, /No linked/);
  assert.equal(recorded.length, 0, "nothing recorded before the consent click");

  // Consent click → acceptance recorded against discord_user_id (account_id
  // null — there is no web profile to key it on), then Member granted.
  const ix2 = makeButtonIx({ customId: `house:consent:${TERMS_VERSION}` });
  await handleHouseButton(ix2 as any);
  assert.deepEqual(recorded, [{ user: "u1", account: null, version: TERMS_VERSION, source: "discord_verify" }]);
  assert.deepEqual(member.added, ["r-member"], "BYOK + consent ⇒ Member granted");
  assert.match(ix2.replies[0].content, /Verified/);
});

test("member link sweep: unconsented holder is revoked; consent error keeps the role", async () => {
  const consented = makeMember({ id: "u-ok", hasRole: true });
  const unconsented = makeMember({ id: "u-no", hasRole: true });
  const errored = makeMember({ id: "u-err", hasRole: true });
  const deps = makeDeps({
    listMembers: async () => [consented, unconsented, errored],
    store: {
      creditsSupported: true,
      accountForDiscordUser: async () => ({ id: "acc", plan: "free", creditBalance: 0 }),
      tosAcceptance: async (id: string) => {
        if (id === "u-err") throw new Error("db is down");
        return id === "u-ok" ? { version: TERMS_VERSION, acceptedAt: "2026-01-01T00:00:00Z" } : null;
      },
      recordTosAcceptance: async () => {},
    } as unknown as MemoryStore,
  });
  const revoked = await runMemberLinkSweep(deps);
  assert.equal(revoked, 1);
  assert.equal(consented.removed.length, 0, "current consent ⇒ role kept");
  assert.deepEqual(unconsented.removed, ["r-member"], "no consent ⇒ revoked");
  assert.equal(errored.removed.length, 0, "a consent lookup error must not revoke");
  assert.match(opsAlertText(deps), /u-no.*Terms.*Privacy/s);
});

test("member link sweep: unlinked holder loses Member, linked keeps it", async () => {
  const unlinked = makeMember({ id: "u-gone", hasRole: true });
  const linked = makeMember({ id: "u-stay", hasRole: true });
  const noRole = makeMember({ id: "u-plain" });
  const linkedIds = new Set(["u-stay"]);
  const deps = makeDeps({
    listMembers: async () => [unlinked, linked, noRole],
    store: {
      creditsSupported: true,
      accountForDiscordUser: async (id: string) => linkedIds.has(id) ? { id: "acc", plan: "free", creditBalance: 0 } : null,
      tosAcceptance: async () => ({ version: TERMS_VERSION, acceptedAt: "2026-01-01T00:00:00Z" }),
      recordTosAcceptance: async () => {},
    } as unknown as MemoryStore,
  });
  const revoked = await runMemberLinkSweep(deps);
  assert.equal(revoked, 1);
  assert.deepEqual(unlinked.removed, ["r-member"], "unlinked ⇒ role removed");
  assert.equal(linked.removed.length, 0, "linked ⇒ role kept");
  assert.equal(noRole.removed.length, 0, "non-holders aren't touched");
  assert.match(opsAlertText(deps), /u-gone.*Member role removed/);
});

test("member link sweep: a lookup error keeps the role — outages must not mass-revoke", async () => {
  const holder = makeMember({ id: "u-h", hasRole: true });
  const deps = makeDeps({
    listMembers: async () => [holder],
    store: {
      creditsSupported: true,
      accountForDiscordUser: async () => { throw new Error("db is down"); },
    } as unknown as MemoryStore,
  });
  const revoked = await runMemberLinkSweep(deps);
  assert.equal(revoked, 0);
  assert.equal(holder.removed.length, 0, "a DB hiccup is not an unlink — keep the role");
  assert.doesNotMatch(opsAlertText(deps), /Member role removed/);
});

// ── Automod ──────────────────────────────────────────────────────────────────

test("automod: invite link deleted + alerted", async () => {
  const deps = makeDeps();
  const m = makeMsg({ content: "join my server https://discord.gg/free-stuff" });
  assert.equal(await automodMessage(m, deps), true);
  assert.equal(m.deleted, true);
  assert.match(opsAlertText(deps), /invite link/);
});

test("automod: scam classes delete + 10m timeout", async () => {
  const deps = makeDeps();
  for (const content of [
    "FREE nitro for everyone click here",
    "connect your wallet to claim the airdrop",
    "earn $500 a day from home",
  ]) {
    const m = makeMsg({ content });
    assert.equal(await automodMessage(m, deps), true, content);
    assert.equal(m.deleted, true);
    assert.deepEqual(m.timeouts, [600_000], `10m timeout for: ${content}`);
    resetOpsState();
  }
});

test("automod: mass mention and unauthorized @everyone", async () => {
  const deps = makeDeps();
  const mass = makeMsg({ mentions: { users: { size: 9 }, everyone: false } });
  assert.equal(await automodMessage(mass, deps), true);
  assert.equal(mass.deleted, true);

  const ping = makeMsg({ mentions: { users: { size: 0 }, everyone: true } });
  assert.equal(await automodMessage(ping, deps), true, "@everyone without permission is deleted");

  // MentionEveryone permission holder is allowed to use it.
  const modPing = makeMsg({
    mentions: { users: { size: 0 }, everyone: true },
    member: {
      permissions: { has: (f: bigint) => f === 0x20000n || f === 0x2000n }, // MentionEveryone | ManageMessages — ManageMessages exempts anyway
    },
  });
  assert.equal(await automodMessage(modPing, deps), false);
});

test("automod: burst spam over threshold → delete + 5m timeout", async () => {
  const deps = makeDeps();
  for (let i = 0; i < 4; i++) {
    assert.equal(await automodMessage(makeMsg({ content: `spam ${i}` }), deps), false, `msg ${i} under cap`);
  }
  const burst = makeMsg({ content: "spam 5" });
  assert.equal(await automodMessage(burst, deps), true, "5th message in window trips");
  assert.deepEqual(burst.timeouts, [300_000]);
});

test("automod: action cooldown — sustained spam deletes silently, no re-alert/re-timeout", async () => {
  const deps = makeDeps();
  const m1 = makeMsg({ content: "join https://discord.gg/a" });
  assert.equal(await automodMessage(m1, deps), true);
  assert.match(opsAlertText(deps), /invite link/);
  // Same offender hits again inside 60s — deleted but no second alert.
  const m2 = makeMsg({ content: "and again https://discord.gg/b" });
  assert.equal(await automodMessage(m2, deps), true, "still acted (message handled)");
  assert.equal(m2.deleted, true, "re-offense still deleted");
  assert.equal(m2.timeouts.length, 0, "no repeat timeout inside the cooldown");
  assert.equal(opsAlertText(deps).match(/invite link/g)?.length, 1, "ops channel isn't flooded per re-offense");
});

test("automod: new account + external link is deleted; old account + link passes", async () => {
  const deps = makeDeps();
  const fresh = makeMsg({
    content: "check this https://example.com/thing",
    author: { id: "u-new", bot: false, username: "New", createdTimestamp: Date.now() - 2 * 86_400_000 },
  });
  assert.equal(await automodMessage(fresh, deps), true);

  resetOpsState();
  const old = makeMsg({
    content: "check this https://example.com/thing",
    author: { id: "u-old", bot: false, username: "Old", createdTimestamp: Date.now() - 400 * 86_400_000 },
  });
  assert.equal(await automodMessage(old, deps), false, "established accounts may post links");
});

test("automod: hard-line blocklist content is deleted + 30m timeout", async () => {
  const deps = makeDeps();
  // "hire a hitman" trips the illegal-content entry of the safety blocklist —
  // the same hard lines that screen authored listings apply to live chat.
  const m = makeMsg({ content: "anyone know where to hire a hitman" });
  assert.equal(await automodMessage(m, deps), true);
  assert.equal(m.deleted, true);
  assert.deepEqual(m.timeouts, [1_800_000]);
  assert.match(opsAlertText(deps), /hard-line content \(illegal content\)/);

  // Borderline-but-fine comment chatter stays up.
  resetOpsState();
  assert.equal(await automodMessage(makeMsg({ content: "this character's backstory is dark but well written" }), deps), false);
});

test("isMarketplaceThread matches only threads under the marketplace forum", () => {
  const thread = { isThread: () => true, parentId: "c-forum" };
  assert.equal(isMarketplaceThread(thread), true);
  assert.equal(isMarketplaceThread({ isThread: () => true, parentId: "c-other" }), false);
  assert.equal(isMarketplaceThread({ isThread: () => false, parentId: "c-forum" }), false);
  assert.equal(isMarketplaceThread({ parentId: "c-forum" }), false, "no isThread() → not a thread");
  assert.equal(isMarketplaceThread(null), false);
  const saved = config.marketplaceChannelId;
  config.marketplaceChannelId = undefined;
  try {
    assert.equal(isMarketplaceThread(thread), false, "unset forum id matches nothing");
  } finally { config.marketplaceChannelId = saved; }
});

test("automod: mods exempt, bots skipped, foreign guilds no-op, clean chat passes", async () => {
  const deps = makeDeps();
  const modMsg = makeMsg({
    content: "https://discord.gg/mod-posted",
    member: { permissions: { has: () => true }, timeout: async () => {} },
  });
  assert.equal(await automodMessage(modMsg, deps), false, "ManageMessages exempt");

  const botMsg = makeMsg({ content: "https://discord.gg/x", author: { id: "b1", bot: true } });
  assert.equal(await automodMessage(botMsg, deps), false);

  const foreign = makeMsg({ content: "https://discord.gg/x", guildId: "g-other" });
  assert.equal(await automodMessage(foreign, deps), false, "only the house guild is automodded");

  assert.equal(await automodMessage(makeMsg({ content: "my companion said the funniest thing" }), deps), false);
});

// ── Layout ───────────────────────────────────────────────────────────────────

test("ensureHouseLayout creates only what's missing; idempotent on second run", async () => {
  const created: Array<{ name: string; type: number; parent?: string }> = [];
  const existing: Array<{ id: string; name: string; type: number; parentId?: string | null }> = [
    { id: "c1", name: "welcome", type: 0, parentId: "cat-system" },
    { id: "cat-system", name: "SYSTEM", type: 4 },
  ];
  let n = 0;
  const guild = {
    id: HOUSE,
    channels: {
      cache: {
        find: (fn: (c: any) => boolean) => existing.find(fn),
      },
      create: async (opts: { name: string; type: number; parent?: string }) => {
        const c = { id: `new-${n++}`, ...opts, parentId: opts.parent };
        existing.push(c);
        created.push(opts);
        return c;
      },
    },
  };
  const first = await ensureHouseLayout(guild as any);
  assert.ok(first.length > 0);
  assert.ok(!first.includes("#welcome"), "existing channel is adopted, not recreated");
  // Every WANTED channel exists afterward.
  for (const group of WANTED_LAYOUT) {
    for (const w of group.channels) {
      assert.ok(existing.some(c => c.name.toLowerCase() === w.name.toLowerCase()), `missing ${w.name}`);
    }
  }
  const second = await ensureHouseLayout(guild as any);
  assert.deepEqual(second, [], "second run is a no-op");
  const nonHouse = await ensureHouseLayout({ ...guild, id: "g-other" } as any);
  assert.deepEqual(nonHouse, [], "refuses to touch a foreign guild");
});

test("ensureHouseLayout copies the category's overwrites to created channels", async () => {
  // A rebuilt mods-chat must not come up public — children inherit the
  // private category's permission overwrites at create time.
  const catOverwrites = [
    { id: "everyone", allow: 0n, deny: 1024n }, // ViewChannel denied
    { id: "r-mod", allow: 1024n, deny: 0n },
  ];
  const existing: any[] = [
    { id: "cat-services", name: "SERVICES", type: 4, permissionOverwrites: { cache: catOverwrites } },
    { id: "cat-system", name: "SYSTEM", type: 4 },
    { id: "cat-market", name: "CHARACTER MARKETPLACE", type: 4 },
    { id: "cat-resources", name: "RESOURCES", type: 4 },
    { id: "cat-help", name: "HELP", type: 4 },
  ];
  const created: any[] = [];
  const guild = {
    id: HOUSE,
    channels: {
      cache: { find: (fn: (c: any) => boolean) => existing.find(fn) },
      create: async (opts: any) => { const c = { id: `n-${created.length}`, ...opts }; existing.push(c); created.push(opts); return c; },
    },
  };
  await ensureHouseLayout(guild as any);
  const modsChat = created.find(c => c.name === "mods-chat");
  assert.ok(modsChat, "mods-chat was missing and got created");
  assert.equal(modsChat.parent, "cat-services");
  assert.deepEqual(modsChat.permissionOverwrites, catOverwrites.map(o => ({ id: o.id, allow: o.allow, deny: o.deny })),
    "created under the private category's overwrites — not default-public");
});

test("ensureHouseLayout denies Member typing on readOnly surfaces; synced children inherit", async () => {
  const edits: Array<{ target: string; id: string; perms: Record<string, unknown> }> = [];
  // Overwrite fake: edits upsert a per-role entry so a second run no-ops.
  const mkOw = (tag: string, deny = 0n) => {
    const ows: Array<{ id: string; allow: bigint; deny: bigint }> = [{ id: "r-member", allow: 1024n, deny }];
    return {
      cache: ows,
      edit: async (id: string, perms: Record<string, unknown>) => {
        edits.push({ target: tag, id, perms });
        let ow = ows.find(o => o.id === id);
        if (!ow) { ow = { id, allow: 0n, deny: 0n }; ows.push(ow); }
        for (const [k, v] of Object.entries(perms)) {
          const bit = PermissionFlagsBits[k as keyof typeof PermissionFlagsBits] as bigint;
          if (v === false) ow.deny |= bit; else if (v === true) ow.allow |= bit;
        }
      },
    };
  };
  const mkCat = (name: string) => ({ id: `cat-${name.toLowerCase()}`, name, type: 4, permissionOverwrites: mkOw(`cat:${name}`) });
  const mkCh = (name: string, parentId: string, synced: boolean, type = 0) =>
    ({ id: `c-${name}`, name, type, parentId, permissionsLocked: synced, permissionOverwrites: mkOw(name) });
  const existing = [
    mkCat("SYSTEM"), mkCat("CHARACTER MARKETPLACE"), mkCat("RESOURCES"), mkCat("HELP"), mkCat("SERVICES"),
    mkCh("welcome", "cat-system", true),
    mkCh("announcements", "cat-system", false), mkCh("events", "cat-system", false), mkCh("updates", "cat-system", false),
    mkCh("rules", "cat-system", true), mkCh("log-in", "cat-system", true), mkCh("characterly-web", "cat-system", true),
    mkCh("characters", "cat-character marketplace", true, 15),
    mkCh("adoptees", "cat-character marketplace", true),
    ...["what-is-characterly", "what-is-companionly", "get-companionly", "privacy-policy", "how-to-publish-bots"]
      .map(n => mkCh(n, "cat-resources", true)),
    mkCh("faqs", "cat-help", true), mkCh("support-ticket", "cat-help", true), mkCh("suggest-a-feature", "cat-help", true),
    mkCh("admins-chat", "cat-services", true), mkCh("mods-chat", "cat-services", true),
  ];
  const guild = {
    id: HOUSE,
    channels: {
      cache: { find: (fn: (c: any) => boolean) => existing.find(fn) },
      create: async (o: any) => ({ id: `n-${o.name}`, ...o, parentId: o.parent }),
    },
    roles: { cache: { find: (fn: (r: any) => boolean) => [{ id: "r-mod", name: "Mod" }, { id: "r-admin", name: "Admin" }].find(fn) } },
  };

  await ensureHouseLayout(guild as any);

  // HELP keeps the Member typing deny (hidden pre-verify); RESOURCES is an
  // "everyone" category — @everyone gets ViewChannel + typing denies instead.
  const helpCat = edits.find(x => x.target === "cat:HELP" && x.id === "r-member");
  assert.ok(helpCat, "HELP should get the Member typing deny");
  assert.equal(helpCat!.perms.SendMessages, false);
  assert.equal(helpCat!.perms.ViewChannel, true, "members keep view access");
  const resCat = edits.find(x => x.target === "cat:RESOURCES" && x.id === "g-house");
  assert.ok(resCat, "RESOURCES should get the @everyone visible-read-only overwrite");
  assert.equal(resCat!.perms.ViewChannel, true, "unverified can read RESOURCES");
  assert.equal(resCat!.perms.SendMessages, false, "…but nobody types there");
  assert.ok(!edits.some(x => x.target === "cat:RESOURCES" && x.id === "r-member"),
    "RESOURCES doesn't need a separate Member deny — @everyone's covers it");
  // Synced children are left alone — they inherit the parent deny.
  for (const n of ["suggest-a-feature", "privacy-policy", "what-is-characterly", "what-is-companionly"]) {
    assert.ok(!edits.some(e => e.target === n), `synced #${n} inherits the category deny — no per-channel write`);
  }
  // The two gated RESOURCES channels get their own @everyone hide overwrite —
  // channel-level deny overrides the now-visible category.
  for (const n of ["get-companionly", "how-to-publish-bots"]) {
    const e = edits.find(x => x.target === n);
    assert.ok(e, `#${n} needs its own @everyone hide`);
    assert.equal(e!.id, "g-house", `#${n} hide targets @everyone (guild id)`);
    assert.equal(e!.perms.ViewChannel, false, `#${n} invisible until Member`);
    assert.equal(e!.perms.SendMessages, false);
  }
  // #faqs is the pre-verify exception: its channel-level @everyone overwrite
  // allows ViewChannel over the category's hide, while denying its typing.
  const faqsEdit = edits.find(e => e.target === "faqs");
  assert.ok(faqsEdit, "#faqs needs its own @everyone overwrite to unhide it");
  assert.equal(faqsEdit!.id, "g-house", "faqs overwrite targets @everyone (guild id)");
  assert.equal(faqsEdit!.perms.ViewChannel, true, "unverified can read it");
  assert.equal(faqsEdit!.perms.SendMessages, false, "…but can't post in it");
  // #support-ticket is the pre-verify ticket desk: visible + post-silent,
  // but SendMessagesInThreads stays allowed so the opener can actually talk
  // inside the private ticket thread (membership is the visibility gate).
  const ticketEdit = edits.find(e => e.target === "support-ticket" && e.id === "g-house");
  assert.ok(ticketEdit, "#support-ticket needs its own @everyone overwrite");
  assert.equal(ticketEdit!.perms.ViewChannel, true, "unverified can read the ticket desk");
  assert.equal(ticketEdit!.perms.SendMessages, false, "…but can't post in it");
  assert.equal(ticketEdit!.perms.SendMessagesInThreads, true, "opener + staff can talk inside the ticket thread");
  assert.equal(ticketEdit!.perms.CreatePrivateThreads, false, "…only the bot opens threads");
  for (const rid of ["r-mod", "r-admin"]) {
    const e = edits.find(x => x.target === "support-ticket" && x.id === rid);
    assert.ok(e, `#support-ticket needs a ManageThreads allow for ${rid}`);
    assert.equal(e!.perms.ManageThreads, true, "staff see + join ticket threads");
  }
  // #adoptees is hidden pre-verify — @everyone loses ViewChannel, verified
  // Members keep it via the memberThreads grant.
  const adopteeHide = edits.find(e => e.target === "adoptees" && e.id === "g-house");
  assert.ok(adopteeHide, "#adoptees needs its own @everyone hide");
  assert.equal(adopteeHide!.perms.ViewChannel, false, "unverified can't see #adoptees");
  const adopteeMember = edits.find(e => e.target === "adoptees" && e.id === "r-member");
  assert.ok(adopteeMember, "#adoptees needs a Member grant");
  assert.equal(adopteeMember!.perms.ViewChannel, true, "verified members see it");
  assert.equal(adopteeMember!.perms.SendMessagesInThreads, true, "…and can talk in their threads");
  // #adoptees narrows staffModerate to Admin only — Mods must never hold
  // ManageThreads there (private adoptee chats are admin-visible only).
  const adopteeAdmin = edits.find(e => e.target === "adoptees" && e.id === "r-admin");
  assert.ok(adopteeAdmin, "#adoptees needs a ManageThreads allow for Admin");
  assert.equal(adopteeAdmin!.perms.ManageThreads, true, "admins can see + moderate adoptee threads");
  assert.ok(!edits.some(e => e.target === "adoptees" && e.id === "r-mod" && e.perms.ManageThreads === true),
    "Mod must not be granted ManageThreads on #adoptees");
  // #characterly-web is staff-posted: @everyone visible-silent, Mod+Admin write.
  const webLock = edits.find(e => e.target === "characterly-web" && e.id === "g-house");
  assert.ok(webLock, "#characterly-web needs the @everyone visible-silent overwrite");
  assert.equal(webLock!.perms.ViewChannel, true);
  assert.equal(webLock!.perms.SendMessages, false);
  for (const rid of ["r-mod", "r-admin"]) {
    const e = edits.find(x => x.target === "characterly-web" && x.id === rid);
    assert.ok(e, `#characterly-web needs a send allow for ${rid}`);
    assert.equal(e!.perms.SendMessages, true, "staff can post");
  }
  // SYSTEM's readOnly channels are individually flagged (mixed category).
  for (const n of ["announcements", "events", "updates"]) {
    const e = edits.find(x => x.target === n && x.id === "r-member");
    assert.ok(e, `#${n} should get its own Member deny`);
    assert.equal(e!.perms.SendMessagesInThreads, false);
    assert.equal(e!.perms.ViewChannel, true);
  }
  // #welcome is a lobby channel — the deny lands on @everyone (guild id), so
  // unverified arrivals can't post either, matching #rules/#log-in.
  const welcomeEdit = edits.find(x => x.target === "welcome");
  assert.ok(welcomeEdit, "#welcome should get a typing deny");
  assert.equal(welcomeEdit!.id, "g-house", "welcome deny must be on @everyone, not Member");
  assert.equal(welcomeEdit!.perms.SendMessages, false);
  assert.equal(welcomeEdit!.perms.ViewChannel, true);
  // Open surfaces stay open.
  for (const t of ["characters", "cat:SYSTEM", "cat:SERVICES", "mods-chat"]) {
    assert.ok(!edits.some(e => e.target === t), `${t} must not get a Member deny`);
  }

  // Idempotent — denies already present, nothing new to write.
  edits.length = 0;
  const second = await ensureHouseLayout(guild as any);
  assert.equal(edits.length, 0, "second run must not re-write overwrites");
  assert.deepEqual(second, []);
});

test("staffModerate grant list: stale Mod thread perms on #adoptees get revoked", async () => {
  // The Admin-only grant must be convergent — a pre-existing broad Mod
  // overwrite on the channel gets its managed bits denied on reconcile.
  const edits: Array<{ id: string; perms: Record<string, unknown> }> = [];
  const managed = PermissionFlagsBits.ManageThreads | PermissionFlagsBits.SendMessagesInThreads;
  const adopteesOws = [{ id: "r-mod", allow: 1024n | managed, deny: 0n }];
  const adoptees = {
    id: "c-adoptees", name: "adoptees", type: 0, parentId: "cat-market", permissionsLocked: false,
    permissionOverwrites: {
      cache: adopteesOws,
      edit: async (id: string, perms: Record<string, unknown>) => { edits.push({ id, perms }); },
    },
  };
  const guild = {
    id: HOUSE,
    channels: {
      cache: { find: (fn: (c: any) => boolean) =>
        [adoptees, { id: "cat-market", name: "CHARACTER MARKETPLACE", type: 4 }].find(fn) },
      create: async (o: any) => ({ id: `n-${o.name}`, ...o }),
    },
    roles: { cache: { find: (fn: (r: any) => boolean) => [{ id: "r-mod", name: "Mod" }, { id: "r-admin", name: "Admin" }].find(fn) } },
  };
  await ensureHouseLayout(guild as any);
  const revoke = edits.find(e => e.id === "r-mod");
  assert.ok(revoke, "stale Mod thread perms should be revoked on #adoptees");
  assert.equal(revoke!.perms.ManageThreads, false);
  assert.equal(revoke!.perms.SendMessagesInThreads, false);
  const grant = edits.find(e => e.id === "r-admin");
  assert.ok(grant, "Admin keeps the manage grant");
  assert.equal(grant!.perms.ManageThreads, true);
});

test("ensureResourcePosts posts marked embeds once; dedupes extras; edits stale in place", async () => {
  const deleted: string[] = [];
  const edited: string[] = [];
  const mkMsg = (id: string, embeds: unknown[] = [], bot = true) => ({
    author: { id: bot ? "bot-1" : "u-x" },
    embeds,
    edit: async (p: { embeds: unknown[] }) => { edited.push(id); msgsById.set(id, mkMsg(id, p.embeds, bot)); },
    delete: async () => {
      deleted.push(id);
      // A deleted message leaves the channel listing — like the real API.
      for (const list of Object.values(chanMsgs)) {
        const i = list.indexOf(id); if (i >= 0) list.splice(i, 1);
      }
    },
  });
  const msgsById = new Map<string, ReturnType<typeof mkMsg>>();
  const marked = (key: string, v: number) => [{ footer: { text: `Char.ly resources · ${key} · v${v}` } }];
  // Current marker derived from RESOURCE_POSTS so a version bump doesn't stale the fixture.
  const privacyV = RESOURCE_POSTS.find(p => p.channel === "privacy-policy")!.version;
  const publishV = RESOURCE_POSTS.find(p => p.channel === "how-to-publish-bots")!.version;
  msgsById.set("m-new", mkMsg("m-new", marked("privacy-policy", privacyV)));   // current — kept
  msgsById.set("m-dup", mkMsg("m-dup", marked("privacy-policy", privacyV)));   // duplicate — deleted
  msgsById.set("m-stale", mkMsg("m-stale", marked("how-to-publish-bots", 0))); // stale — edited
  msgsById.set("m-user", mkMsg("m-user", [], false));                  // human post — ignored

  const chanMsgs: Record<string, string[]> = {
    "c-privacy-policy": ["m-new", "m-dup", "m-user"],
    "c-how-to-publish-bots": ["m-stale"],
  };
  const deps = makeDeps({
    fetchChannel: async (id: string) => ({
      send: async (p: any) => {
        deps.sent.push({ id, payload: p });
        const mid = `m-sent-${id}`;
        msgsById.set(mid, mkMsg(mid, p.embeds, true));
        (chanMsgs[id] ??= []).unshift(mid);
      },
      messages: { fetch: async () => (chanMsgs[id] ?? []).map(m => msgsById.get(m)!).filter(Boolean) },
    }),
  });
  const names = ["what-is-characterly", "what-is-companionly", "get-companionly", "privacy-policy", "how-to-publish-bots", "faqs", "characterly-web"];
  const chans = names.map(n => ({ id: `c-${n}`, name: n, type: 0 }));
  const guild = { id: HOUSE, channels: { cache: { find: (fn: (c: any) => boolean) => chans.find(fn) } } };

  const out = await ensureResourcePosts(deps, guild as any);
  assert.equal(out.filter(s => s.startsWith("📝")).length, 5, "posts the 5 channels lacking a marked post");
  assert.deepEqual(deleted, ["m-dup"], "older duplicate deleted, newest kept");
  assert.deepEqual(edited, ["m-stale"], "stale post edited in place, not reposted");
  const staleAfter = msgsById.get("m-stale")!.embeds;
  assert.match(JSON.stringify(staleAfter), new RegExp(`how-to-publish-bots · v${publishV}`), "edit carries the new version marker");
  assert.ok(!deps.sent.some(s => s.id === "c-privacy-policy"), "no repost where a current marker exists");

  // Second run: everything marked current — total no-op.
  deleted.length = 0; edited.length = 0;
  const sentBefore = deps.sent.length;
  const again = await ensureResourcePosts(deps, guild as any);
  assert.deepEqual(again, []);
  assert.equal(deps.sent.length, sentBefore);
  assert.equal(deleted.length + edited.length, 0);
});

// ── Support tickets ──────────────────────────────────────────────────────────

// In-memory ticket store mirroring the real one's semantics — one open ticket
// per opener, keyed by thread.
const ticketStore = () => {
  const byThread = new Map<string, any>();
  const openByUser = new Map<string, string>();
  return {
    byThread, openByUser,
    openSupportTicketFor: async (uid: string) => {
      const tid = openByUser.get(uid);
      return tid ? byThread.get(tid) : null;
    },
    supportTicketByThread: async (tid: string) => byThread.get(tid) ?? null,
    createSupportTicket: async (g: string, uid: string, tid: string, subject: string, details: string) => {
      if (openByUser.has(uid)) return null; // partial-unique-index semantics
      const t = { threadId: tid, guildId: g, openerId: uid, subject, details, status: "open", openedAt: "", closedAt: null, closerId: null };
      byThread.set(tid, t); openByUser.set(uid, tid);
      return t;
    },
    closeSupportTicket: async (tid: string, uid: string) => {
      const t = byThread.get(tid);
      if (t?.status === "open") { t.status = "closed"; t.closerId = uid; openByUser.delete(t.openerId); }
    },
  } as unknown as MemoryStore;
};

const mkTicketThread = (id = "t-1") => {
  const state = { membersAdded: [] as string[], sent: [] as any[], locked: false, archived: false };
  return {
    ...state, state, id,
    members: { add: async (u: string) => { state.membersAdded.push(u); } },
    send: async (p: any) => { state.sent.push(p); },
    setLocked: async (v: boolean) => { state.locked = v; },
    setArchived: async (v: boolean) => { state.archived = v; },
  };
};

// A guild exposing #support-ticket + the Mod role, and a deps bundle whose
// fetchChannel serves a sendable channel with threads.create for it.
const ticketWorld = (opts: { thread?: ReturnType<typeof mkTicketThread>; sent?: Array<{ id: string; payload: any }> } = {}) => {
  const thread = opts.thread ?? mkTicketThread();
  const sent = opts.sent ?? [];
  const supportCh = { id: "c-support-ticket", name: "support-ticket", type: 0 };
  const guild = {
    id: HOUSE,
    channels: {
      cache: { find: (fn: (c: any) => boolean) => [supportCh].find(fn) },
      create: async (o: any) => ({ id: `n-${o.name}`, ...o }),
    },
    roles: { cache: { find: (fn: (r: any) => boolean) => [{ id: "r-mod", name: "Mod" }, { id: "r-admin", name: "Admin" }].find(fn) } },
  };
  const deps = makeDeps({
    store: ticketStore(),
    fetchGuild: async () => guild,
    fetchChannel: async (id: string) => id === supportCh.id
      ? {
          id, send: async (p: any) => { sent.push({ id, payload: p }); },
          messages: { fetch: async () => [] },
          threads: { create: async () => thread, fetchActive: async () => ({ threads: [] }) },
        }
      : { id, send: async (p: any) => { sent.push({ id, payload: p }); } },
  });
  (deps as any).guild = guild;
  return { deps, thread, sent, supportCh, guild };
};

const mkModalIx = (fields: Record<string, string>, over: any = {}) => {
  const replies: any[] = [];
  const edits: any[] = [];
  return {
    replies, edits,
    customId: "ticket:new", guildId: HOUSE, user: { id: "u1", username: "Alice" },
    fields: { getTextInputValue: (k: string) => fields[k] ?? "" },
    deferReply: async () => {},
    reply: async (r: any) => { replies.push(r); return r; },
    editReply: async (r: any) => { edits.push(r); return r; },
    ...over,
  };
};

test("ensureTicketPanel posts the card once; dedupes duplicates", async () => {
  const sent: Array<{ id: string; payload: any }> = [];
  const deleted: string[] = [];
  const cards = [
    { author: { id: "bot-1" }, components: [{ components: [{ custom_id: "ticket:open" }] }], delete: async () => {} }, // kept
    { author: { id: "u-x" }, components: [], delete: async () => { deleted.push("m-user"); } },
    { author: { id: "bot-1" }, components: [{ components: [{ custom_id: "ticket:open" }] }], delete: async () => { deleted.push("m-dup"); } }, // dup → deleted
  ];
  const { deps, guild } = ticketWorld({ sent });
  // First run — no panel → post.
  assert.equal(await ensureTicketPanel(deps, guild as any), true);
  const card = sent.find(s => s.id === "c-support-ticket");
  assert.ok(card, "panel posted to #support-ticket");
  assert.ok(JSON.stringify(card!.payload.components).includes("ticket:open"));

  // Panel already there → no-op (first bot card kept, the dup is deleted).
  const withPanel = makeDeps({
    fetchChannel: async (id: string) => ({
      id, send: async (p: any) => { sent.push({ id, payload: p }); },
      messages: { fetch: async () => cards },
    }),
  });
  const sentBefore = sent.length;
  assert.equal(await ensureTicketPanel(withPanel, guild as any), false);
  assert.equal(sent.length, sentBefore, "no repost when a panel exists");
  assert.deepEqual(deleted, ["m-dup"], "only the duplicate bot card deleted — user posts untouched");

  // Non-house guild → no panel posted.
  const foreign = { ...guild, id: "g-other" };
  const sentBefore2 = sent.length;
  assert.equal(await ensureTicketPanel(deps, foreign as any), false, "house-gated like the rest of ops");
  assert.equal(sent.length, sentBefore2);
});

test("ticket:open — shows the modal; existing ticket + lookup error refused", async () => {
  const { deps } = ticketWorld();
  initOps(deps);
  const modals: string[] = [];
  const replies: any[] = [];
  const ix = {
    customId: "ticket:open", guildId: HOUSE, user: { id: "u1" },
    reply: async (r: any) => { replies.push(r); return r; },
    showModal: async (m: any) => { modals.push(m.data?.custom_id ?? "?"); },
  };
  await handleTicketButton(ix as any);
  assert.deepEqual(modals, ["ticket:new"], "open click shows the intake modal");

  // Already-open ticket → pointer, no modal.
  await deps.store.createSupportTicket(HOUSE, "u1", "t-existing", "x", "y");
  const ix2 = { ...ix, replies: [] as any[], reply: async (r: any) => { replies.push(r); return r; } };
  await handleTicketButton(ix2 as any);
  assert.match(replies.at(-1).content, /already have an open ticket.*t-existing/);

  // Store outage → retry message, fail-closed.
  initOps(makeDeps({ store: { openSupportTicketFor: async () => { throw new Error("db down"); } } as unknown as MemoryStore }));
  await handleTicketButton(ix2 as any);
  assert.match(replies.at(-1).content, /try again in a moment/);

  // Foreign guild → refused.
  initOps(deps);
  const foreign = { ...ix, guildId: "g-other", reply: async (r: any) => { replies.push(r); return r; } };
  await handleTicketButton(foreign as any);
  assert.match(replies.at(-1).content, /community server/);
});

test("ticket modal — creates the private thread, adds member, files row, pings ops", async () => {
  const thread = mkTicketThread();
  const sent: Array<{ id: string; payload: any }> = [];
  const { deps } = ticketWorld({ thread, sent });
  initOps(deps);
  const ix = mkModalIx({ subject: "Billing question", details: "Charged twice" });
  await handleTicketModal(ix as any);

  assert.equal(thread.state.membersAdded[0], "u1", "opener added to the private thread");
  const opener = thread.state.sent[0];
  assert.ok(opener, "ticket card posted in-thread");
  assert.ok(JSON.stringify(opener.components).includes("ticket:close"), "card carries the close button");
  assert.match(JSON.stringify(opener.embeds), /Billing question/);
  const ticket = await deps.store.openSupportTicketFor("u1");
  assert.equal(ticket?.threadId, "t-1", "row filed with the thread id");
  const alert = sent.find(s => s.id === OPS);
  assert.ok(alert, "ops channel got the staff ping");
  assert.match(alert!.payload.content, /Ticket opened/);
  assert.deepEqual(alert!.payload.allowedMentions.roles, ["r-mod"], "Mod role pinged");
  assert.match(ix.edits[0].content, /t-1/, "user gets the thread link");
});

test("ticket modal — dedupe conflict archives the orphan thread", async () => {
  const thread = mkTicketThread();
  const { deps } = ticketWorld({ thread });
  // A rival ticket lands between the pre-submit check and the insert —
  // create hits the unique-index wall, the post-conflict lookup finds it.
  let lookCalls = 0;
  deps.store = {
    ...deps.store as object,
    openSupportTicketFor: async () => (lookCalls++ === 0 ? null : { threadId: "t-first", status: "open" }),
    createSupportTicket: async () => null,
  } as unknown as MemoryStore;
  initOps(deps);
  const ix = mkModalIx({ subject: "dup", details: "second submit" });
  await handleTicketModal(ix as any);
  assert.equal(thread.state.locked, true, "orphan thread locked");
  assert.equal(thread.state.archived, true, "orphan thread archived, never left live");
  assert.match(ix.edits[0].content, /already have an open ticket/);
});

test("ticket:close — opener + staff close; strangers refused; locks + archives", async () => {
  const { deps } = ticketWorld();
  await deps.store.createSupportTicket(HOUSE, "u1", "t-1", "help", "pls");
  initOps(deps);

  const mkClose = (userId: string, perms: bigint[] = []) => {
    const state = { locked: false, archived: false, sent: [] as any[], updates: [] as any[], replies: [] as any[] };
    const ix = {
      customId: "ticket:close", guildId: HOUSE, user: { id: userId },
      channel: {
        id: "t-1", isThread: () => true,
        send: async (p: any) => { state.sent.push(p); },
        setLocked: async (v: boolean) => { state.locked = v; },
        setArchived: async (v: boolean) => { state.archived = v; },
      },
      memberPermissions: { has: (b: bigint) => perms.includes(b) },
      update: async (p: any) => { state.updates.push(p); return p; },
      reply: async (r: any) => { state.replies.push(r); return r; },
    };
    return { ix, state };
  };

  // A stranger can't close it.
  const stranger = mkClose("u-rando");
  await handleTicketButton(stranger.ix as any);
  assert.match(stranger.state.replies[0].content, /opener or staff/);
  assert.equal(stranger.state.archived, false);
  assert.equal((await deps.store.supportTicketByThread("t-1"))?.status, "open");

  // The opener can.
  const opener = mkClose("u1");
  await handleTicketButton(opener.ix as any);
  assert.equal(opener.state.locked, true, "thread locked");
  assert.equal(opener.state.archived, true, "thread archived");
  assert.equal(opener.state.updates.length, 1, "button stripped from the card");
  assert.match(opener.state.sent[0].content, /Ticket closed/);
  assert.equal((await deps.store.supportTicketByThread("t-1"))?.status, "closed");

  // Reopen + staff close — ManageThreads holder who isn't the opener.
  await deps.store.createSupportTicket(HOUSE, "u2", "t-2", "x", "y");
  const staffClose = mkClose("u-mod", [PermissionFlagsBits.ManageThreads]);
  staffClose.ix.channel.id = "t-2";
  await handleTicketButton(staffClose.ix as any);
  assert.equal(staffClose.state.archived, true, "staff can close");
  assert.equal((await deps.store.supportTicketByThread("t-2"))?.closerId, "u-mod");

  // Already closed / not a thread → refused.
  const again = mkClose("u1");
  again.ix.channel.id = "t-2";
  await handleTicketButton(again.ix as any);
  assert.match(again.state.replies[0].content, /already closed/);
  const notThread = { customId: "ticket:close", guildId: HOUSE, user: { id: "u1" }, channel: { id: "c-x", isThread: () => false }, reply: async (r: any) => r };
  await handleTicketButton(notThread as any);
});


test("collectHostHealth reports proc/disk/db/queue", async () => {
  let queueArg: unknown = "unset";
  const deps = makeDeps({
    store: { queueStats: async (g: string | null) => { queueArg = g; return { pending: 2, dead: 1, oldestPendingAt: null }; } } as unknown as MemoryStore,
    exec: async () => ({ stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 100 80 20 80% /\n", stderr: "" }),
    dbPing: async () => 7,
    lagMs: () => 42,
  });
  const h = await collectHostHealth(deps);
  assert.equal(queueArg, null, "ops queue view is fleet-wide, not house-only");
  assert.equal(h.diskPct, 80);
  assert.equal(h.dbPingMs, 7);
  assert.equal(h.lagMs, 42);
  assert.equal(h.queuePending, 2);
  assert.equal(h.queueDead, 1);
  assert.equal(h.gitSha, "abc1234");
  assert.ok(h.heapPct > 0 && h.rssMb > 0 && h.uptimeSec >= 0);
});

test("watchdog: breach alerts once, recovery notifies once", async () => {
  // dbPing throws → "db" breach fires once, clears on heal.
  let failing = true;
  const deps = makeDeps({ dbPing: async () => { if (failing) throw new Error("down"); return 3; } });
  await runWatchdogTick(deps);
  await runWatchdogTick(deps);
  const alerts = deps.sent.filter(s => /Host breach/.test(s.payload.content));
  assert.equal(alerts.length, 1, "sustained breach alerts exactly once");
  assert.match(alerts[0].payload.content, /database ping failed/);
  failing = false;
  await runWatchdogTick(deps);
  assert.match(opsAlertText(deps), /Host recovered.*db/);
  await runWatchdogTick(deps);
  const recovers = deps.sent.filter(s => /Host recovered/.test(s.payload.content));
  assert.equal(recovers.length, 1, "recovery notices once too");
});

// ── /ops ─────────────────────────────────────────────────────────────────────

const makeIx = (over: any = {}) => {
  const replies: any[] = [];
  const edits: any[] = [];
  const follows: any[] = [];
  return {
    replies, edits, follows,
    guildId: HOUSE,
    user: { id: "u-op" },
    options: {
      getString: (n: string) => over.strings?.[n] ?? null,
      getInteger: (n: string) => over.integers?.[n] ?? null,
      ...over.options,
    },
    reply: async (r: any) => { replies.push(r); return r; },
    deferReply: async () => {},
    editReply: async (r: any) => { edits.push(r); return r; },
    followUp: async (r: any) => { follows.push(r); return r; },
    ...over.ix,
  };
};

test("/ops refuses non-allowlisted users and non-house guilds", async () => {
  initOps(makeDeps());
  const stranger = makeIx({ ix: { user: { id: "u-rando" } }, strings: { action: "status" } });
  await handleOpsCommand(stranger as any);
  assert.match(stranger.replies[0].content, /restricted/);

  const wrongGuild = makeIx({ ix: { guildId: "g-other" }, strings: { action: "status" } });
  await handleOpsCommand(wrongGuild as any);
  assert.match(wrongGuild.replies[0].content, /house server/);

  // DM is allowed for an allowlisted operator.
  const dm = makeIx({ ix: { guildId: null }, strings: { action: "status" } });
  await handleOpsCommand(dm as any);
  assert.ok(dm.replies[0].embeds?.length === 1, "status embed in DM");
});

test("/ops status replies with the health embed", async () => {
  initOps(makeDeps());
  const ix = makeIx({ strings: { action: "status" } });
  await handleOpsCommand(ix as any);
  const embed = ix.replies[0].embeds[0];
  assert.match(embed.data.title ?? "", /status/i);
  const lag = embed.data.fields?.find((f: any) => /lag/i.test(f.name));
  assert.ok(lag);
});

test("/ops restart replies then exits; /ops deploy pulls, then exits", async () => {
  const exits: number[] = [];
  const cmds: string[] = [];
  initOps(makeDeps({
    exit: c => exits.push(c),
    exec: async (cmd: string) => {
      cmds.push(cmd);
      if (cmd.includes("rev-parse")) return { stdout: "deadbeef\n", stderr: "" };
      return { stdout: "ok", stderr: "" };
    },
  }));

  const restart = makeIx({ strings: { action: "restart" } });
  await handleOpsCommand(restart as any);
  assert.match(restart.replies[0].content, /Restarting/);
  await new Promise(r => setTimeout(r, 400));
  assert.deepEqual(exits, [1]);

  const deploy = makeIx({ strings: { action: "deploy" } });
  await handleOpsCommand(deploy as any);
  assert.ok(cmds.some(c => c.includes("git pull --ff-only") && c.includes("npm ci")), "deploy runs pull+ci");
  assert.match(deploy.edits[0] as string, /Deployed `deadbeef`/);
  await new Promise(r => setTimeout(r, 400));
  assert.deepEqual(exits, [1, 1]);
});

test("/ops deploy failure reports redacted stderr and does NOT exit", async () => {
  const exits: number[] = [];
  initOps(makeDeps({
    exit: c => exits.push(c),
    exec: async (cmd: string) => {
      if (cmd.includes("git pull")) throw { stderr: "fatal: auth failed for token sekrit-123456789" };
      if (cmd.includes("rev-parse")) return { stdout: "9abcdef\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  }));
  const ix = makeIx({ strings: { action: "deploy" } });
  await handleOpsCommand(ix as any);
  assert.match(ix.edits[0] as string, /Deploy failed/);
  assert.match(ix.edits[0] as string, /tree is at `9abcdef`/, "failure reports where the tree actually sits — pull may have advanced HEAD before npm ci failed");
  await new Promise(r => setTimeout(r, 400));
  assert.equal(exits.length, 0, "failed deploy leaves the old build running");
});

test("/ops logs chunks + redacts journal output", async () => {
  initOps(makeDeps({
    exec: async () => ({ stdout: "line of output with a fake token gsk_abcd1234efgh\n".repeat(120), stderr: "" }),
  }));
  const ix = makeIx({ strings: { action: "logs" }, integers: { lines: 50 } });
  await handleOpsCommand(ix as any);
  assert.ok(ix.edits.length === 1);
  assert.ok(ix.edits[0].length <= 2000, "chunked under Discord's limit");
  assert.ok(ix.follows.length >= 0);
});

test("/ops announce posts to the announce channel; missing text refused", async () => {
  const deps = makeDeps();
  initOps(deps);
  const noText = makeIx({ strings: { action: "announce" } });
  await handleOpsCommand(noText as any);
  assert.match(noText.replies[0].content, /announcement text/);

  const ix = makeIx({ strings: { action: "announce", text: "Marketplace is open!" } });
  await handleOpsCommand(ix as any);
  const post = deps.sent.find(s => s.id === "c-announce");
  assert.equal(post?.payload.content, "Marketplace is open!");
  assert.match(ix.replies[0].content, /Posted/);
});

// ── Marketplace tag sweep ────────────────────────────────────────────────────

const TAGS = [
  { id: "tag-new", name: "New", moderated: true },
  { id: "tag-top", name: "Top Rated", moderated: true },
  { id: "tag-trend", name: "Trending", moderated: true },
  { id: "tag-staff", name: "Staff Pick", moderated: true },
  { id: "tag-genre", name: "Slice of Life" },
];

function makeThread(id: string, over: { appliedTags?: string[]; createdTimestamp?: number } = {}) {
  const calls: string[][] = [];
  return {
    id,
    appliedTags: over.appliedTags ?? [],
    createdTimestamp: over.createdTimestamp ?? Date.now(),
    calls,
    setAppliedTags: async (tags: string[]) => { calls.push(tags); },
  };
}

function forumDeps(threads: ReturnType<typeof makeThread>[], over: {
  listings?: unknown[]; stats?: Map<number, { avg: number; count: number }>; velocity?: Map<number, number>; tags?: typeof TAGS;
}) {
  return makeDeps({
    store: {
      listActiveListingsWithThreads: async () => over.listings ?? [],
      ratingStatsByListing: async () => over.stats ?? new Map(),
      recentAdoptionCounts: async () => over.velocity ?? new Map(),
    } as unknown as MemoryStore,
    fetchChannel: async () => ({
      send: async () => {},
      availableTags: over.tags ?? TAGS,
      threads: { fetchActive: async () => ({ threads: new Map(threads.map(t => [t.id, t])) }) },
    }),
  });
}

test("tag sweep: New applied to fresh threads, stripped past the window", async () => {
  const fresh = makeThread("t-fresh", { appliedTags: ["tag-genre"], createdTimestamp: Date.now() - 2 * 86_400_000 });
  const old = makeThread("t-old", { appliedTags: ["tag-new"], createdTimestamp: Date.now() - 10 * 86_400_000 });
  const deps = forumDeps([fresh, old], {
    listings: [{ id: 1, forumThreadId: "t-fresh" }, { id: 2, forumThreadId: "t-old" }],
  });

  const changed = await runTagSweep(deps);
  assert.equal(changed, 2);
  assert.deepEqual(fresh.calls[0], ["tag-new", "tag-genre"], "fresh thread earns New and keeps its genre tag");
  assert.deepEqual(old.calls[0], [], "aged-out thread loses New");
});

test("tag sweep: Top Rated honors avg+count; Trending honors velocity; Staff Pick preserved", async () => {
  const top = makeThread("t-top", { appliedTags: ["tag-new"], createdTimestamp: Date.now() });
  const few = makeThread("t-few", { appliedTags: ["tag-top"], createdTimestamp: Date.now() }); // below min count — loses it
  const hot = makeThread("t-hot", { appliedTags: ["tag-genre"], createdTimestamp: Date.now() });
  const picked = makeThread("t-picked", { appliedTags: ["tag-staff", "tag-genre"], createdTimestamp: Date.now() - 30 * 86_400_000 }); // staff pick + stale
  const deps = forumDeps([top, few, hot, picked], {
    listings: [
      { id: 1, forumThreadId: "t-top" }, { id: 2, forumThreadId: "t-few" },
      { id: 3, forumThreadId: "t-hot" }, { id: 4, forumThreadId: "t-picked" },
    ],
    stats: new Map([[1, { avg: 4.9, count: 8 }], [2, { avg: 5, count: 2 }]]),
    velocity: new Map([[3, 9]]),
  });

  const changed = await runTagSweep(deps);
  assert.equal(changed, 3, "top, few, hot change; picked is already correct");
  assert.deepEqual(top.calls[0], ["tag-new", "tag-top"], "meets avg+count → badge added");
  assert.deepEqual(few.calls[0], ["tag-new"], "below min ratings → badge stripped");
  assert.deepEqual(hot.calls[0], ["tag-new", "tag-trend", "tag-genre"], "velocity over threshold → Trending");
  assert.equal(picked.calls.length, 0, "Staff Pick + creator tags untouched, no write needed");
});

test("tag sweep: missing curated tag skips silently; inactive listing loses badges", async () => {
  const orphan = makeThread("t-orphan", { appliedTags: ["tag-top", "tag-genre"], createdTimestamp: Date.now() });
  const deps = forumDeps([orphan], {
    listings: [], // delisted/banned → no listing maps to the thread
    tags: TAGS.filter(t => t.name !== "Trending"), // tag deleted forum-side
  });

  const changed = await runTagSweep(deps);
  assert.equal(changed, 1);
  assert.deepEqual(orphan.calls[0], ["tag-genre"], "managed badges strip; creator tag stays");

  // No curated tags at all → early no-op.
  const none = forumDeps([makeThread("t-x")], { listings: [], tags: TAGS.filter(t => !t.moderated) });
  assert.equal(await runTagSweep(none), 0);
});

// ── Marketplace seeding ─────────────────────────────────────────────────────

function opsInteraction(action: string, over: { userId?: string; guildId?: string; text?: string; lines?: number; channels?: Record<string, unknown> } = {}) {
  const replies: Array<{ content?: string; ephemeral?: boolean }> = [];
  const edits: string[] = [];
  const interaction = {
    user: { id: over.userId ?? "u-op" },
    guildId: over.guildId === undefined ? HOUSE : over.guildId,
    options: {
      getString: (name: string, _req?: boolean) => (name === "action" ? action : name === "text" ? (over.text ?? null) : null),
      getInteger: (name: string) => (name === "lines" ? (over.lines ?? null) : null),
    },
    client: {
      user: { id: "bot-1", username: "Characterly", globalName: "Characterly" },
      channels: { fetch: async (id: string) => over.channels?.[id] ?? null },
    },
    reply: async (r: (typeof replies)[number]) => { replies.push(r); return r; },
    deferReply: async () => ({}),
    editReply: async (r: { content?: string } | string) => { edits.push(typeof r === "string" ? r : r.content ?? ""); return r; },
  };
  return { interaction, replies, edits };
}

test("/ops seedmarket: creates missing personas with genre tags, skips existing, patches covers", async () => {
  const created: Array<{ name: string; appliedTags?: string[]; files?: Array<{ name?: string }> }> = [];
  const cardEdits: Array<{ files?: Array<{ name?: string }> }> = [];
  const forum = {
    type: 15, // GuildForum
    availableTags: [
      { id: "tag-new", name: "New", moderated: true },
      { id: "tag-comp", name: "Companion" },
      { id: "tag-sol", name: "Slice of Life" },
    ],
    threads: {
      create: async (o: { name: string; appliedTags?: string[]; message?: { files?: Array<{ name?: string }> } }) => {
        created.push({ name: o.name, appliedTags: o.appliedTags, files: o.message?.files }); return { id: "t-" + created.length };
      },
      fetch: async () => null,
    },
  };
  // Wren's live thread predates cover art — its starter message has no
  // attachment, so the seed pass should edit one in (the gallery cover).
  const wrenStarter = { attachments: [] as Array<{ name?: string }>, edit: async (o: { files?: Array<{ name?: string }> }) => { cardEdits.push(o); return o; } };
  const wrenThread = { fetchStarterMessage: async () => wrenStarter };
  const made: Array<{ spec: { name: string } }> = [];
  const relisted: number[] = [];
  const beansRow = { id: 10, name: "Beans", status: "delisted" as const, forumThreadId: null, version: 1, addCount: 0,
    tagline: "t", voicePersona: "v", coreTraits: [], ownerDynamic: "", backstory: "", greeting: "g", avatarUrl: null };
  initOps(makeDeps({
    fetchChannel: async () => forum as never,
    store: {
      listMyListings: async () => [{ id: 9, name: "Wren", status: "active", forumThreadId: "t-old" }, beansRow],
      createListing: async (_u: string, spec: { name: string }) => { made.push({ spec }); return { ok: true, listing: { id: 100 + made.length, version: 1, addCount: 0, status: "active", forumThreadId: null, ...spec } }; },
      relistListing: async (id: number) => { relisted.push(id); return { ok: true, listing: { ...beansRow, status: "active" } }; },
      delistListing: async () => true,
      setListingThread: async () => true,
      listingRatingStats: async () => undefined,
    } as unknown as MemoryStore,
  }));
  const ix = opsInteraction("seedmarket", { channels: { "c-forum": forum, "t-old": wrenThread } });
  await handleOpsCommand(ix.interaction as never);
  // Wren (active, threaded) skips the listing path but gets its cover patched;
  // Beans (delisted, no thread) recovers via relist + re-post; 13 create fresh.
  assert.equal(created.length, SEED_LISTINGS.length - 1, "all but Wren create threads — including Beans' recovery");
  assert.equal(made.length, SEED_LISTINGS.length - 2, "Wren and Beans never hit createListing");
  assert.deepEqual(relisted, [10], "Beans relisted before re-posting");
  assert.equal(made.some(m => m.spec.name === "Wren"), false, "existing listing skipped by name");
  assert.ok(created.find(c => c.name.startsWith("Beans")), "Beans recovery re-posts a thread");
  const wren = created.find(c => c.name.startsWith("Wren"));
  assert.equal(wren, undefined);
  // Cover retrofit: Wren's starter message gains wren.jpg via edit; every
  // freshly created thread carries its persona's cover attachment.
  assert.equal(cardEdits.length, 1, "only Wren's coverless card gets patched");
  assert.equal(cardEdits[0]?.files?.[0]?.name, "wren.jpg");
  for (const c of created) {
    assert.ok(c.files?.length === 1 && /\.jpe?g$/.test(c.files[0]?.name ?? ""), `${c.name} carries a cover attachment`);
  }
  assert.match(ix.edits[0] ?? "", /cover patched/);
  // A persona whose tags resolve (Companion + Slice of Life exist on the fake forum)
  // gets appliedTags including New + its genres; names that don't resolve drop.
  const meridian = created.find(c => c.name.startsWith("NSS Meridian"));
  assert.ok(meridian);
  assert.deepEqual(meridian!.appliedTags, ["tag-new"], "Sci-Fi tag absent from the fake forum — only New applies");
  assert.match(ix.edits[0] ?? "", /Seed roster/);
});

test("/ops seedmarket: refuses when the marketplace channel isn't configured", async () => {
  const saved = config.marketplaceChannelId;
  config.marketplaceChannelId = undefined;
  try {
    initOps(makeDeps());
    const ix = opsInteraction("seedmarket");
    await handleOpsCommand(ix.interaction as never);
    assert.match(ix.replies[0]?.content ?? "", /MARKETPLACE_CHANNEL_ID/i);
  } finally { config.marketplaceChannelId = saved; }
});

// ── Adoptee threads (v54) ────────────────────────────────────────────────────

type FakeAdopteeThread = {
  id: string;
  sentPayloads: unknown[];
  addedMembers: string[];
  pinnedIds: string[];
  msgs: Array<{ id: string; pinned: boolean; components?: unknown; pin(): Promise<void> }>;
  locked: boolean;
  archived: boolean;
  members: { add(id: string): Promise<void> };
  send(p: unknown): Promise<{ id: string; pin(): Promise<void> }>;
  setLocked(b: boolean): Promise<void>;
  setArchived(b: boolean): Promise<void>;
  messages: { fetch(o: { limit: number }): Promise<Iterable<unknown>> };
};

function makeAdopteeThread(id: string, opts: { addFails?: boolean } = {}): FakeAdopteeThread {
  const t: FakeAdopteeThread = {
    id, sentPayloads: [], addedMembers: [], pinnedIds: [], msgs: [], locked: false, archived: false,
    members: { add: async uid => { if (opts.addFails) throw new Error("no access"); t.addedMembers.push(uid); } },
    send: async p => {
      t.sentPayloads.push(p);
      const mid = `m-${t.sentPayloads.length}`;
      const m = {
        id: mid, pinned: false,
        components: (p as { components?: unknown })?.components,
        pin: async () => { m.pinned = true; t.pinnedIds.push(mid); },
      };
      t.msgs.push(m);
      return m;
    },
    messages: { fetch: async () => t.msgs },
    setLocked: async b => { t.locked = b; },
    setArchived: async b => { t.archived = b; },
  };
  return t;
}

function makeAdopteesParent(thread: FakeAdopteeThread, created: Array<Record<string, unknown>>) {
  return {
    send: async () => {},
    threads: {
      fetchActive: async () => ({ threads: new Map() }),
      create: async (opts: Record<string, unknown>) => { created.push(opts); return thread; },
    },
  };
}

const adopteeFixture = (over: Record<string, unknown> = {}) => ({
  adoption: {
    id: 7, userId: "u-adopter", listingId: 3, companionId: 11,
    adoptedAt: new Date().toISOString(), droppedAt: null, cooldownUntil: null,
    dmIntroducedAt: null, chatThreadId: null,
  },
  companion: { id: 11, name: "Wren", avatarUrl: null },
  listing: { id: 3, greeting: "*Wren waves hello.*" },
  username: "Joiner",
  ...over,
});

function adopteeDeps(opts: {
  thread?: FakeAdopteeThread;
  created?: Array<Record<string, unknown>>;
  member?: MemberLike | null;
  stamped?: Array<[number, string]>;
  introduced?: number[];
  channels?: Record<string, unknown>;
  missingRows?: Array<Record<string, unknown>>;
} = {}) {
  const created = opts.created ?? [];
  const stamped = opts.stamped ?? [];
  const introduced = opts.introduced ?? [];
  const thread = opts.thread ?? makeAdopteeThread("t-new");
  const parent = makeAdopteesParent(thread, created);
  const deps = makeDeps({
    store: {
      setAdoptionThread: async (a: number, t: string) => { stamped.push([a, t]); },
      markDmIntroduced: async (a: number) => { introduced.push(a); },
      activeAdoptionsForUser: async () => [],
      activeAdoptionsMissingThreads: async () => opts.missingRows ?? [],
    } as unknown as MemoryStore,
    fetchMember: async () => opts.member === undefined ? makeMember({ id: "u-adopter" }) : opts.member,
    fetchChannel: async id => (opts.channels?.[id] as never) ?? (id === "c-adoptees" ? parent : { send: async () => {} }),
  });
  return { deps, thread, created, stamped, introduced };
}

test("isAdopteeThread: env-id parent matches; name fallback catches pre-env channels", () => {
  assert.equal(isAdopteeThread({ isThread: () => true, parentId: "c-adoptees" }), true);
  assert.equal(isAdopteeThread({ isThread: () => true, parentId: "c-elsewhere" }), false);
  assert.equal(isAdopteeThread(null), false);
  assert.equal(isAdopteeThread({ isThread: () => true }), false);
  const saved = config.houseAdopteesChannelId;
  config.houseAdopteesChannelId = undefined;
  try {
    assert.equal(isAdopteeThread({ isThread: () => true, parent: { name: "#Adoptees" } }), true);
    assert.equal(isAdopteeThread({ isThread: () => true, parent: { name: "support-ticket" } }), false);
  } finally { config.houseAdopteesChannelId = saved; }
});

test("ensureAdopteeThread: creates a named private thread, adds the adopter, greets, stamps", async () => {
  const { deps, thread, created, stamped, introduced } = adopteeDeps();
  const res = await ensureAdopteeThread(deps, adopteeFixture() as never);
  assert.ok("thread" in res && res.created);
  assert.equal(created.length, 1);
  assert.equal(created[0].type, 12); // ChannelType.PrivateThread
  assert.equal(created[0].invitable, false);
  assert.equal(created[0].name, "Wren");
  assert.deepEqual(thread.addedMembers, ["u-adopter"]);
  assert.deepEqual(stamped, [[7, "t-new"]]);
  assert.deepEqual(introduced, [7]);
  // The greeting landed — webhook lane is dead on the fake parent, so the
  // bold-name fallback posted into the thread — then the pinned manage row
  // with the companion's own Drop button.
  assert.equal(thread.sentPayloads.length, 2);
  const manage = thread.sentPayloads[1] as { content: string; components: unknown[] };
  assert.match(manage.content, /Manage \*\*Wren\*\*/);
  assert.ok(JSON.stringify(manage.components).includes("market:drop:11"), "manage row carries the drop button");
  assert.deepEqual(thread.pinnedIds, ["m-2"], "the manage row pins itself");
});

test("ensureAdopteeThread: non-members get needsInvite — no thread created", async () => {
  const { deps, created, stamped } = adopteeDeps({ member: null });
  const res = await ensureAdopteeThread(deps, adopteeFixture() as never);
  assert.deepEqual(res, { needsInvite: true });
  assert.equal(created.length, 0);
  assert.equal(stamped.length, 0);
});

test("ensureAdopteeThread: existing chat_thread_id short-circuits; reopen unlocks+unarchives", async () => {
  const existing = makeAdopteeThread("t-old");
  existing.locked = true; existing.archived = true;
  const { deps, created } = adopteeDeps({ channels: { "t-old": existing } });
  const fixture = adopteeFixture();
  (fixture.adoption as { chatThreadId: string | null }).chatThreadId = "t-old";
  const res = await ensureAdopteeThread(deps, { ...fixture, reopen: true } as never);
  assert.ok("thread" in res && !res.created && res.thread.id === "t-old");
  assert.equal(created.length, 0);
  assert.equal(existing.locked, false);
  assert.equal(existing.archived, false);
  // Same thread, no greeting — greeting only happens on creation. But a
  // thread missing the manage row gets it backfilled + pinned (threads that
  // predate the row are exactly this case).
  assert.equal(existing.sentPayloads.length, 1);
  assert.ok(JSON.stringify(existing.sentPayloads[0]).includes("market:drop:11"), "manage row backfilled");
  assert.deepEqual(existing.pinnedIds, ["m-1"], "backfilled row pins itself");

  // Second ensure — the row is found already pinned and nothing re-posts.
  await ensureAdopteeThread(deps, { ...fixture, reopen: true } as never);
  assert.equal(existing.sentPayloads.length, 1, "no duplicate manage row");
});

test("ensureAdopteeThread: member-add failure tears the thread down and fails", async () => {
  const thread = makeAdopteeThread("t-bad", { addFails: true });
  const { deps, stamped } = adopteeDeps({ thread });
  const res = await ensureAdopteeThread(deps, adopteeFixture() as never);
  assert.deepEqual(res, { failed: true });
  assert.equal(thread.locked, true);
  assert.equal(thread.archived, true);
  assert.equal(stamped.length, 0);
});

test("setAdopteeThreadLocked: lock posts the note then locks+archives; unlock reopens", async () => {
  const thread = makeAdopteeThread("t-life");
  const { deps } = adopteeDeps({ channels: { "t-life": thread } });
  await setAdopteeThreadLocked(deps, "t-life", true, "frozen by moderation");
  assert.equal(thread.sentPayloads.length, 1);
  assert.equal((thread.sentPayloads[0] as { content: string }).content, "frozen by moderation");
  assert.equal(thread.locked, true);
  assert.equal(thread.archived, true);
  await setAdopteeThreadLocked(deps, "t-life", false);
  assert.equal(thread.locked, false);
  assert.equal(thread.archived, false);
  // No thread id / unknown thread are quiet no-ops.
  await setAdopteeThreadLocked(deps, null, true);
  await setAdopteeThreadLocked(deps, "t-gone", true);
});

test("backfillAdopteeThreads: creates threads for members, skips non-members", async () => {
  const created: Array<Record<string, unknown>> = [];
  const stamped: Array<[number, string]> = [];
  const missing = [
    { ...adopteeFixture(), adoption: { ...adopteeFixture().adoption, id: 7 } },
    { ...adopteeFixture(), adoption: { ...adopteeFixture().adoption, id: 8, userId: "u-gone" } },
  ];
  const thread = makeAdopteeThread("t-bf");
  const { deps } = adopteeDeps({ thread, created, stamped, missingRows: missing });
  // u-adopter is a member; u-gone isn't.
  deps.fetchMember = async (_g: string, uid: string) => uid === "u-adopter" ? makeMember({ id: uid }) : null;
  await backfillAdopteeThreads(deps);
  assert.equal(created.length, 1);
  assert.deepEqual(stamped, [[7, "t-bf"]]);
});

test("house member add: deferred adoptees get their threads on join", async () => {
  const created: Array<Record<string, unknown>> = [];
  const stamped: Array<[number, string]> = [];
  const thread = makeAdopteeThread("t-join");
  const missing = [{ ...adopteeFixture(), username: "Joiner" }];
  const { deps } = adopteeDeps({ thread, created, stamped });
  (deps.store as { activeAdoptionsForUser(uid: string): Promise<unknown[]> })
    .activeAdoptionsForUser = async uid => uid === "u-adopter" ? missing : [];
  const m = makeMember({ id: "u-adopter" });
  await handleHouseMemberAdd(m, deps);
  assert.equal(created.length, 1);
  assert.deepEqual(stamped, [[7, "t-join"]]);
});

test("house member add: rejoining adopters are re-added to their live thread", async () => {
  // Leaving the guild drops private-thread membership — the join hook must
  // re-attach the adopter to the thread they already have, not rebuild it.
  const live = makeAdopteeThread("t-live");
  live.archived = true;
  const created: Array<Record<string, unknown>> = [];
  const { deps } = adopteeDeps({ created, channels: { "t-live": live } });
  const adoption = { ...adopteeFixture().adoption, chatThreadId: "t-live" };
  const rows = [{ ...adopteeFixture({ adoption }), username: "Joiner" }];
  (deps.store as { activeAdoptionsForUser(uid: string): Promise<unknown[]> })
    .activeAdoptionsForUser = async uid => uid === "u-adopter" ? rows : [];
  await handleHouseMemberAdd(makeMember({ id: "u-adopter" }), deps);
  assert.equal(created.length, 0);
  assert.deepEqual(live.addedMembers, ["u-adopter"]);
  assert.equal(live.archived, false);
});

test("house member update: gaining the Member role re-attaches adoptee threads", async () => {
  // Rejoiners arrive role-less — roles don't persist — so the join-time
  // re-attach fails under the @everyone-hidden parent; the role grant is
  // where it can finally succeed.
  const live = makeAdopteeThread("t-live2");
  const { deps } = adopteeDeps({ channels: { "t-live2": live } });
  const adoption = { ...adopteeFixture().adoption, chatThreadId: "t-live2" };
  const rows = [{ ...adopteeFixture({ adoption }), username: "Joiner" }];
  (deps.store as { activeAdoptionsForUser(uid: string): Promise<unknown[]> })
    .activeAdoptionsForUser = async uid => uid === "u-adopter" ? rows : [];
  const saved = config.houseMemberRoleId;
  config.houseMemberRoleId = "r-member";
  const noRole = { pending: false, roles: { add: async () => {}, cache: { has: () => false } } };
  const hasRole = { pending: false, roles: { add: async () => {}, cache: { has: (id: string) => id === "r-member" } } };
  try {
    await handleHouseMemberUpdate(noRole, makeMember({ id: "u-adopter", hasRole: true }), deps);
    assert.deepEqual(live.addedMembers, ["u-adopter"]);
    // Already held the role on the old side → not a gain, no re-run.
    live.addedMembers.length = 0;
    await handleHouseMemberUpdate(hasRole, makeMember({ id: "u-adopter", hasRole: true }), deps);
    assert.deepEqual(live.addedMembers, []);
  } finally { config.houseMemberRoleId = saved; }
});
