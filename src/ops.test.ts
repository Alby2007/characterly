import { test, beforeEach } from "node:test";
import assert from "node:assert";
import {
  isHouse, isMarketplaceThread, isAdopteeThread, automodMessage, handleHouseMemberAdd, handleHouseMemberUpdate,
  handleHouseMemberRemove, ensureHouseLayout, collectHostHealth,
  runWatchdogTick, handleOpsCommand, initOps, resetOpsState, WANTED_LAYOUT,
  ensureVerifyGate, handleHouseButton, runMemberLinkSweep, runTagSweep, ensureResourcePosts,
  ensureTicketPanel, handleTicketButton, handleTicketModal,
  ensureAdopteeThread, setAdopteeThreadLocked, backfillAdopteeThreads,
  removeDeployment, syncDeployments, deployMarketplace, houseAdopteesPressure,
  reapOrphanTicketThreads, refreshDeploymentCache, handleHouseReportCategory, handleHouseModAction, startLinkSweep,
  noteTicketStaffReply, runVerifyNudgeSweep,
  TERMS_VERSION, RESOURCE_POSTS,
  type OpsDeps, type AutomodMessage, type MemberLike,
} from "./ops.js";
import { PermissionFlagsBits, ChannelType } from "discord.js";
import { config } from "./config.js";
import { SEED_LISTINGS } from "./seed-personas.js";
import type { MemoryStore } from "./database.js";
import type { GuildDeployment } from "./types.js";

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
  houseAdopteesChannelId: config.houseAdopteesChannelId, houseInviteUrl: config.houseInviteUrl,
  automodKickThreshold: config.automodKickThreshold, marketReportDailyCap: config.marketReportDailyCap,
  houseVerifyNudge: config.houseVerifyNudge,
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
  config.automodKickThreshold = 4;
  config.marketReportDailyCap = 5;
  config.houseVerifyNudge = true;
});

process.on("exit", () => Object.assign(config, prev));

// ── Fakes ────────────────────────────────────────────────────────────────────

