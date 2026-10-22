import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";
import { config } from "../config.js";
import { inc } from "../metrics.js";
import { logError } from "../secrets.js";
import {
  getOpsDeps, registerSweep, isHouse, normName, opsAlert, opsChannel, reconcileMarkedCard, safeTrunc,
  type GuildChannelLike, type GuildLike, type OpsDeps, type SendableChannel, type ThreadLike, type TicketThreadLike,
} from "./shared.js";
import { RESOURCE_POSTS } from "./layout.js";

export function startTicketReaper(deps: OpsDeps): { stop: () => void } {
  return registerSweep("tickets", () => reapOrphanTicketThreads(deps), config.hostHealthIntervalMs);
}
// ── Support tickets ──────────────────────────────────────────────────────────
// A persistent card in #support-ticket carries the Open button; the modal
// intake creates one private thread per ticket. The opener sees it via thread
// membership, staff via ManageThreads (granted channel-locally by
// staffModerate in WANTED_LAYOUT). support_tickets rows dedupe one-open-per-
// user — the partial unique index is the arbiter, so a double-submit or a
// button-click race can't open two threads. Ticket threads are excluded from
// automod + memory in index.ts's handleMessage.

const TICKET_OPEN_ID = "ticket:open";
const TICKET_MODAL_ID = "ticket:new";
const TICKET_CLOSE_ID = "ticket:close";
const TICKET_CHANNEL = "support-ticket";

// Ticket categories (v66) — the open-click dedupe leads into a category
// picker, and the pick rides the modal's own customId (`ticket:new:{cat}`)
// since modals can't carry hidden state. Stored on the row; the ops ping
// and thread embed label it so staff route at a glance.
export const TICKET_CATEGORIES: ReadonlyArray<readonly [string, string]> = [
  ["billing", "Billing & credits"],
  ["bug", "Bug report"],
  ["appeal", "Moderation / appeal"],
  ["other", "Something else"],
];
const ticketCategory = (c: string | undefined) =>
  TICKET_CATEGORIES.some(([k]) => k === c) ? c! : "other";
const TICKET_MODAL_PREFIX = `${TICKET_MODAL_ID}:`;

// Keyword → resource-post channel — the ticket's first answer for the
// common asks, posted into the thread at open so the member can self-serve
// while staff get there. Names match RESOURCE_POSTS entries.
const TICKET_FAQ_HINTS: Array<{ re: RegExp; channel: string; label: string }> = [
  { re: /\b(?:link|verify|verification|log[\s-]?in|sign[\s-]?in|code)\b/i, channel: "get-companionly", label: "linking & getting started" },
  { re: /\b(?:billing|payment|refund|charge|invoice|subscri|credit|token|price|cost|premium|plan)\b/i, channel: "what-is-characterly", label: "plans & credits" },
  { re: /\b(?:publish|persona|customi[sz]e|rename|my\s+own|create\s+a)\b/i, channel: "what-is-companionly", label: "your own companion" },
];

function ticketChannel(guild: GuildLike): GuildChannelLike | undefined {
  return guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && normName(c.name) === normName(TICKET_CHANNEL));
}

/** Post the ticket panel once — the button's customId is the marker inside
 *  components JSON; reconcileMarkedCard dedupes any extras. */
export async function ensureTicketPanel(deps: OpsDeps, guild: GuildLike): Promise<boolean> {
  if (!isHouse(guild.id)) return false;
  const ch = ticketChannel(guild);
  if (!ch?.id) return false;
  const sendable = await deps.fetchChannel(ch.id).catch(() => null);
  if (!sendable?.send) return false;
  const { posted } = await reconcileMarkedCard(deps, sendable, {
    match: TICKET_OPEN_ID,
    payload: {
      embeds: [new EmbedBuilder()
        .setTitle("Open a support ticket")
        .setDescription(
          "Need a human? Open a ticket — billing, account trouble, bugs, or anything the FAQs didn't cover.\n\n" +
          "A private thread opens between you and the staff team — nobody else can see it, and nothing in it feeds companion memory. One open ticket at a time.\n\n" +
          "_Just joined? Accept the server rules first — the button works once you have._",
        )],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(TICKET_OPEN_ID).setLabel("Open a ticket").setStyle(ButtonStyle.Primary),
      )],
      allowedMentions: { parse: [] },
    },
  });
  return posted;
}

