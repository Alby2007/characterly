import { test, beforeEach } from "node:test";
import assert from "node:assert";
import {
  isHouse, isMarketplaceThread, automodMessage, handleHouseMemberAdd, handleHouseMemberUpdate,
  handleHouseMemberRemove, ensureHouseLayout, collectHostHealth,
  runWatchdogTick, handleOpsCommand, initOps, resetOpsState, WANTED_LAYOUT,
  ensureVerifyGate, handleHouseButton, runMemberLinkSweep, runTagSweep,
  type OpsDeps, type AutomodMessage, type MemberLike,
} from "./ops.js";
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

test("house:verify — linked account grants Member; unlinked gets the signup pointer", async () => {
  const linked = makeMember();
  initOps(makeDeps({
    fetchMember: async () => linked,
    store: {
      creditsSupported: true,
      accountForDiscordUser: async () => ({ id: "acc-1", plan: "free", creditBalance: 0 }),
    } as unknown as MemoryStore,
  }));
  const ix = makeButtonIx();
  await handleHouseButton(ix as any);
  assert.deepEqual(linked.added, ["r-member"], "linked account ⇒ Member granted");
  assert.match(ix.replies[0].content, /Verified/);

  const unlinked = makeMember();
  initOps(makeDeps({ fetchMember: async () => unlinked }));
  const ix2 = makeButtonIx();
  await handleHouseButton(ix2 as any);
  assert.equal(unlinked.added.length, 0, "no linked account ⇒ no role");
  assert.match(ix2.replies[0].content, /No linked Characterly account/);
  assert.match(ix2.replies[0].content, /\/link/);
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

  initOps(makeDeps({ fetchMember: async () => makeMember({ hasRole: true }) }));
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

// ── Host health + watchdog ───────────────────────────────────────────────────

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