function makeDeps(over: Partial<OpsDeps> = {}): OpsDeps & { sent: Array<{ id: string; payload: any }> } {
  const sent: Array<{ id: string; payload: any }> = [];
  const defaultStore = {
    queueStats: async () => ({ pending: 2, dead: 1, oldestPendingAt: null }),
    creditsSupported: true,
    accountForDiscordUser: async () => null,
    getGuildKey: async () => null,
    tosAcceptance: async () => null,
    recordTosAcceptance: async () => {},
    trackEvent: async () => {},
  } as unknown as MemoryStore;
  const { store: overStore, ...rest } = over;
  const deps: OpsDeps & { sent: typeof sent } = {
    sent,
    store: { ...defaultStore, ...(overStore ?? {}) } as unknown as MemoryStore,
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
    ...rest,
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
  assert.match(ix.replies[0].content, /You're in|Welcome to Characterly/);

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
  assert.match(ix.replies[0].content, /You're in|Welcome to Characterly/);
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
  assert.match(ix2.replies[0].content, /You're in|Welcome to Characterly/);
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

test("member link sweep: BYOK-only holder keeps Member; key-lookup error keeps it too; no key + no account revokes", async () => {
  const byok = makeMember({ id: "u-key", hasRole: true });
  const errored = makeMember({ id: "u-err", hasRole: true });
  const gone = makeMember({ id: "u-gone2", hasRole: true });
  const deps = makeDeps({
    listMembers: async () => [byok, errored, gone],
    store: {
      accountForDiscordUser: async () => null, // nobody has a linked web account
      getGuildKey: async (scope: string) => {
        if (scope === "dm:u-err") throw new Error("db is down");
        return scope === "dm:u-key" ? { keyEnc: Buffer.from("k"), keyHint: "h" } : null;
      },
      tosAcceptance: async () => ({ version: TERMS_VERSION, acceptedAt: "2026-01-01T00:00:00Z" }),
    } as unknown as MemoryStore,
  });
  const revoked = await runMemberLinkSweep(deps);
  assert.equal(revoked, 1);
  assert.equal(byok.removed.length, 0, "the gate admits a personal key — the sweep must not revoke on a missing account alone");
  assert.equal(errored.removed.length, 0, "a key-lookup error is 'unknown' — same fail-safe as the account check");
  assert.deepEqual(gone.removed, ["r-member"], "no account AND no key ⇒ revoked");
});

test("member link sweep: BYOK holders are consent-checked like linked members", async () => {
  const stale = makeMember({ id: "u-old", hasRole: true });
  const deps = makeDeps({
    listMembers: async () => [stale],
    store: {
      accountForDiscordUser: async () => null,
      getGuildKey: async () => ({ keyEnc: Buffer.from("k"), keyHint: "h" }),
      tosAcceptance: async () => null, // verified BYOK-side but never accepted
    } as unknown as MemoryStore,
  });
  const revoked = await runMemberLinkSweep(deps);
  assert.equal(revoked, 1);
  assert.deepEqual(stale.removed, ["r-member"], "BYOK verification still required consent — a missing acceptance revokes");
});

test("house:verify — a BYOK key-lookup error says retry, not 'no account'", async () => {
  const member = makeMember();
  initOps(makeDeps({
    fetchMember: async () => member,
    store: {
      creditsSupported: true,
      accountForDiscordUser: async () => null,
      getGuildKey: async () => { throw new Error("db is down"); },
    } as unknown as MemoryStore,
  }));
  const ix = makeButtonIx();
  await handleHouseButton(ix as any);
  assert.match(ix.replies[0].content, /try again in a moment/);
  assert.doesNotMatch(ix.replies[0].content, /No linked/);
  assert.equal(member.added.length, 0);
});

// ── Automod ──────────────────────────────────────────────────────────────────

test("automod: invite link deleted + alerted", async () => {
  const deps = makeDeps();
  const m = makeMsg({ content: "join my server https://discord.gg/free-stuff" });
  assert.equal(await automodMessage(m, deps), true);
  assert.equal(m.deleted, true);
  assert.match(opsAlertText(deps), /invite link/);
});

test("automod: the house's own invite is exempt; bundling a foreign code still trips", async () => {
  config.houseInviteUrl = "https://discord.gg/our-house";
  try {
    const deps = makeDeps();
    const own = makeMsg({ content: "come hang https://discord.gg/our-house sometime" });
    assert.equal(await automodMessage(own, deps), false, "house invite survives");
    assert.equal(own.deleted, false);

    const foreign = makeMsg({ content: "join https://discord.gg/elsewhere" });
    assert.equal(await automodMessage(foreign, deps), true);
    assert.equal(foreign.deleted, true);

    // Bundling the house invite with a foreign code doesn't launder it.
    resetOpsState();
    const mixed = makeMsg({ content: "https://discord.gg/our-house and https://discord.gg/elsewhere" });
    assert.equal(await automodMessage(mixed, deps), true);
    assert.equal(mixed.deleted, true);
  } finally { config.houseInviteUrl = undefined; }
});

test("automod: a case-variant of the house invite code is NOT the house invite", async () => {
  // Discord invite codes are case-sensitive — "OUR-HOUSE" is a different
  // invite than "our-house", so the exemption must compare exactly.
  config.houseInviteUrl = "https://discord.gg/OurHouse";
  try {
    const deps = makeDeps();
    const exact = makeMsg({ content: "https://discord.gg/OurHouse" });
    assert.equal(await automodMessage(exact, deps), false, "exact house code survives");
    assert.equal(exact.deleted, false);

    resetOpsState();
    const variant = makeMsg({ content: "https://discord.gg/OURHOUSE" });
    assert.equal(await automodMessage(variant, deps), true, "case-variant is a foreign invite");
    assert.equal(variant.deleted, true);
  } finally { config.houseInviteUrl = undefined; }
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

test("automod: scam text bundled with an invite classifies as SCAM — the timeout lands, not just a delete", async () => {
  const deps = makeDeps();
  // Ordering matters: scam authors ride invites, and classifying them under
  // the generic invite rule (delete only) would dodge the scam sanction.
  const m = makeMsg({ content: "FREE nitro for everyone, join https://discord.gg/x" });
  assert.equal(await automodMessage(m, deps), true);
  assert.deepEqual(m.timeouts, [600_000], "the scam rule's 10m timeout applies");
  assert.match(opsAlertText(deps), /nitro scam/);
});

test("automod: channel-overwrite ManageMessages exempts — permissionsIn beats role-level perms", async () => {
  const deps = makeDeps();
  // A mod whose ManageMessages comes from a channel overwrite (not a role)
  // reports false at role level — the effective-permissions check must still
  // treat them as staff.
  const overwriteMod = makeMsg({
    content: "https://discord.gg/x",
    member: {
      permissions: { has: () => false },
      permissionsIn: () => ({ has: (f: bigint) => f === PermissionFlagsBits.ManageMessages }),
      timeout: async () => {},
    },
  });
  assert.equal(await automodMessage(overwriteMod, deps), false, "channel-granted perms are still staff");
  assert.equal(overwriteMod.deleted, false);
});

// ── Automod escalation + house reports (v66) ────────────────────────────────

test("automod escalation: repeat offenses lengthen the timeout; the ledger records the action", async () => {
  const ledger: any[] = [];
  const store = {
    modActionOffenseCount: async () => 1, // one prior offense in the window
    recordModAction: async (a: any) => { ledger.push(a); },
  };
  const deps = makeDeps({ store: store as any });
  const scam = makeMsg({ content: "free nitro here https://discord.gg/x" });
  assert.equal(await automodMessage(scam, deps), true);
  assert.deepEqual(scam.timeouts, [3_600_000], "offense 2 → 1h rung (scam's 10m base is outranked)");
  const row = ledger.find(a => a.targetId === "u1");
  assert.ok(row, "the action lands in the mod ledger");
  assert.equal(row.actor, "automod");
  assert.equal(row.action, "timeout");
  assert.equal(row.rule, "nitro scam");
  assert.equal(row.channelId, "c1");
  assert.match(opsAlertText(deps), /offense 2\/24h/, "the alert names the offense count");

  // A missing ledger method means first-offense behavior — under-escalate,
  // never guess at a count that wasn't read.
  const noLedger = makeDeps();
  const scam2 = makeMsg({ content: "free nitro here https://discord.gg/x", author: { id: "u2", bot: false } });
  assert.equal(await automodMessage(scam2, noLedger), true);
  assert.deepEqual(scam2.timeouts, [600_000], "no ledger → base 10m, no fabricated count");
});

test("automod escalation: 4th offense kicks; a failed kick falls back to the 24h timeout", async () => {
  const ledger: any[] = [];
  const store = {
    modActionOffenseCount: async () => 3,
    recordModAction: async (a: any) => { ledger.push(a); },
  };
  const deps = makeDeps({ store: store as any });
  const kicked: string[] = [];
  const scam = makeMsg({
    content: "free nitro https://discord.gg/x",
    member: {
      permissions: { has: () => false },
      timeout: async (ms: number) => { scam.timeouts.push(ms); },
      kick: async () => { kicked.push("kick"); },
    },
  });
  assert.equal(await automodMessage(scam, deps), true);
  assert.equal(kicked.length, 1, "offense 4 ≥ threshold → kick");
  assert.equal(scam.timeouts.length, 0, "kick replaces the timeout");
  assert.equal(ledger[0]?.action, "kick");

  // Threshold 0 disables kicking entirely — the ladder caps at 24h.
  config.automodKickThreshold = 0;
  const noKick = makeMsg({ content: "free nitro https://discord.gg/x", author: { id: "u3", bot: false } });
  assert.equal(await automodMessage(noKick, deps), true);
  assert.deepEqual(noKick.timeouts, [86_400_000], "kick disabled → 24h cap");
  config.automodKickThreshold = 4;

  // A kick that fails (perms, left-guild race) falls back to the cap.
  const failKick = makeMsg({
    content: "free nitro https://discord.gg/x",
    author: { id: "u4", bot: false },
    member: {
      permissions: { has: () => false },
      timeout: async (ms: number) => { failKick.timeouts.push(ms); },
      kick: async () => { throw new Error("missing perms"); },
    },
  });
  assert.equal(await automodMessage(failKick, deps), true);
  assert.deepEqual(failKick.timeouts, [86_400_000], "failed kick → 24h timeout fallback");
});

test("house report: category pick files the row and relays to ops with mod buttons", async () => {
  const reports: any[] = [];
  const target = { id: "m-report", content: "harassing stuff", author: { id: "u-bad", bot: false }, deleted: false,
    delete: async function () { (this as any).deleted = true; } };
  const deps = makeDeps({
    store: { reportComment: async (r: any) => { reports.push(r); return { ok: true }; } } as any,
  });
  initOps(deps);
  const updates: any[] = [];
  const ix = {
    customId: "house:reportcat:c-hub:m-report:hate",
    user: { id: "u-reporter" },
    guildId: HOUSE,
    client: { channels: { fetch: async (id: string) => id === "c-hub" ? { messages: { fetch: async () => target } } : null } },
    update: async (r: any) => { updates.push(r); return r; },
  };
  await handleHouseReportCategory(ix as any);
  assert.equal(reports.length, 1, "one report filed");
  assert.equal(reports[0].listingId, null, "house reports carry listing_id NULL");
  assert.equal(reports[0].threadId, "c-hub");
  assert.equal(reports[0].messageId, "m-report");
  assert.equal(reports[0].authorUserId, "u-bad");
  assert.equal(reports[0].reporterUserId, "u-reporter");
  assert.equal(reports[0].category, "hate");
  const relay = deps.sent.find(s => s.id === OPS);
  assert.ok(relay, "the report relays to the ops channel");
  assert.match(relay.payload.content, /house report/);
  assert.match(relay.payload.content, /<@u-bad>/);
  assert.match(JSON.stringify(relay.payload.components), /house:modmsg:(keep|del|timeout)/);
  assert.match(updates[0].content, /report is with the mods/);
});

test("house report: forged or self-report clicks refuse; resolved rows don't double-file", async () => {
  const deps = makeDeps({
    store: { reportComment: async () => ({ ok: false as const, reason: "dup" as const }) } as any,
  });
  initOps(deps);
  const target = { id: "m1", content: "x", author: { id: "u-bad", bot: false } };
  const mkIx = (customId: string, userId = "u-reporter") => ({
    customId, user: { id: userId }, guildId: HOUSE,
    client: { channels: { fetch: async () => ({ messages: { fetch: async () => target } }) } },
    update: async (r: any) => r,
    reply: async (r: any) => r,
  });
  // Unknown category falls back to "other", missing message declines, and a
  // dup row tells the reporter the team already has it.
  const dup = mkIx("house:reportcat:c1:m1:hate");
  const res = await handleHouseReportCategory(dup as any) as any;
  assert.match(res.content, /already reported/);
  // A foreign-guild forged id refuses before touching the store.
  const foreign = { ...mkIx("house:reportcat:c1:m1:hate"), guildId: "g-other" };
  const fres = await handleHouseReportCategory(foreign as any) as any;
  assert.match(fres.content, /community server/);
});

test("house modmsg: staff gate, del removes + logs, timeout edits + logs", async () => {
  const ledger: any[] = [];
  const target = { id: "m-report", content: "bad", author: { id: "u-bad" }, deleted: false,
    delete: async function () { (this as any).deleted = true; } };
  const memberEdits: any[] = [];
  const deps = makeDeps({
    store: {
      commentReportFor: async () => ({ authorUserId: "u-bad" }),
      recordModAction: async (a: any) => { ledger.push(a); },
    } as any,
  });
  initOps(deps);
  const mkIx = (customId: string, admin: boolean) => ({
    customId, user: { id: "u-mod" }, guildId: HOUSE,
    memberPermissions: { has: (f: bigint) => admin && f === PermissionFlagsBits.ManageMessages },
    guild: { members: { edit: async (id: string, o: any) => { memberEdits.push({ id, ...o }); return {}; } } },
    client: { channels: { fetch: async () => ({ messages: { fetch: async () => target } }) } },
    message: { content: "report ping" },
    update: async (r: any) => r,
    reply: async (r: any) => r,
  });
  // Non-staff can't click.
  const denied = await handleHouseModAction(mkIx("house:modmsg:del:c1:m-report:u-bad", false) as any) as any;
  assert.match(denied.content, /Moderator role required/);
  assert.equal(target.deleted, false);
  // Del removes the message and writes the ledger row.
  await handleHouseModAction(mkIx("house:modmsg:del:c1:m-report:u-bad", true) as any);
  assert.equal(target.deleted, true);
  assert.equal(ledger.at(-1)?.action, "report_del");
  assert.equal(ledger.at(-1)?.actor, "u-mod");
  // Timeout resolves the author from the report row (not the customId).
  await handleHouseModAction(mkIx("house:modmsg:timeout:c1:m-report:u-FORGED", true) as any);
  assert.equal(memberEdits[0]?.id, "u-bad", "author resolved from the report row — a forged customId gains nothing");
  assert.ok(memberEdits[0]?.communicationDisabledUntil, "10m timeout applied");
  assert.equal(ledger.at(-1)?.action, "report_timeout");
  // Keep is audited but doesn't count as an offense.
  await handleHouseModAction(mkIx("house:modmsg:keep:c1:m-report:u-bad", true) as any);
  assert.equal(ledger.at(-1)?.action, "report_keep");
});

test("/ops house renders members, tickets, automod rules and sweep health", async () => {
  const deps = makeDeps({
    listMembers: async () => [
      makeMember({ id: "u1", hasRole: true }),
      makeMember({ id: "u2" }),
    ],
    store: {
      opsStats: async () => ({ funnel: { house_join: { users: 10 }, verified: { users: 7 } } }),
      listOpenSupportTickets: async () => [{ threadId: "t1", guildId: HOUSE, openerId: "u1", subject: "s", details: "d", status: "open", openedAt: new Date(Date.now() - 3_600_000).toISOString(), closedAt: null, closerId: null, category: "bug", lastStaffReplyAt: null, staleNotifiedAt: null }],
      modActionsByRule: async () => [{ rule: "nitro scam", n: 3 }, { rule: "invite link", n: 1 }],
    } as any,
  });
  initOps(deps);
  // A registered sweep gives the Sweeps field a row — the interval never
  // fires inside the test (unref'd, cadence is minutes).
  startLinkSweep(deps);
  const ix = makeIx({ strings: { action: "house" } });
  await handleOpsCommand(ix as any);
  const fields = ix.edits[0].embeds[0].data.fields;
  const field = (n: string) => fields.find((f: any) => f.name === n)?.value ?? "";
  assert.match(field("Members"), /2 total · 1 verified/);
  assert.match(field("Funnel \(7d\)"), /join 10 → verified 7 \(70%\)/);
  assert.match(field("Tickets"), /1\*\* open/);
  assert.match(field("Automod \(24h\)"), /nitro scam 3/);
  assert.match(field("Sweeps"), /memberlinks — never ran|memberlinks — ok/);
});

test("/ops modlog renders a member's ledger history", async () => {
  const deps = makeDeps({
    store: {
      listModActionsFor: async () => [
        { id: 2, guildId: HOUSE, targetId: "u-bad", actor: "automod", action: "timeout", rule: "nitro scam", detail: "free nitro", messageId: "m1", channelId: "c1", createdAt: new Date().toISOString() },
        { id: 1, guildId: HOUSE, targetId: "u-bad", actor: "u-mod", action: "report_del", rule: null, detail: "", messageId: "m0", channelId: "c1", createdAt: new Date().toISOString() },
      ],
    } as any,
  });
  initOps(deps);
  const ix = makeIx({
    strings: { action: "modlog" },
    options: { getUser: () => ({ id: "u-bad" }) },
  });
  await handleOpsCommand(ix as any);
  const text = ix.replies[0].content;
  assert.match(text, /Mod log/);
  assert.match(text, /timeout.*automod|automod.*timeout/);
  assert.match(text, /nitro scam/);
  assert.match(text, /report_del/);
  // No target → usage hint; clean member → friendly line.
  const noUser = makeIx({ strings: { action: "modlog" }, options: { getUser: () => null } });
  await handleOpsCommand(noUser as any);
  assert.match(noUser.replies[0].content, /user.*option/i);
  const cleanDeps = makeDeps({ store: { listModActionsFor: async () => [] } as any });
  initOps(cleanDeps);
  const clean = makeIx({ strings: { action: "modlog" }, options: { getUser: () => ({ id: "u-good" }) } });
  await handleOpsCommand(clean as any);
  assert.match(clean.replies[0].content, /clean record/);
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

test("WANTED_LAYOUT: rules + log-in are read-only lobbies; #characters declares the tag taxonomy", () => {
  const system = WANTED_LAYOUT.find(g => g.category === "SYSTEM");
  assert.ok(system, "SYSTEM group exists");
  // A writable gate channel lets chatter bury the verify card past the
  // reconcile's 20-message window — these must stay locked like #welcome.
  assert.equal(system.channels.find(c => c.name === "rules")?.readOnly, "everyone");
  assert.equal(system.channels.find(c => c.name === "log-in")?.readOnly, "everyone");
  const forum = WANTED_LAYOUT.flatMap(g => g.channels).find(c => c.name === "characters");
  assert.ok(forum?.forumTags?.length, "the house forum seeds the taxonomy like partner deployments — a tagless shelf drops badges and creator picks silently");
  const names = forum!.forumTags!.map(t => t.name);
  for (const wanted of ["New", "Top Rated", "Trending", "Staff Pick"]) {
    assert.ok(names.includes(wanted), `taxonomy missing ${wanted}`);
  }
});

test("ensureHouseLayout seeds missing forum tags by name — existing tags keep their ids", async () => {
  const tagCalls: Array<Array<{ id?: string; name: string; moderated?: boolean }>> = [];
  const forum = {
    id: "c-forum", name: "characters", type: ChannelType.GuildForum, parentId: "cat-market",
    defaultForumLayout: 2, // already Gallery
    availableTags: [{ id: "tag-new", name: "New", moderated: true }],
    setAvailableTags: async (tags: any[]) => { tagCalls.push(tags); },
  };
  const existing: any[] = [
    { id: "cat-market", name: "[characterly marketplace]", type: 4 },
    forum,
  ];
  const guild = {
    id: HOUSE,
    channels: {
      cache: { find: (fn: (c: any) => boolean) => existing.find(fn) },
      create: async (o: any) => { const c = { id: `n-${existing.length}`, ...o }; existing.push(c); return c; },
    },
  };
  await ensureHouseLayout(guild as any);
  assert.equal(tagCalls.length, 1, "the missing taxonomy is merged in one write");
  const merged = tagCalls[0];
  assert.deepEqual(merged.find(t => t.name === "New"), { id: "tag-new", name: "New", moderated: true },
    "existing tags pass through with their ids — applied tags reference them");
  assert.ok(merged.some(t => t.name === "Top Rated") && merged.some(t => t.name === "Trending"),
    "missing curated names are appended");
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
    { id: "cat-market", name: "[characterly marketplace]", type: 4 },
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

/** A fully-populated house guild whose overwrite edits are recorded —
 *  `mkOw` upserts a per-role entry per channel so a second reconcile
 *  no-ops. Shared by the per-flag assertions and the full-write snapshot. */
function makeLayoutProbe() {
  const edits: Array<{ target: string; id: string; perms: Record<string, unknown> }> = [];
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
    mkCat("SYSTEM"), mkCat("[characterly marketplace]"), mkCat("RESOURCES"), mkCat("HELP"), mkCat("SERVICES"),
    mkCh("welcome", "cat-system", true),
    mkCh("announcements", "cat-system", false), mkCh("events", "cat-system", false), mkCh("updates", "cat-system", false),
    mkCh("rules", "cat-system", true), mkCh("log-in", "cat-system", true), mkCh("characterly-web", "cat-system", true),
    mkCh("characters", "cat-[characterly marketplace]", true, 15),
    mkCh("adoptees", "cat-[characterly marketplace]", true),
    ...["what-is-characterly", "what-is-companionly", "get-companionly", "privacy-policy", "how-to-publish-bots"]
      .map(n => mkCh(n, "cat-resources", true)),
    mkCh("faqs", "cat-help", true), mkCh("support-ticket", "cat-help", true), mkCh("suggest-a-feature", "cat-help", true, 15),
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
  return { guild, edits };
}

test("ensureHouseLayout denies Member typing on readOnly surfaces; synced children inherit", async () => {
  const { guild, edits } = makeLayoutProbe();

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
  for (const n of ["privacy-policy", "what-is-characterly", "what-is-companionly"]) {
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
  // Verified Members get the same open-threads grant — a stale Member deny
  // (from an older readOnly-member layout) overrides the @everyone allow and
  // silences the ticket opener; the grant must be re-written explicitly.
  const ticketMember = edits.find(e => e.target === "support-ticket" && e.id === "r-member");
  assert.ok(ticketMember, "#support-ticket needs a Member overwrite too");
  assert.equal(ticketMember!.perms.ViewChannel, true, "verified members see the ticket desk");
  assert.equal(ticketMember!.perms.SendMessagesInThreads, true, "verified openers can talk in their own ticket");
  assert.equal(ticketMember!.perms.SendMessages, false, "…but still can't post in the channel");
  assert.equal(ticketMember!.perms.CreatePrivateThreads, false, "…and can't open threads themselves");
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
  // #suggest-a-feature is the verified-only suggestion forum: hidden from
  // @everyone, Members get the full post/reply/react grant, staff moderate.
  const suggHide = edits.find(e => e.target === "suggest-a-feature" && e.id === "g-house");
  assert.ok(suggHide, "#suggest-a-feature needs its own @everyone hide");
  assert.equal(suggHide!.perms.ViewChannel, false, "unverified can't see the suggestion board");
  const suggMember = edits.find(e => e.target === "suggest-a-feature" && e.id === "r-member");
  assert.ok(suggMember, "#suggest-a-feature needs the Member forum grant");
  assert.equal(suggMember!.perms.ViewChannel, true, "verified members see the board");
  assert.equal(suggMember!.perms.CreatePublicThreads, true, "members create suggestion posts");
  assert.equal(suggMember!.perms.SendMessagesInThreads, true, "members reply inside posts");
  assert.equal(suggMember!.perms.CreatePrivateThreads, false, "…but can't open private threads");
  for (const rid of ["r-mod", "r-admin"]) {
    const e = edits.find(x => x.target === "suggest-a-feature" && x.id === rid);
    assert.ok(e, `#suggest-a-feature needs a ManageThreads allow for ${rid}`);
    assert.equal(e!.perms.ManageThreads, true, "staff moderate suggestion posts");
  }
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

test("ensureHouseLayout: the complete overwrite write set is exactly this (snapshot)", async () => {
  // Every overwrite the reconcile writes on a fully-populated house. The
  // per-flag test above asserts the writes it names — this snapshot fails on
  // ANY extra write (a silently widened channel) or ANY missing one (a deny
  // that stopped being enforced), whichever direction a layout edit drifts.
  const { guild, edits } = makeLayoutProbe();
  await ensureHouseLayout(guild as any);
  const snap = edits.map(e => `${e.target}|${e.id}|${JSON.stringify(e.perms)}`).sort();
  assert.deepEqual(snap, [
    'adoptees|g-house|{"ViewChannel":false,"SendMessages":false,"SendMessagesInThreads":false,"CreatePublicThreads":false,"CreatePrivateThreads":false}',
    'adoptees|r-admin|{"ViewChannel":true,"SendMessagesInThreads":true,"ManageThreads":true}',
    'adoptees|r-member|{"ViewChannel":true,"SendMessagesInThreads":true,"SendMessages":false,"CreatePublicThreads":false,"CreatePrivateThreads":false}',
    'announcements|r-member|{"ViewChannel":true,"SendMessages":false,"SendMessagesInThreads":false,"CreatePublicThreads":false,"CreatePrivateThreads":false}',
    'cat:HELP|r-member|{"ViewChannel":true,"SendMessages":false,"SendMessagesInThreads":false,"CreatePublicThreads":false,"CreatePrivateThreads":false}',
    'cat:RESOURCES|g-house|{"ViewChannel":true,"SendMessages":false,"SendMessagesInThreads":false,"CreatePublicThreads":false,"CreatePrivateThreads":false}',
    'characterly-web|g-house|{"ViewChannel":true,"SendMessages":false,"SendMessagesInThreads":false,"CreatePublicThreads":false,"CreatePrivateThreads":false}',
    'characterly-web|r-admin|{"ViewChannel":true,"SendMessages":true,"SendMessagesInThreads":true}',
    'characterly-web|r-mod|{"ViewChannel":true,"SendMessages":true,"SendMessagesInThreads":true}',
    'events|r-member|{"ViewChannel":true,"SendMessages":false,"SendMessagesInThreads":false,"CreatePublicThreads":false,"CreatePrivateThreads":false}',
    'faqs|g-house|{"ViewChannel":true,"SendMessages":false,"SendMessagesInThreads":false,"CreatePublicThreads":false,"CreatePrivateThreads":false}',
    'get-companionly|g-house|{"ViewChannel":false,"SendMessages":false,"SendMessagesInThreads":false,"CreatePublicThreads":false,"CreatePrivateThreads":false}',
    'how-to-publish-bots|g-house|{"ViewChannel":false,"SendMessages":false,"SendMessagesInThreads":false,"CreatePublicThreads":false,"CreatePrivateThreads":false}',
    'log-in|g-house|{"ViewChannel":true,"SendMessages":false,"SendMessagesInThreads":false,"CreatePublicThreads":false,"CreatePrivateThreads":false}',
    'rules|g-house|{"ViewChannel":true,"SendMessages":false,"SendMessagesInThreads":false,"CreatePublicThreads":false,"CreatePrivateThreads":false}',
    'suggest-a-feature|g-house|{"ViewChannel":false,"SendMessages":false,"SendMessagesInThreads":false,"CreatePublicThreads":false,"CreatePrivateThreads":false}',
    'suggest-a-feature|r-admin|{"ViewChannel":true,"SendMessagesInThreads":true,"ManageThreads":true}',
    'suggest-a-feature|r-member|{"ViewChannel":true,"SendMessages":true,"SendMessagesInThreads":true,"CreatePublicThreads":true,"CreatePrivateThreads":false}',
    'suggest-a-feature|r-mod|{"ViewChannel":true,"SendMessagesInThreads":true,"ManageThreads":true}',
    'support-ticket|g-house|{"ViewChannel":true,"SendMessagesInThreads":true,"SendMessages":false,"CreatePublicThreads":false,"CreatePrivateThreads":false}',
    'support-ticket|r-admin|{"ViewChannel":true,"SendMessagesInThreads":true,"ManageThreads":true}',
    'support-ticket|r-member|{"ViewChannel":true,"SendMessagesInThreads":true,"SendMessages":false,"CreatePublicThreads":false,"CreatePrivateThreads":false}',
    'support-ticket|r-mod|{"ViewChannel":true,"SendMessagesInThreads":true,"ManageThreads":true}',
    'updates|r-member|{"ViewChannel":true,"SendMessages":false,"SendMessagesInThreads":false,"CreatePublicThreads":false,"CreatePrivateThreads":false}',
    'welcome|g-house|{"ViewChannel":true,"SendMessages":false,"SendMessagesInThreads":false,"CreatePublicThreads":false,"CreatePrivateThreads":false}',
  ].sort());
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
        [adoptees, { id: "cat-market", name: "[characterly marketplace]", type: 4 }].find(fn) },
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
    createSupportTicket: async (g: string, uid: string, tid: string, subject: string, details: string, category = "other") => {
      if (openByUser.has(uid)) return null; // partial-unique-index semantics
      const t = { threadId: tid, guildId: g, openerId: uid, subject, details, status: "open", openedAt: new Date().toISOString(), closedAt: null, closerId: null, category, lastStaffReplyAt: null, staleNotifiedAt: null };
      byThread.set(tid, t); openByUser.set(uid, tid);
      return t;
    },
    closeSupportTicket: async (tid: string, uid: string) => {
      const t = byThread.get(tid);
      if (t?.status === "open") { t.status = "closed"; t.closerId = uid; openByUser.delete(t.openerId); }
    },
    listOpenSupportTickets: async (g: string) => [...byThread.values()].filter(t => t.guildId === g && t.status === "open"),
    markTicketStaffReply: async (tid: string) => {
      const t = byThread.get(tid);
      if (t?.status === "open") t.lastStaffReplyAt = new Date().toISOString();
    },
    listStaleUnansweredTickets: async (g: string, staleMs: number) =>
      [...byThread.values()].filter(t => t.guildId === g && t.status === "open" && !t.staleNotifiedAt && !t.lastStaffReplyAt
        && Date.now() - Date.parse(t.openedAt) > staleMs),
    markTicketStaleNotified: async (tid: string) => {
      const t = byThread.get(tid);
      if (t) t.staleNotifiedAt = new Date().toISOString();
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

test("ticket:open — category picker then the modal; existing ticket + lookup error refused", async () => {
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
  const picker = replies.at(-1);
  assert.ok(picker?.ephemeral, "picker is ephemeral");
  assert.match(picker.content, /What's the ticket about/);
  assert.ok(JSON.stringify(picker.components).includes("ticket:opencat:billing"), "picker carries category buttons");

  // A category pick shows the intake modal carrying that category.
  await handleTicketButton({ ...ix, customId: "ticket:opencat:billing" } as any);
  assert.deepEqual(modals, ["ticket:new:billing"], "opencat click shows the categorized modal");

  // An unknown category slug falls back to 'other' — customIds are forgeable.
  await handleTicketButton({ ...ix, customId: "ticket:opencat:hax" } as any);
  assert.deepEqual(modals[1], "ticket:new:other");

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
  assert.equal((ticket as any)?.category, "other", "bare legacy modal id files as 'other'");
  const alert = sent.find(s => s.id === OPS);
  assert.ok(alert, "ops channel got the staff ping");
  assert.match(alert!.payload.content, /Something else ticket/);
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

test("ticket:close — a DB failure leaves the thread open for retry (the survivable divergence)", async () => {
  const { deps } = ticketWorld();
  await deps.store.createSupportTicket(HOUSE, "u1", "t-1", "help", "pls");
  (deps.store as any).closeSupportTicket = async () => { throw new Error("db is down"); };
  initOps(deps);
  const state = { locked: false, archived: false, replies: [] as any[] };
  const ix = {
    customId: "ticket:close", guildId: HOUSE, user: { id: "u1" },
    channel: {
      id: "t-1", isThread: () => true,
      send: async () => {},
      setLocked: async (v: boolean) => { state.locked = v; },
      setArchived: async (v: boolean) => { state.archived = v; },
    },
    memberPermissions: { has: () => false },
    update: async () => {},
    reply: async (r: any) => { state.replies.push(r); return r; },
  };
  await handleTicketButton(ix as any);
  assert.match(state.replies[0].content, /try again in a moment/);
  // Row-open + thread-sealed is the unrecoverable side (the dedupe check
  // would point at a dead thread forever) — sealing must wait on the row.
  assert.equal(state.locked, false, "thread stays open");
  assert.equal(state.archived, false);
  assert.equal((await deps.store.supportTicketByThread("t-1"))?.status, "open");
});

test("ticket:close — unknown ticket:* ids answer instead of failing silently", async () => {
  const { deps } = ticketWorld();
  initOps(deps);
  const replies: any[] = [];
  await handleTicketButton({ customId: "ticket:bogus", guildId: HOUSE, user: { id: "u1" }, reply: async (r: any) => { replies.push(r); return r; } } as any);
  assert.match(replies[0].content, /stale/);
});

test("ticket reaper: open rows with dead threads close; live threads with no row seal; mid-create threads are skipped", async () => {
  const { deps } = ticketWorld();
  const store = deps.store as any;
  // Row-open + thread-gone — a mod deleted the thread out from under the
  // row, which would otherwise block the opener from ever filing again.
  await store.createSupportTicket(HOUSE, "u1", "t-dead", "gone", "pls");
  // Row-less live thread past the create grace — a create-side failure left
  // it standing; the reaper seals it.
  const orphan = { id: "t-orphan", createdTimestamp: Date.now() - 30 * 60_000, locked: false, archived: false,
    setLocked: async (v: boolean) => { orphan.locked = v; }, setArchived: async (v: boolean) => { orphan.archived = v; } };
  // A thread mid-create looks row-less too — the grace window skips it.
  const fresh = { id: "t-fresh", createdTimestamp: Date.now(), locked: false, archived: false,
    setLocked: async (v: boolean) => { fresh.locked = v; }, setArchived: async (v: boolean) => { fresh.archived = v; } };
  // Open + thread live — untouched.
  await store.createSupportTicket(HOUSE, "u2", "t-live", "hi", "pls");
  const live = { id: "t-live", createdTimestamp: Date.now() - 30 * 60_000, locked: false, archived: false,
    setLocked: async (v: boolean) => { live.locked = v; }, setArchived: async (v: boolean) => { live.archived = v; } };
  deps.fetchChannel = async (id: string) => id === "c-support-ticket"
    ? { id, send: async () => {}, threads: { fetchActive: async () => ({ threads: [orphan, fresh, live] }) } } as any
    : id === "t-live" ? live as any
    : id === "t-dead" ? null // the dead thread resolves nothing — that's the divergence being reaped
    : { id, send: async (p: any) => { deps.sent.push({ id, payload: p }); } } as any; // ops channel + anything else
  await reapOrphanTicketThreads(deps);
  assert.equal((await store.supportTicketByThread("t-dead"))?.status, "closed", "dead-thread row closes so the opener can file again");
  assert.equal(orphan.locked && orphan.archived, true, "the row-less live thread is sealed");
  assert.equal(fresh.locked, false, "a thread younger than the create grace is left alone");
  assert.equal(live.locked, false, "a live ticket's thread is untouched");
  assert.match(opsAlertText(deps), /Ticket reaped/);
});

test("ticket modal — category rides the modal customId into the row + ping", async () => {
  const thread = mkTicketThread();
  const sent: Array<{ id: string; payload: any }> = [];
  const { deps } = ticketWorld({ thread, sent });
  initOps(deps);
  const ix = mkModalIx({ subject: "Refund please", details: "Charged twice" }, { customId: "ticket:new:billing" });
  await handleTicketModal(ix as any);

  const ticket = await deps.store.openSupportTicketFor("u1") as any;
  assert.equal(ticket?.category, "billing", "category persisted on the row");
  assert.match(JSON.stringify(thread.state.sent[0].embeds), /Billing & credits ticket/, "thread embed labels the category");
  assert.match(sent.find(s => s.id === OPS)!.payload.content, /Billing & credits ticket/, "ops ping labels the category");

  // A forged slug in the modal id is allowlisted back to 'other'.
  const ix2 = mkModalIx({ subject: "x", details: "y" }, { customId: "ticket:new:hax", user: { id: "u2", username: "Bob" } });
  await handleTicketModal(ix2 as any);
  assert.equal(((await deps.store.openSupportTicketFor("u2")) as any)?.category, "other");
});

test("ticket modal — FAQ keywords drop the matching resource post into the thread", async () => {
  const thread = mkTicketThread();
  const { deps } = ticketWorld({ thread });
  initOps(deps);
  await handleTicketModal(mkModalIx({ subject: "refund my credits", details: "charged twice" }) as any);
  assert.equal(thread.state.sent.length, 2, "opener card + FAQ hint");
  assert.match(thread.state.sent[1].content, /While you wait/);
  assert.ok(thread.state.sent[1].embeds?.length > 0, "hint carries the resource embed");

  // No keyword → no extra post.
  const t2 = mkTicketThread();
  const { deps: deps2 } = ticketWorld({ thread: t2 });
  initOps(deps2);
  await handleTicketModal(mkModalIx({ subject: "weird edge case", details: "something unique" }, { user: { id: "u9" } }) as any);
  assert.equal(t2.state.sent.length, 1, "no hint for unmatched subjects");
});

test("noteTicketStaffReply — staff posts stamp the row; members + other threads don't", async () => {
  const { deps } = ticketWorld();
  const store = deps.store as any;
  await store.createSupportTicket(HOUSE, "u1", "t-1", "help", "pls");

  const staffMsg = {
    guildId: HOUSE, channelId: "t-1", author: { id: "u-mod", bot: false },
    member: { permissionsIn: () => ({ has: (f: bigint) => f === PermissionFlagsBits.ManageThreads }) },
    channel: { type: ChannelType.PrivateThread, parent: { name: "support-ticket" } },
  };
  await noteTicketStaffReply(staffMsg as any, deps);
  assert.ok((await store.supportTicketByThread("t-1")).lastStaffReplyAt, "a staff post marks the ticket answered");

  // A member (no staff perms) posting doesn't stamp — they aren't staff.
  await store.createSupportTicket(HOUSE, "u2", "t-2", "help", "pls");
  const memberMsg = { ...staffMsg, channelId: "t-2", member: { permissionsIn: () => ({ has: () => false }) } };
  await noteTicketStaffReply(memberMsg as any, deps);
  assert.equal((await store.supportTicketByThread("t-2")).lastStaffReplyAt, null);

  // A staff post outside the ticket channel's threads doesn't stamp either.
  const wrong = { ...staffMsg, channelId: "t-3", channel: { type: ChannelType.PrivateThread, parent: { name: "adoptees" } } };
  await noteTicketStaffReply(wrong as any, deps);
  assert.equal(await store.supportTicketByThread("t-3"), null, "no row exists — but even the lookup never ran");
});

test("ticket reaper — stale unanswered tickets ping ops once", async () => {
  const { deps } = ticketWorld();
  const store = deps.store as any;
  await store.createSupportTicket(HOUSE, "u1", "t-stale", "unanswered", "pls");
  (await store.supportTicketByThread("t-stale")).openedAt = new Date(Date.now() - 80 * 3_600_000).toISOString(); // 80h old
  // An answered old ticket isn't stale.
  await store.createSupportTicket(HOUSE, "u2", "t-answered", "done", "pls");
  const answered = await store.supportTicketByThread("t-answered");
  answered.openedAt = new Date(Date.now() - 80 * 3_600_000).toISOString();
  answered.lastStaffReplyAt = new Date().toISOString();

  deps.fetchChannel = async (id: string) => id === "c-support-ticket"
    ? { id, send: async () => {}, threads: { fetchActive: async () => ({ threads: [] }) } } as any
    : id === "t-stale" || id === "t-answered" ? { id } as any
    : { id, send: async (p: any) => { deps.sent.push({ id, payload: p }); } } as any;

  await reapOrphanTicketThreads(deps);
  assert.match(opsAlertText(deps), /Ticket unanswered/, "ops pinged about the stale ticket");
  assert.ok((await store.supportTicketByThread("t-stale")).staleNotifiedAt, "marked so it doesn't re-ping");

  deps.sent.length = 0;
  await reapOrphanTicketThreads(deps);
  assert.doesNotMatch(opsAlertText(deps), /Ticket unanswered/, "second sweep stays quiet");
});

test("verify nudge — unverified >24h members get one DM, once ever", async () => {
  const sentDMs: string[] = [];
  const events: Array<[string, string]> = [];
  const old = (d: number) => Date.now() - d * 3_600_000;
  const stale = makeMember({ id: "u-stale" });
  stale.joinedTimestamp = old(48);
  stale.send = async () => { sentDMs.push("u-stale"); };
  const fresh = makeMember({ id: "u-fresh" });
  fresh.joinedTimestamp = old(2); // under 24h — skip
  fresh.send = async () => { sentDMs.push("u-fresh"); };
  const verified = makeMember({ id: "u-ver", hasRole: true });
  verified.joinedTimestamp = old(48);
  verified.send = async () => { sentDMs.push("u-ver"); };
  const closedDM = makeMember({ id: "u-closed" });
  closedDM.joinedTimestamp = old(48);
  closedDM.send = async () => { throw new Error("Cannot send messages to this user"); };
  const already = makeMember({ id: "u-already" });
  already.joinedTimestamp = old(48);
  already.send = async () => { sentDMs.push("u-already"); };
  const optedOut = makeMember({ id: "u-opt" });
  optedOut.joinedTimestamp = old(48);
  optedOut.send = async () => { sentDMs.push("u-opt"); };

  const deps = makeDeps({
    listMembers: async () => [stale, fresh, verified, closedDM, already, optedOut],
    store: {
      trackEvent: async (u: string, e: string) => { events.push([u, e]); },
      hasAnalyticsEvent: async (u: string) => u === "u-already",
      analyticsOptedOut: async (u: string) => u === "u-opt",
    } as unknown as MemoryStore,
  });
  await runVerifyNudgeSweep(deps);
  assert.deepEqual(sentDMs, ["u-stale"], "only the old unverified member with open DMs is messaged");
  assert.deepEqual(events.filter(e => e[1] === "verify_nudge").map(e => e[0]).sort(), ["u-closed", "u-stale"],
    "closed-DM users still mark once-ever — retrying is pointless");

  // Once-ever: a second sweep sends nothing (u-stale now has the event).
  const store2 = deps.store as any;
  store2.hasAnalyticsEvent = async (u: string) => u === "u-already" || u === "u-stale" || u === "u-closed";
  await runVerifyNudgeSweep(deps);
  assert.deepEqual(sentDMs, ["u-stale"], "no repeat DMs");

  // Missing dedupe methods on a partial store → the sweep degrades to a no-op.
  await runVerifyNudgeSweep(makeDeps({ listMembers: async () => [stale] }));
  assert.deepEqual(sentDMs, ["u-stale"], "partial store ⇒ no-op, never a blind DM");
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

test("/ops guide applies the Server Guide by channel name — featured order, prompt, description", async () => {
  const applied: any[] = [];
  const described: string[] = [];
  const chans = [
    { id: "c-welcome", name: "welcome", type: 0 },
    { id: "c-login", name: "log-in", type: 0 },
    { id: "c-get", name: "get-companionly", type: 0 },
    { id: "c-chars", name: "characters", type: 15 },
    { id: "c-hub", name: "the-hub", type: 0 },
    { id: "c-what", name: "what-is-characterly", type: 0 },
    { id: "c-pub", name: "how-to-publish-bots", type: 0 },
    { id: "c-bar", name: "sitting at a bar", type: 2 }, // voice channel, spaced name
  ];
  const guild = {
    id: HOUSE,
    channels: { cache: { find: (fn: (c: any) => boolean) => chans.find(fn) } },
    editOnboarding: async (o: any) => { applied.push(o); return o; },
    setDescription: async (d: string) => { described.push(d); return null; },
  };
  initOps(makeDeps({ fetchGuild: async () => guild as never }));
  const ix = makeIx({ strings: { action: "guide" } });
  await handleOpsCommand(ix as any);

  assert.equal(applied.length, 1);
  const opts = applied[0];
  assert.equal(opts.enabled, true);
  assert.equal(opts.mode, 1, "OnboardingAdvanced");
  assert.deepEqual(opts.defaultChannels,
    ["c-welcome", "c-login", "c-get", "c-chars", "c-hub", "c-what"],
    "featured channels in funnel order");
  assert.equal(opts.prompts.length, 1);
  const prompt = opts.prompts[0];
  assert.match(prompt.title, /brings you/i);
  assert.equal(prompt.singleSelect, true);
  assert.equal(prompt.options.length, 4);
  assert.deepEqual(prompt.options[0].channels, ["c-get", "c-what"], "meet → get-companionly + explainer");
  assert.deepEqual(prompt.options[3].channels, ["c-hub", "c-bar"], "social → hub + voice");
  assert.equal(described.length, 1, "guild description set for the guide page");
  assert.match(ix.replies[0].content, /applied/i);
  assert.match(ix.replies[0].content, /description set/i);
});

test("/ops guide reports unresolvable channels without failing the apply", async () => {
  const applied: any[] = [];
  const chans = [{ id: "c-welcome", name: "welcome", type: 0 }]; // everything else missing
  const guild = {
    id: HOUSE,
    channels: { cache: { find: (fn: (c: any) => boolean) => chans.find(fn) } },
    editOnboarding: async (o: any) => { applied.push(o); return o; },
    // no setDescription — fakes may omit it; apply must tolerate
  };
  initOps(makeDeps({ fetchGuild: async () => guild as never }));
  const ix = makeIx({ strings: { action: "guide" } });
  await handleOpsCommand(ix as any);

  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].defaultChannels, ["c-welcome"]);
  assert.match(ix.replies[0].content, /unresolved channels.*#log-in/i);
  assert.match(ix.replies[0].content, /#the-hub/i);
});

test("/ops guide refuses cleanly when the guild rejects the onboarding patch", async () => {
  const guild = {
    id: HOUSE,
    channels: { cache: { find: () => undefined } },
    editOnboarding: async () => { throw new Error("onboarding not available"); },
  };
  initOps(makeDeps({ fetchGuild: async () => guild as never }));
  const ix = makeIx({ strings: { action: "guide" } });
  await handleOpsCommand(ix as any);
  assert.match(ix.replies[0].content, /failed/i);
});

test("/ops stats defers and renders the funnel embed; non-operators refused", async () => {
  const stats = {
    dauDm: 4, dauGuilds: 2, wauDm: 9, wauGuilds: 5, llmToday: 120, hostedToday: 80,
    installs: 6, greeted: 5, deauthorized: 1, linkClaims: 3, adopted: 2, dropped: 1,
    funnel: {
      onboard_start: { events: 5, users: 4 }, awaken: { events: 3, users: 3 },
      summon: { events: 2, users: 2 }, summon_deadend: { events: 1, users: 1 },
      house_join: { events: 4, users: 4 }, verified: { events: 3, users: 3 },
    },
    tokens: { spent: 200, purchased: 750, spenders: 3, premium: 2 },
    topCounters: [{ name: "install.greeted", total: 5 }],
  };
  initOps(makeDeps({ store: { opsStats: async () => stats, trackEvent: async () => {} } as unknown as MemoryStore }));
  const ix = makeIx({ strings: { action: "stats" } });
  await handleOpsCommand(ix as any);
  const embed = ix.edits[0]?.embeds?.[0];
  assert.match(embed?.data?.title ?? "", /stats/i);
  const funnel = embed.data.fields?.find((f: any) => /funnel/i.test(f.name));
  assert.match(funnel?.value ?? "", /install 6 .*greeted 5 .*awaken 3/s);
  const tokens = embed.data.fields?.find((f: any) => /tokens/i.test(f.name));
  assert.match(tokens?.value ?? "", /200 spent/);

  const stranger = makeIx({ ix: { user: { id: "u-rando" } }, strings: { action: "stats" } });
  await handleOpsCommand(stranger as any);
  assert.match(stranger.replies[0].content, /restricted/);
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
  assert.ok(
    cmds.some(c => c.includes("git pull --ff-only") && c.includes("npm ci") && c.includes("npm run build")),
    "deploy runs pull+ci+build — npm start runs dist/, so a build must land before the exit-restart",
  );
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
      listActiveListingPosts: async () => [],
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
      setListingPost: async () => true,
      setListingPostFailed: async () => true,
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
      setAdoptionLocation: async (a: number, loc: { threadId?: string | null }) => { stamped.push([a, loc.threadId ?? ""]); },
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
  const saved = { a: config.houseAdopteesChannelId, g: config.houseGuildId };
  config.houseAdopteesChannelId = undefined;
  config.houseGuildId = "g-house";
  try {
    // The name fallback only fires in the house guild — a foreign server's
    // "adoptees" channel is just a channel, not our surface.
    assert.equal(isAdopteeThread({ isThread: () => true, guildId: "g-house", parent: { name: "#Adoptees" } }), true);
    assert.equal(isAdopteeThread({ isThread: () => true, guildId: "g-house", parent: { name: "support-ticket" } }), false);
    assert.equal(isAdopteeThread({ isThread: () => true, guildId: "g-other", parent: { name: "#Adoptees" } }), false);
    assert.equal(isAdopteeThread({ isThread: () => true, parent: { name: "#Adoptees" } }), false, "no guild context → no match");
  } finally { config.houseAdopteesChannelId = saved.a; config.houseGuildId = saved.g; }
});

test("ensureAdopteeThread: creates a named private thread, adds the adopter, greets, stamps", async () => {
  const { deps, thread, created, stamped, introduced } = adopteeDeps();
  // allowCreate = the Meet surfaces' chat intent — healers pass nothing.
  const res = await ensureAdopteeThread(deps, adopteeFixture({ allowCreate: true }) as never);
  assert.ok("thread" in res && res.created);
  assert.equal(created.length, 1);
  assert.equal(created[0].type, 12); // ChannelType.PrivateThread
  assert.equal(created[0].invitable, false);
  // 3-day auto-archive — the recycler for the guild's ~1,000 active slots.
  assert.equal(created[0].autoArchiveDuration, 4320);
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
  const res = await ensureAdopteeThread(deps, adopteeFixture({ allowCreate: true }) as never);
  assert.deepEqual(res, { needsInvite: true });
  assert.equal(created.length, 0);
  assert.equal(stamped.length, 0);
});

test("ensureAdopteeThread: never-met adoptions defer — only explicit chat intent creates", async () => {
  const { deps, created, stamped } = adopteeDeps();
  // Deferred creation: a fresh adoption (no thread, never introduced) without
  // allowCreate defers instead of spending a thread slot. This guard is what
  // keeps healers (backfill, member-join, roster sweeps) from silently
  // materializing rooms for adopt-and-bounce users.
  const deferred = await ensureAdopteeThread(deps, adopteeFixture() as never);
  assert.deepEqual(deferred, { deferred: true });
  assert.equal(created.length, 0);
  assert.equal(stamped.length, 0);

  // An introduced adoption missing its thread (deleted) rebuilds without
  // allowCreate — the room once existed and the adopter already met them.
  const met = adopteeFixture({
    adoption: { ...adopteeFixture().adoption, dmIntroducedAt: "2024-01-01T00:00:00Z" },
  });
  const rebuilt = await ensureAdopteeThread(deps, met as never);
  assert.ok("thread" in rebuilt && rebuilt.created, "met adopter's missing thread is rebuilt");
  assert.equal(created.length, 1);
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

test("ensureAdopteeThread: manage-row detection checks pins — a scrolled-out row isn't duplicated", async () => {
  // The row is pinned — scanning the last N messages misses it on a busy
  // thread and posted a duplicate. fetchPinned is the dup-proof check.
  const live = makeAdopteeThread("t-pins");
  const pinnedRow = {
    id: "m-pin", pinned: true,
    components: [{ components: [{ custom_id: "market:drop:11" }] }],
    pin: async () => {},
  };
  (live as { messages: object }).messages = {
    fetch: async () => [], // scrolled out of the recent window
    fetchPinned: async () => [pinnedRow],
  };
  const { deps } = adopteeDeps({ channels: { "t-pins": live } });
  const fixture = adopteeFixture();
  (fixture.adoption as { chatThreadId: string | null }).chatThreadId = "t-pins";
  const res = await ensureAdopteeThread(deps, { ...fixture, reopen: true } as never);
  assert.ok("thread" in res);
  assert.equal(live.sentPayloads.length, 0, "the pinned row was seen — no duplicate posted");
});

test("ensureAdopteeThread: member-add failure tears the thread down and fails", async () => {
  const thread = makeAdopteeThread("t-bad", { addFails: true });
  const { deps, stamped } = adopteeDeps({ thread });
  const res = await ensureAdopteeThread(deps, adopteeFixture({ allowCreate: true }) as never);
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

test("ensureAdopteeThread: a dead partner deployment relocates the adoption to the house", async () => {
  const created: Array<Record<string, unknown>> = [];
  const stamped: Array<[number, string]> = [];
  const cleared: Array<[number, unknown]> = [];
  const thread = makeAdopteeThread("t-home");
  const { deps } = adopteeDeps({ thread, created, stamped });
  (deps.store as { setAdoptionLocation(a: number, loc: unknown): Promise<void> })
    .setAdoptionLocation = async (a, loc) => {
      cleared.push([a, loc]);
      const t = (loc as { threadId?: string | null }).threadId;
      if (t) stamped.push([a, t]);
    };
  // The adoption is homed in a partner guild that no longer has a live
  // deployment (revoked/purged) — ensure must collapse it to the house and
  // build the thread there instead of failing or re-homing dead.
  const fixture = adopteeFixture({ allowCreate: true });
  (fixture.adoption as unknown as { chatGuildId: string | null }).chatGuildId = "g-partner";
  const res = await ensureAdopteeThread(deps, fixture as never);
  assert.ok("thread" in res && res.created, "house thread created after relocation");
  assert.equal(created.length, 1);
  // First stamp clears the partner location, second writes the house home.
  const clear = cleared.find(([, loc]) => (loc as { guildId?: string | null }).guildId === null && (loc as { threadId?: string | null }).threadId === null);
  assert.ok(clear, "partner location cleared during relocation");
  assert.deepEqual(stamped, [[7, "t-home"]]);
});

test("ensureAdopteeThread: a live thread in a DISABLED deployment seals + relocates, never reuses", async () => {
  // The membership check alone isn't enough — a deployment row disabled
  // outside removeDeployment (manual SQL, a status flip) leaves an open
  // thread whose channel stopped matching isAdopteeThread. Reusing it would
  // drop DM-scope chat into the normal guild pipeline where partner admins
  // read it. The live branch must check deployment status too.
  const stranded = makeAdopteeThread("t-dead-host");
  const created: Array<Record<string, unknown>> = [];
  const stamped: Array<[number, string]> = [];
  const cleared: Array<[number, unknown]> = [];
  const thread = makeAdopteeThread("t-home2");
  const { deps } = adopteeDeps({ thread, created, stamped, channels: { "t-dead-host": stranded } });
  (deps.store as { setAdoptionLocation(a: number, loc: unknown): Promise<void> })
    .setAdoptionLocation = async (a, loc) => {
      cleared.push([a, loc]);
      const t = (loc as { threadId?: string | null }).threadId;
      if (t) stamped.push([a, t]);
    };
  (deps.store as { deployments(): Promise<unknown[]> }).deployments = async () => [
    { guildId: "g-partner", status: "disabled", marketplaceChannelId: "c-x", adopteesChannelId: "c-ad" },
  ];
  await refreshDeploymentCache(deps.store);
  const fixture = adopteeFixture({ allowCreate: true });
  (fixture.adoption as unknown as { chatGuildId: string | null }).chatGuildId = "g-partner";
  (fixture.adoption as unknown as { chatThreadId: string | null }).chatThreadId = "t-dead-host";
  const res = await ensureAdopteeThread(deps, fixture as never);
  assert.equal(stranded.locked, true, "the stranded thread is locked");
  assert.equal(stranded.archived, true, "and archived — partner admins don't keep reading it");
  assert.ok("thread" in res && res.created, "a fresh thread is built in the house");
  assert.equal(created.length, 1);
  assert.deepEqual(stamped, [[7, "t-home2"]]);
});

test("backfillAdopteeThreads: creates threads for members, skips non-members", async () => {
  const created: Array<Record<string, unknown>> = [];
  const stamped: Array<[number, string]> = [];
  // Missing = once existed — introduced rows whose thread is now gone.
  // Deferred (never-met) adoptions are filtered by the query's
  // dm_introduced_at predicate AND refused by ensure's allowCreate guard.
  const missing = [
    { ...adopteeFixture(), adoption: { ...adopteeFixture().adoption, id: 7, dmIntroducedAt: "2024-01-01T00:00:00Z" } },
    { ...adopteeFixture(), adoption: { ...adopteeFixture().adoption, id: 8, userId: "u-gone", dmIntroducedAt: "2024-01-01T00:00:00Z" } },
  ];
  const thread = makeAdopteeThread("t-bf");
  const { deps } = adopteeDeps({ thread, created, stamped, missingRows: missing });
  // u-adopter is a member; u-gone isn't.
  deps.fetchMember = async (_g: string, uid: string) => uid === "u-adopter" ? makeMember({ id: uid }) : null;
  await backfillAdopteeThreads(deps);
  assert.equal(created.length, 1);
  assert.deepEqual(stamped, [[7, "t-bf"]]);
});

test("house member add: met adoptees missing threads get them rebuilt on join", async () => {
  const created: Array<Record<string, unknown>> = [];
  const stamped: Array<[number, string]> = [];
  const thread = makeAdopteeThread("t-join");
  // Once-met adoption whose thread is gone — the join hook rebuilds it.
  const missing = [{ ...adopteeFixture({ adoption: { ...adopteeFixture().adoption, dmIntroducedAt: "2024-01-01T00:00:00Z" } }), username: "Joiner" }];
  const { deps } = adopteeDeps({ thread, created, stamped });
  (deps.store as { activeAdoptionsForUser(uid: string): Promise<unknown[]> })
    .activeAdoptionsForUser = async uid => uid === "u-adopter" ? missing : [];
  const m = makeMember({ id: "u-adopter" });
  await handleHouseMemberAdd(m, deps);
  assert.equal(created.length, 1);
  assert.deepEqual(stamped, [[7, "t-join"]]);
});

test("house member add: deferred (never-met) adoptees stay threadless on join", async () => {
  const created: Array<Record<string, unknown>> = [];
  const thread = makeAdopteeThread("t-join");
  // Deferred creation: an adoption adopted but never met has no thread and
  // keeps none after a join — only the Meet click spends the thread slot.
  const unmet = [{ ...adopteeFixture(), username: "Joiner" }];
  const { deps } = adopteeDeps({ thread, created });
  (deps.store as { activeAdoptionsForUser(uid: string): Promise<unknown[]> })
    .activeAdoptionsForUser = async uid => uid === "u-adopter" ? unmet : [];
  await handleHouseMemberAdd(makeMember({ id: "u-adopter" }), deps);
  assert.equal(created.length, 0, "join must not materialize a deferred room");
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

test("house member update: an uncached oldMember (roles unknown) does NOT trigger the adoptee sweep", async () => {
  // oldMember arrives without `roles` when the member wasn't cached — that's
  // UNKNOWN state, not "no role held". Treating it as a transition re-ran
  // the adoptee-ensure sweep on every unrelated update (nickname, timeout)
  // of every verified member.
  let ensureCalls = 0;
  const { deps } = adopteeDeps();
  (deps.store as { activeAdoptionsForUser(u: string): Promise<unknown[]> })
    .activeAdoptionsForUser = async () => { ensureCalls++; return []; };
  const partialOld = { pending: false }; // no `roles` — the uncached shape
  await handleHouseMemberUpdate(partialOld as any, makeMember({ id: "u-adopter", hasRole: true }), deps);
  assert.equal(ensureCalls, 0, "unknown old role state isn't a transition — the backfill sweep covers the rare real grant");
});

// ── Deployment lifecycle (v59) ───────────────────────────────────────────────

test("rejoining adopters get their thread UNLOCKED — leave locks it, rejoin must reverse both halves", async () => {
  // handleDeploymentMemberRemove locks+archives; the rejoin path used to
  // unarchive but left the lock — the member could read but never type.
  const live = makeAdopteeThread("t-rejoin");
  live.locked = true;
  live.archived = true;
  const created: Array<Record<string, unknown>> = [];
  const { deps } = adopteeDeps({ created, channels: { "t-rejoin": live } });
  const adoption = { ...adopteeFixture().adoption, chatThreadId: "t-rejoin" };
  const rows = [{ ...adopteeFixture({ adoption }), username: "Joiner" }];
  (deps.store as { activeAdoptionsForUser(uid: string): Promise<unknown[]> })
    .activeAdoptionsForUser = async uid => uid === "u-adopter" ? rows : [];
  await handleHouseMemberAdd(makeMember({ id: "u-adopter" }), deps);
  assert.equal(created.length, 0, "existing thread reattached, not rebuilt");
  assert.deepEqual(live.addedMembers, ["u-adopter"]);
  assert.equal(live.archived, false);
  assert.equal(live.locked, false, "the member-leave lock is released on rejoin");
});

test("removeDeployment: hosted adoptee threads seal and rehome — partner admins can't keep reading private chats", async () => {
  const thread = makeAdopteeThread("t-hosted");
  const located: Array<[number, unknown]> = [];
  const statuses: string[] = [];
  const { deps } = adopteeDeps({ channels: { "t-hosted": thread } });
  (deps.store as any).deploymentFor = async () => ({ guildId: "g-partner", status: "active" });
  (deps.store as any).setDeploymentStatus = async (_g: string, s: string) => { statuses.push(s); };
  (deps.store as any).listingPostsForGuild = async () => [];
  (deps.store as any).adoptionsInGuild = async () => [{ id: 7, userId: "u-adopter", chatThreadId: "t-hosted" }];
  (deps.store as any).setAdoptionLocation = async (a: number, loc: unknown) => { located.push([a, loc]); };
  (deps.store as any).deployments = async () => [];

  const res = await removeDeployment(deps, "g-partner");
  assert.ok(res.ok);
  assert.deepEqual(statuses, ["disabled"]);
  assert.equal(thread.locked && thread.archived, true, "the private thread is sealed in place");
  assert.deepEqual(located, [[7, { guildId: null, channelId: null, threadId: null }]],
    "the adoption row rehomes to the house — the next ensure rebuilds there");
});

test("syncDeployments: backfills listing_posts before the missing queue, and resets dead post rows when the forum is recreated", async () => {
  const calls: string[] = [];
  const partner = {
    guildId: "g-partner", status: "active",
    marketplaceChannelId: "c-forum-old", adopteesChannelId: "c-adoptees-old",
    categoryId: "c-cat-old", deployedBy: null, deployedAt: null, lastError: null,
  } as GuildDeployment;
  const { deps } = adopteeDeps();
  (deps.store as any).deployments = async () => [partner];
  (deps.store as any).backfillListingPosts = async () => { calls.push("backfill"); };
  (deps.store as any).resetListingPostsForGuild = async (g: string) => { calls.push(`reset:${g}`); };
  (deps.store as any).missingListingPosts = async () => [];
  // Record-only: the real row's cached `dep` object stays stale through the
  // compare (refreshDeploymentCache rebuilds the map, it doesn't mutate) —
  // mutating it here would mask the recreate-detection branch.
  (deps.store as any).upsertDeployment = async () => { calls.push("upsert"); };
  // The old forum is gone; the adoptees channel still lives.
  deps.fetchChannel = async (id: string) => id === "c-adoptees-old" ? ({ id } as never) : null;
  deps.fetchGuild = async () => ({
    id: "g-partner",
    features: ["COMMUNITY"],
    channels: {
      cache: { find: () => undefined },
      create: async (o: { name: string; type: number }) => ({
        id: `c-${o.name}-new`, name: o.name, type: o.type,
      }),
    },
  } as never);
  const saved = config.marketDeployEnabled;
  config.marketDeployEnabled = true;
  try {
    await syncDeployments(deps);
  } finally { config.marketDeployEnabled = saved; }
  assert.ok(calls.includes("backfill"), "the pre-v59 seed runs before the queue computes");
  assert.ok(calls.includes("reset:g-partner"), "dead forum → its 'live' post rows clear so the sweep reposts");
});

// ── Self-serve deployment layout (v63) ───────────────────────────────────────

type DeployedChannel = { id: string; name: string; type: number; parentId?: string; edited?: Array<Record<string, unknown>>; edit?(o: Record<string, unknown>): Promise<unknown> };

function deployFake(opts: { existing?: DeployedChannel[] } = {}) {
  const created: DeployedChannel[] = [];
  const existing = opts.existing ?? [];
  const guild = {
    id: "g-partner",
    features: ["COMMUNITY"],
    members: { me: { permissions: { has: () => true } } },
    channels: {
      cache: { find: (fn: (c: DeployedChannel) => boolean) => [...existing, ...created].find(fn) },
      create: async (o: { name: string; type: number; parent?: string }) => {
        const c: DeployedChannel = { id: `c-${o.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name: o.name, type: o.type, parentId: o.parent };
        created.push(c);
        return c;
      },
    },
  };
  return { guild, created };
}

function loginChannelCapture() {
  const sent: Array<{ content?: string; components?: unknown }> = [];
  const msgs: Array<{ author?: { id: string }; content?: string; pin(): Promise<void>; delete(): Promise<void> }> = [];
  const ch = {
    id: "c-log-in",
    send: async (p: { content?: string; components?: unknown }) => {
      sent.push(p);
      const m = { id: `m-${sent.length}`, author: { id: "bot-1" }, content: p.content, pinned: false,
        pin: async () => { (m as { pinned: boolean }).pinned = true; },
        delete: async () => { msgs.splice(msgs.indexOf(m), 1); } };
      msgs.push(m);
      return m;
    },
    messages: { fetch: async () => msgs },
  };
  return { ch, sent, msgs };
}

test("deployMarketplace: builds characterly.app category with #log-in + pinned login card", async () => {
  const { guild, created } = deployFake();
  const login = loginChannelCapture();
  const upserts: Array<Record<string, unknown>> = [];
  const { deps } = adopteeDeps({ channels: { "c-log-in": login.ch } });
  (deps.store as any).deploymentFor = async () => ({ guildId: "g-partner", status: "granted", grantKind: "ops" });
  (deps.store as any).upsertDeployment = async (d: Record<string, unknown>) => { upserts.push(d); };
  (deps.store as any).deployments = async () => [{ guildId: "g-partner", status: "active", marketplaceChannelId: "c-characters" }];
  (deps.store as any).missingListingPosts = async () => [];
  deps.fetchGuild = async () => guild as never;
  const saved = config.marketDeployEnabled;
  config.marketDeployEnabled = true;
  try {
    const res = await deployMarketplace(deps, "g-partner", "u-admin");
    assert.ok(res.ok, res.error ?? "deploy should succeed");
  } finally { config.marketDeployEnabled = saved; }
  const names = created.map(c => c.name);
  assert.ok(names.includes("characterly.app"), `category created: ${names}`);
  assert.ok(names.includes("log-in"), `login channel created: ${names}`);
  assert.equal(created.find(c => c.name === "log-in")?.type, ChannelType.GuildText);
  const up = upserts.find(u => u.status === "active");
  assert.equal(up?.loginChannelId, "c-log-in", "the row persists the login channel id");
  assert.equal(login.sent.length, 1, "one login card posted");
  assert.match(login.sent[0].content ?? "", /Char\.ly log-in card/, "the card carries its dedupe marker");
  assert.match(login.sent[0].content ?? "", /\/link/, "the card teaches the link flow");
});

test("deployMarketplace: a pre-rename 'Characterly' category is reused + renamed, not duplicated", async () => {
  const edits: Array<Record<string, unknown>> = [];
  const legacy: DeployedChannel = {
    id: "c-cat-legacy", name: "Characterly", type: ChannelType.GuildCategory,
    edit: async (o: Record<string, unknown>) => { edits.push(o); (legacy as { name: string }).name = o.name as string; },
  };
  const { guild, created } = deployFake({ existing: [legacy] });
  const { deps } = adopteeDeps({ channels: {} });
  (deps.store as any).deploymentFor = async () => ({ guildId: "g-partner", status: "granted" });
  (deps.store as any).upsertDeployment = async () => {};
  (deps.store as any).deployments = async () => [];
  (deps.store as any).missingListingPosts = async () => [];
  deps.fetchGuild = async () => guild as never;
  const saved = config.marketDeployEnabled;
  config.marketDeployEnabled = true;
  try {
    const res = await deployMarketplace(deps, "g-partner");
    assert.ok(res.ok, res.error ?? "deploy should succeed");
  } finally { config.marketDeployEnabled = saved; }
  assert.deepEqual(edits, [{ name: "characterly.app" }], "the legacy category is renamed in place");
  assert.equal(created.filter(c => c.type === ChannelType.GuildCategory).length, 0, "no duplicate category");
});

test("deployMarketplace: rerun is idempotent — stored ids reused, no second login card", async () => {
  const existing: DeployedChannel[] = [
    { id: "c-cat", name: "characterly.app", type: ChannelType.GuildCategory },
    { id: "c-characters", name: "characters", type: ChannelType.GuildForum },
    { id: "c-adoptees", name: "adoptees", type: ChannelType.GuildText },
    { id: "c-log-in", name: "log-in", type: ChannelType.GuildText },
  ];
  const { guild, created } = deployFake({ existing });
  const login = loginChannelCapture();
  // A live marked card already stands — the reconcile must not repost.
  login.msgs.push({ author: { id: "bot-1" }, content: "…Char.ly log-in card…", pin: async () => {}, delete: async () => {} });
  const { deps } = adopteeDeps({ channels: { "c-log-in": login.ch } });
  (deps.store as any).deploymentFor = async () => ({ guildId: "g-partner", status: "granted", loginChannelId: "c-log-in" });
  (deps.store as any).upsertDeployment = async () => {};
  (deps.store as any).deployments = async () => [];
  (deps.store as any).missingListingPosts = async () => [];
  deps.fetchGuild = async () => guild as never;
  const saved = config.marketDeployEnabled;
  config.marketDeployEnabled = true;
  try {
    const res = await deployMarketplace(deps, "g-partner");
    assert.ok(res.ok, res.error ?? "deploy should succeed");
  } finally { config.marketDeployEnabled = saved; }
  assert.equal(created.length, 0, "everything found by id/name — nothing recreated");
  assert.equal(login.sent.length, 0, "the standing card is kept, not duplicated");
});

test("/ops deploystatus reports the house via the env-synthesized row; grant/revoke stay refused", async () => {
  initOps(makeDeps({
    store: {
      deploymentFor: async () => null, // no seeded DB row — the env synth fills in
      listingPostsForGuild: async () => [{ status: "live" }, { status: "failed" }],
    } as unknown as MemoryStore,
  }));
  const ix = makeIx({ strings: { action: "deploystatus", guild: HOUSE } });
  await handleOpsCommand(ix as any);
  assert.match(ix.replies[0].content, /status `active`/);
  assert.match(ix.replies[0].content, /posts: live=1 failed=1/);
  // Grant/revoke on the house itself remain refused — the house doesn't
  // take the deployment path.
  const grant = makeIx({ strings: { action: "deploygrant", guild: HOUSE } });
  await handleOpsCommand(grant as any);
  assert.match(grant.replies[0].content, /doesn't need a deployment/);
  const revoke = makeIx({ strings: { action: "deployrevoke", guild: HOUSE } });
  await handleOpsCommand(revoke as any);
  assert.match(revoke.replies[0].content, /doesn't need a deployment/);
});

// ── Floodgate (v63) ──────────────────────────────────────────────────────────

function adopteesChannelCapture() {
  const sent: Array<{ content?: string }> = [];
  const msgs: Array<{ id: string; author?: { id: string }; content?: string; pinned: boolean; pin(): Promise<void>; delete(): Promise<void> }> = [];
  const deleted: string[] = [];
  const ch = {
    id: "c-adoptees",
    send: async (p: { content?: string }) => {
      sent.push(p);
      const m = { id: `m-${sent.length}`, author: { id: "bot-1" }, content: p.content, pinned: false,
        pin: async () => { m.pinned = true; },
        delete: async () => { deleted.push(m.id); const i = msgs.indexOf(m); if (i >= 0) msgs.splice(i, 1); } };
      msgs.push(m);
      return m;
    },
    messages: { fetch: async () => msgs },
  };
  return { ch, sent, msgs, deleted };
}

function houseGuildWithThreads(n: number, foreign = 1) {
  const threads = new Map<string, { id: string; parentId: string }>();
  for (let i = 0; i < n; i++) threads.set(`t-${i}`, { id: `t-${i}`, parentId: "c-adoptees" });
  for (let i = 0; i < foreign; i++) threads.set(`t-elsewhere-${i}`, { id: `t-elsewhere-${i}`, parentId: "c-other" }); // not ours
  return {
    id: HOUSE,
    channels: {
      cache: { find: () => undefined },
      create: async () => { throw new Error("never create in the house"); },
      fetchActiveThreads: async () => ({ threads }),
    },
  };
}

function pressureDeps(n: number, adoptees: ReturnType<typeof adopteesChannelCapture>, foreign = 1) {
  const { deps } = adopteeDeps({ channels: { "c-adoptees": adoptees.ch } });
  (deps.store as any).deployments = async () => [];
  (deps.store as any).backfillListingPosts = async () => {};
  (deps.store as any).resetListingPostsForGuild = async () => {};
  (deps.store as any).missingListingPosts = async () => [];
  deps.fetchGuild = async () => houseGuildWithThreads(n, foreign) as never;
  deps.botInviteUrl = "https://discord.com/oauth2/authorize?client_id=x";
  const saved = config.marketDeployEnabled;
  config.marketDeployEnabled = true;
  return { deps, restore: () => { config.marketDeployEnabled = saved; } };
}

test("floodgate: ≥warn posts+pins the marked card once; rerun reuses it", async () => {
  const adoptees = adopteesChannelCapture();
  const { deps, restore } = pressureDeps(710, adoptees);
  try {
    await syncDeployments(deps);
    assert.equal(adoptees.sent.length, 1, "the card posts at the warn line");
    assert.match(adoptees.sent[0].content ?? "", /Char\.ly floodgate/);
    assert.match(adoptees.sent[0].content ?? "", /marketplace deploy/, "the card teaches the self-serve path");
    assert.equal(adoptees.msgs[0].pinned, true, "the card pins itself");
    assert.equal(houseAdopteesPressure().active, true);
    assert.equal(houseAdopteesPressure().count, 710);
    await syncDeployments(deps);
    assert.equal(adoptees.sent.length, 1, "the standing card is reused, not duplicated");
  } finally { restore(); }
});

test("floodgate: in-band counts hold the card (hysteresis); below clear it comes down", async () => {
  const adoptees = adopteesChannelCapture();
  // Activate at the warn line, then wobble inside the 600–700 band — the card
  // must stay standing through the band so the sweep can't flap it.
  const { deps, restore } = pressureDeps(705, adoptees);
  try { await syncDeployments(deps); } finally { restore(); }
  assert.equal(houseAdopteesPressure().active, true);
  const band = pressureDeps(650, adoptees);
  try { await syncDeployments(band.deps); } finally { band.restore(); }
  assert.equal(houseAdopteesPressure().active, true, "mid-band stays active");
  assert.equal(adoptees.sent.length, 1, "no new card in the band");
  const quiet = pressureDeps(550, adoptees);
  try { await syncDeployments(quiet.deps); } finally { quiet.restore(); }
  assert.equal(houseAdopteesPressure().active, false, "below clear the latch releases");
  assert.equal(adoptees.deleted.length, 1, "the marked card is removed");
  assert.equal(adoptees.msgs.length, 0);
});

test("floodgate: guild-wide total trips the card even when #adoptees is quiet", async () => {
  const adoptees = adopteesChannelCapture();
  const saved = { w: config.houseGuildThreadWarnCount, c: config.houseGuildThreadClearCount };
  config.houseGuildThreadWarnCount = 6;
  config.houseGuildThreadClearCount = 3;
  try {
    // Settle the shared latch first — pressureState is module-level.
    const reset = pressureDeps(0, adoptees, 0);
    try { await syncDeployments(reset.deps); } finally { reset.restore(); }
    assert.equal(houseAdopteesPressure().active, false);
    // 2 adoptee threads + 4 foreign = 6 guild-wide ≥ warn — tickets and forum
    // posts count toward the shared ceiling even though they aren't ours.
    const { deps, restore } = pressureDeps(2, adoptees, 4);
    try { await syncDeployments(deps); } finally { restore(); }
    assert.equal(houseAdopteesPressure().active, true);
    assert.equal(houseAdopteesPressure().count, 2);
    assert.equal(houseAdopteesPressure().guildTotal, 6);
    assert.equal(adoptees.sent.length, 1, "the card posts on guild pressure alone");
    // Adoptees drop to zero but the guild total stays over clear — the card
    // holds: the shared pool is still near the wall.
    const stillHot = pressureDeps(0, adoptees, 4);
    try { await syncDeployments(stillHot.deps); } finally { stillHot.restore(); }
    assert.equal(houseAdopteesPressure().active, true, "guild-side pressure holds the latch");
    const cooled = pressureDeps(0, adoptees, 1);
    try { await syncDeployments(cooled.deps); } finally { cooled.restore(); }
    assert.equal(houseAdopteesPressure().active, false, "both signals under clear releases");
    assert.ok(adoptees.deleted.length >= 1, "the marked card is removed");
  } finally {
    config.houseGuildThreadWarnCount = saved.w;
    config.houseGuildThreadClearCount = saved.c;
  }
});

test("floodgate: pressure sweeps even with MARKET_DEPLOY_ENABLED off — the ceiling is house-scoped", async () => {
  const adoptees = adopteesChannelCapture();
  // Partner mirror work is the flag's domain, but Discord's ~1,000
  // active-thread ceiling applies to the house either way — the gauge must
  // keep sweeping. The CARD doesn't post though: its only call-to-action is
  // /marketplace deploy, which the flag disables — a pinned dead-end.
  const { deps, restore } = pressureDeps(710, adoptees);
  config.marketDeployEnabled = false; // pressureDeps defaults it on
  try {
    await syncDeployments(deps);
  } finally { restore(); }
  assert.equal(houseAdopteesPressure().active, true);
  assert.equal(houseAdopteesPressure().count, 710);
  assert.equal(adoptees.sent.length, 0, "no card — its remediation is unavailable with deploys off");
});
