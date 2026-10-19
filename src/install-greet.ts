import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type MessageCreateOptions } from "discord.js";
import { config } from "./config.js";
import type { MemoryStore } from "./database.js";
import { inc } from "./metrics.js";

// Install greeting — Discord's APPLICATION_AUTHORIZED webhook event lands in
// app_installs (via the website worker); this sweep DMs a welcome card to
// every ungreeted install. greeted_at is the permanent dedupe — reinstalls
// never re-greet. Mirrors guild-lifecycle.ts: deps injected, unit-testable.

export type InstallGreetDeps = {
  fetchUser: (userId: string) => Promise<{ send: (payload: MessageCreateOptions) => Promise<unknown> }>;
  hasCompanion: (userId: string) => Promise<boolean>;
  siteUrl?: string;
};

/** The welcome card — one permanent companion per account; the button is the
 *  same `onboard:start` used everywhere, so the draft Q&A + link gate work
 *  unchanged. */
export function buildInstallGreetPayload(siteUrl = config.siteUrl) {
  const embed = new EmbedBuilder()
    .setTitle("Welcome to Characterly")
    .setDescription(
      "Characterly awakens **one permanent personal companion per account** — they live here in your DMs, " +
        "and you can summon them into any server that runs Characterly — starting with our community server.\n\n" +
        "They remember your conversations (privately — only you can see them), keep a journal of your shared " +
        "moments, and grow a personality that's yours alone."
    )
    .addFields(
      { name: "How to start", value: "Click **Awaken Your Companion** below — a free account link or your own AI key gets them running." },
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("onboard:start")
      .setLabel("Awaken Your Companion")
      .setStyle(ButtonStyle.Primary),
    ...(siteUrl
      ? [new ButtonBuilder().setLabel("Get a free account").setStyle(ButtonStyle.Link).setURL(siteUrl)]
      : []),
    // The house is where the shelf, adoptee threads and announcements live —
    // first-contact DM is the cheapest funnel touch we get.
    ...(config.houseGuildId && (config.houseInviteUrl ?? siteUrl)
      ? [new ButtonBuilder().setLabel("Join the Characterly server").setStyle(ButtonStyle.Link).setURL((config.houseInviteUrl ?? siteUrl)!)]
      : []),
  );
  return { embeds: [embed], components: [row] };
}

/** One sweep pass: greet up to `limit` ungreeted installs, oldest first.
 *  Users who already onboarded (any companion row) are marked greeted
 *  silently — the greeting is for the gap, not for users who found us first. */
export async function greetPendingInstalls(
  store: Pick<MemoryStore, "pendingInstallGreets" | "markInstallGreeted" | "markInstallGreetFailed">,
  deps: InstallGreetDeps,
  limit = 10,
): Promise<{ greeted: number; skipped: number; failed: number }> {
  const pending = await store.pendingInstallGreets(limit);
  let greeted = 0, skipped = 0, failed = 0;
  for (const install of pending) {
    try {
      // Already onboarded — no greeting needed, but mark it so the row stops
      // surfacing (they found the bot another way).
      if (await deps.hasCompanion(install.discordUserId)) {
        await store.markInstallGreeted(install.discordUserId);
        skipped++;
        continue;
      }
      const user = await deps.fetchUser(install.discordUserId);
      await user.send(buildInstallGreetPayload(deps.siteUrl));
      await store.markInstallGreeted(install.discordUserId);
      greeted++;
      inc("install.greeted");
    } catch (e) {
      failed++;
      inc("install.greet_failed");
      await store.markInstallGreetFailed(
        install.discordUserId,
        e instanceof Error ? e.message : String(e),
      ).catch(() => {});
    }
  }
  return { greeted, skipped, failed };
}