export function buildTicketModal(category = "other"): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${TICKET_MODAL_PREFIX}${category}`)
    .setTitle(`${TICKET_CATEGORIES.find(([c]) => c === category)?.[1] ?? "Support"} ticket`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("subject").setLabel("Subject")
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
          .setPlaceholder("Billing, account, bug, something else…")),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("details").setLabel("What do you need?")
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)
          .setPlaceholder("The more detail the better — links, error text, what you tried.")),
    );
}

/** ticket:* buttons — routed from handleMemoryButton; deps are module-init'd.
 *  ticket:open dedupe-checks then shows the intake modal; ticket:close lives
 *  inside the ticket thread and needs the opener or staff perms. */
export async function handleTicketButton(interaction: ButtonInteraction): Promise<unknown> {
  const deps = getOpsDeps();
  if (!deps) return interaction.reply({ content: "Ops isn't initialized yet — the bot is still starting.", ephemeral: true });
  if (!isHouse(interaction.guildId)) {
    return interaction.reply({ content: "That button only works in our community server.", ephemeral: true });
  }
  if (interaction.customId === TICKET_OPEN_ID) {
    // Dedupe before the modal — re-checked on submit too (the unique index
    // is the real arbiter; this just saves the user the typing).
    const existing = await deps.store.openSupportTicketFor(interaction.user.id).catch(() => undefined);
    if (existing === undefined) {
      return interaction.reply({ content: "Couldn't check your tickets right now — try again in a moment.", ephemeral: true });
    }
    if (existing) {
      return interaction.reply({ content: `You already have an open ticket — <#${existing.threadId}>.`, ephemeral: true });
    }
    // Category picker first — the pick rides into the modal's customId.
    return interaction.reply({
      ephemeral: true,
      content: "What's the ticket about? Pick the closest:",
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...TICKET_CATEGORIES.map(([cat, label]) =>
          new ButtonBuilder().setCustomId(`ticket:opencat:${cat}`).setLabel(label).setStyle(ButtonStyle.Secondary),
        ),
      )],
    });
  }
  if (interaction.customId.startsWith("ticket:opencat:")) {
    if (typeof interaction.showModal !== "function") {
      return interaction.reply({ content: "Ticket intake needs a newer Discord client — describe your issue to a Mod directly.", ephemeral: true });
    }
    return interaction.showModal(buildTicketModal(ticketCategory(interaction.customId.split(":")[2])));
  }
  if (interaction.customId === TICKET_CLOSE_ID) {
    const channel = interaction.channel as unknown as {
      id: string; isThread?(): boolean; send?(payload: unknown): Promise<unknown>;
      setLocked?(locked: boolean): Promise<unknown>; setArchived?(archived: boolean): Promise<unknown>;
    } | null;
    if (!channel?.isThread?.()) {
      return interaction.reply({ content: "That button only works inside a ticket thread.", ephemeral: true });
    }
    const ticket = await deps.store.supportTicketByThread(channel.id).catch(() => undefined);
    if (ticket === undefined) {
      return interaction.reply({ content: "Couldn't look up this ticket — try again in a moment.", ephemeral: true });
    }
    if (!ticket || ticket.status !== "open") {
      return interaction.reply({ content: "That ticket's already closed.", ephemeral: true });
    }
    // Opener or staff — ManageThreads/ManageGuild/Administrator all count.
    const perms = (interaction as { memberPermissions?: { has?(b: bigint): boolean } }).memberPermissions;
    const staff = !!(perms?.has?.(PermissionFlagsBits.ManageThreads)
      || perms?.has?.(PermissionFlagsBits.ManageGuild)
      || perms?.has?.(PermissionFlagsBits.Administrator));
    if (interaction.user.id !== ticket.openerId && !staff) {
      return interaction.reply({ content: "Only the ticket opener or staff can close it.", ephemeral: true });
    }
    // Close the row BEFORE sealing the thread: the bad divergence is
    // thread-sealed + row-open — the dedupe check would block the opener
    // forever, pointing at a dead thread. Row-closed + thread-open is the
    // survivable side — the reaper seals strays on its next pass.
    try {
      await deps.store.closeSupportTicket(ticket.threadId, interaction.user.id);
    } catch (e) {
      inc("ops.ticket_error"); logError("ticket close failed", e);
      return interaction.reply({ content: "Couldn't close the ticket — try again in a moment.", ephemeral: true });
    }
    await interaction.update({ components: [] }).catch(() => {}); // strip the button
    // Close note first — a locked+archived thread refuses further messages.
    await channel.send?.({
      content: `🔒 Ticket closed by <@${interaction.user.id}>. This thread is archived — open a new ticket if anything else comes up.`,
      allowedMentions: { users: [interaction.user.id] },
    }).catch(() => {});
    await channel.setLocked?.(true).catch(() => {});
    await channel.setArchived?.(true).catch(() => {});
    await opsAlert(deps, `🔒 **Ticket closed** — <#${ticket.threadId}> (${safeTrunc(ticket.subject, 140)}) by <@${interaction.user.id}>`);
    inc("ops.ticket_closed");
    return undefined;
  }
  // Unknown ticket:* id — same stale-button story as house:*.
  return interaction.reply({ content: "That button's gone stale — the card has moved on.", ephemeral: true });
}

/** ticket:new modal submit — creates the private thread, adds the opener,
 *  files the row, alerts staff. Ordered so a DB failure never leaves an
 *  untracked open thread. */
export async function handleTicketModal(interaction: ModalSubmitInteraction): Promise<unknown> {
  // The category rides the modal customId (ticket:new:{cat}); a bare
  // ticket:new is a pre-category modal still in flight — it files as other.
  const category = interaction.customId.startsWith(TICKET_MODAL_PREFIX)
    ? ticketCategory(interaction.customId.slice(TICKET_MODAL_PREFIX.length))
    : interaction.customId === TICKET_MODAL_ID ? "other" : null;
  if (category === null) return undefined;
  const deps = getOpsDeps();
  if (!deps || !isHouse(interaction.guildId)) {
    return interaction.reply({ content: "Tickets only open from our community server.", ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const subject = safeTrunc(interaction.fields.getTextInputValue("subject"), 100).trim();
  const details = safeTrunc(interaction.fields.getTextInputValue("details"), 1000).trim();
  if (!subject || !details) {
    return interaction.editReply({ content: "Both fields are required — click Open a ticket to try again." });
  }
  const existing = await deps.store.openSupportTicketFor(interaction.user.id).catch(() => undefined);
  if (existing === undefined) {
    return interaction.editReply({ content: "Couldn't check your tickets right now — try again in a moment." });
  }
  if (existing) {
    return interaction.editReply({ content: `You already have an open ticket — <#${existing.threadId}>.` });
  }
  const guild = await deps.fetchGuild(interaction.guildId!).catch(() => null);
  const ch = guild ? ticketChannel(guild) : undefined;
  const sendable = ch ? await deps.fetchChannel(ch.id).catch(() => null) : null;
  if (!ch || typeof sendable?.threads?.create !== "function") {
    return interaction.editReply({ content: "The ticket desk isn't set up yet — tell an admin #support-ticket is missing." });
  }
  const slug = (interaction.user.username ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "member";
  const thread = await sendable.threads.create({
    name: `ticket-${slug}`.slice(0, 90),
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: 10080, // a week — active threads never auto-lock mid-ticket
  }).catch(e => { inc("ops.ticket_error"); logError("ticket thread create failed", e); return null; });
  if (!thread) {
    return interaction.editReply({ content: "Couldn't open the ticket thread — try again in a moment." });
  }
  const row = await deps.store.createSupportTicket(interaction.guildId!, interaction.user.id, thread.id, subject, details, category)
    .catch(e => { inc("ops.ticket_error"); logError("ticket insert failed", e); return null; });
  if (!row) {
    // Dedupe race lost or DB failure — archive the orphan thread either way.
    await thread.setLocked?.(true).catch(() => {});
    await thread.setArchived?.(true).catch(() => {});
    const again = await deps.store.openSupportTicketFor(interaction.user.id).catch(() => null);
    return interaction.editReply({
      content: again
        ? `You already have an open ticket — <#${again.threadId}>.`
        : "Couldn't file the ticket — try again in a moment.",
    });
  }
  const catLabel = TICKET_CATEGORIES.find(([c]) => c === category)?.[1] ?? category;
  const added = await thread.members?.add(interaction.user.id).then(() => true).catch(() => false) ?? false;
  await thread.send({
    content: `<@${interaction.user.id}>`,
    embeds: [new EmbedBuilder()
      .setTitle(`🎫 ${safeTrunc(subject, 200)}`)
      .setDescription(details)
      .setFooter({ text: `${catLabel} ticket · opened by ${interaction.user.username} — only you and staff can see this thread.` })],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(TICKET_CLOSE_ID).setLabel("Close ticket").setStyle(ButtonStyle.Danger),
    )],
    allowedMentions: { users: [interaction.user.id] },
  }).catch(e => { inc("ops.ticket_error"); logError("ticket opener send failed", e); });
  // FAQ deflection — the common asks get their resource post dropped right
  // in the thread so the member can self-serve while staff get there.
  const hint = TICKET_FAQ_HINTS.find(h => h.re.test(`${subject}\n${details}`));
  const hintPost = hint ? RESOURCE_POSTS.find(p => p.channel === hint.channel) : undefined;
  if (hint && hintPost) {
    await thread.send({
      content: `_While you wait — this usually covers **${hint.label}**:_`,
      embeds: hintPost.embeds(),
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
  // Staff ping rides the ops channel — the Mod role mention notifies while
  // the thread link lets them jump straight in.
  const modRole = guild!.roles?.cache?.find(r => normName(r.name) === normName("Mod"));
  const chOps = await opsChannel(deps);
  await chOps?.send({
    content: `🎫 **${catLabel} ticket** — <@${interaction.user.id}>: ${safeTrunc(subject, 140)} → <#${thread.id}>${added ? "" : " ⚠️ member-add failed, invite them manually"}`,
    allowedMentions: modRole ? { roles: [modRole.id], users: [interaction.user.id] } : { users: [interaction.user.id] },
  }).catch(e => { inc("ops.ticket_error"); logError("ticket alert failed", e); });
  inc("ops.ticket_opened");
  return interaction.editReply({
    content: `Ticket opened — <#${thread.id}>. Only you and staff can see it; we'll reply there.`,
  });
}

/** A thread is created before its row — a ticket mid-create looks row-less
 *  for a beat, so the reaper ignores threads younger than this. */
const TICKET_REAP_GRACE_MS = 10 * 60_000;
/** An open ticket no staff member has replied to after this long gets an
 *  ops ping — the channel is otherwise silent for members. */
const TICKET_STALE_MS = 72 * 3_600_000;

/** A staff member (ManageThreads — the staffModerate grant in the ticket
 *  channel counts) posting inside a ticket thread marks the row answered —
 *  the reaper's stale nudge only fires for tickets nobody replied to. The
 *  house's only other private threads are adoptees (routed elsewhere in
 *  index.ts), so a missed parent-name cache just costs one no-op UPDATE. */
export async function noteTicketStaffReply(message: {
  guildId: string | null; channelId: string; author: { id: string; bot?: boolean | null };
  member?: { permissionsIn?(channelId: string): { has(b: bigint): boolean } | null | undefined; permissions?: { has(b: bigint): boolean } | null } | null;
  channel?: { type?: number; parent?: { name?: string | null } | null } | null;
}, deps: OpsDeps): Promise<void> {
  if (!isHouse(message.guildId) || message.author.bot || !deps.store.markTicketStaffReply) return;
  if (message.channel?.type !== undefined && message.channel.type !== ChannelType.PrivateThread) return;
  const parentName = message.channel?.parent?.name;
  if (parentName != null && normName(parentName) !== normName(TICKET_CHANNEL)) return;
  const perms = message.member?.permissionsIn?.(message.channelId) ?? message.member?.permissions;
  if (!perms?.has?.(PermissionFlagsBits.ManageThreads) && !perms?.has?.(PermissionFlagsBits.ManageMessages) && !perms?.has?.(PermissionFlagsBits.ManageGuild)) return;
  await deps.store.markTicketStaffReply(message.channelId).catch(() => {});
}
export async function reapOrphanTicketThreads(deps: OpsDeps): Promise<void> {
  if (!config.houseGuildId) return;
  const openRows = await deps.store.listOpenSupportTickets?.(config.houseGuildId).catch(() => null);
  if (openRows) {
    for (const t of openRows) {
      const thread = await deps.fetchChannel(t.threadId).catch(() => null);
      if (thread) continue;
      const closed = await deps.store.closeSupportTicket(t.threadId, deps.botId ?? "ticket-reaper")
        .then(() => true).catch(e => { logError("ticket reaper row close failed", e); return false; });
      if (!closed) continue;
      inc("ops.ticket_reaped");
      await opsAlert(deps, `🧹 **Ticket reaped** — <@${t.openerId}>'s thread is gone; the row's closed so they can file again.`);
    }
  }
  const guild = await deps.fetchGuild(config.houseGuildId).catch(() => null);
  const ch = guild ? ticketChannel(guild) : undefined;
  const sendable = ch ? await deps.fetchChannel(ch.id).catch(() => null) : null;
  if (typeof sendable?.threads?.fetchActive !== "function") return;
  const active = await sendable.threads.fetchActive().catch(() => null);
  if (!active) return;
  const raw = active.threads;
  const threads = [...(raw instanceof Map ? raw.values() : raw)] as Array<ThreadLike & {
    setLocked?(b: boolean): Promise<unknown>; setArchived?(b: boolean): Promise<unknown>;
  }>;
  for (const th of threads) {
    if (th.createdTimestamp && Date.now() - th.createdTimestamp < TICKET_REAP_GRACE_MS) continue;
    const row = await deps.store.supportTicketByThread?.(th.id).catch(() => undefined);
    // A lookup error means "unknown" — keep the thread rather than seal a
    // perfectly live ticket on a flaky read.
    if (row === undefined || row?.status === "open") continue;
    await th.setLocked?.(true).catch(() => {});
    await th.setArchived?.(true).catch(() => {});
    inc("ops.ticket_orphan_sealed");
  }
  // Stale-ticket nudge — an open ticket nobody answered is silently rotting
  // from the member's side. Ping ops once per ticket (stale_notified_at is
  // the dedupe), not once per sweep.
  const stale = await deps.store.listStaleUnansweredTickets?.(config.houseGuildId, TICKET_STALE_MS).catch(() => null) ?? null;
  for (const t of stale ?? []) {
    const marked = await deps.store.markTicketStaleNotified?.(t.threadId).then(() => true).catch(() => false);
    if (!marked) continue; // lost the mark race or write failed — retry next sweep rather than double-ping
    inc("ops.ticket_stale_ping");
    const ageH = Math.round((Date.now() - Date.parse(t.openedAt)) / 3_600_000);
    await opsAlert(deps, `⏰ **Ticket unanswered ${ageH}h** — <@${t.openerId}>'s "${safeTrunc(t.subject, 120)}" has no staff reply: <#${t.threadId}>`, "alert")
      .catch(e => logError("ticket stale ping failed", e));
  }
}
