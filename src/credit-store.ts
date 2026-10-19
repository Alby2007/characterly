import type { Sql } from "./db.js";

// ── Credits, account links & per-user bot settings ────────────────────────────
// Split out of database.ts: everything that reads/writes web_profiles,
// credit_ledger, consent_events and user_bot_settings. MemoryStore composes a
// CreditStore and delegates its public methods, so call sites (and test
// stubs) keep using store.spendCredits(...) unchanged.

export class CreditStore {
  constructor(private readonly sql: Sql) {}

  // Credits live on web_profiles (auth-gated table — absent on plain Postgres,
  // where creditsSupported stays false and the whole feature no-ops). Spends
  // are single-tx: apply due lazy grants under FOR UPDATE, then debit — the
  // row lock makes concurrent turns serialize and the ledger a true running
  // balance. Grants are configured at init from env so tests control them.

  private creditsEnabled = false;
  private creditGrants = { freeDaily: 30, premiumDaily: 150 };

  /** Detect whether the web-accounts schema exists (v26+). Called once at
   * init; tests re-call after creating the fixture tables. */
  async initCreditsSupport(grants?: { freeDaily: number; premiumDaily: number }): Promise<boolean> {
    if (grants) this.creditGrants = grants;
    const rows = await this.sql<Array<{ r: string | null }>>`SELECT to_regclass('public.web_profiles') AS r`;
    this.creditsEnabled = Boolean(rows[0]?.r);
    return this.creditsEnabled;
  }
  get creditsSupported(): boolean { return this.creditsEnabled; }

  /** Cached discord→account resolution shared by the link gate, payer lookup,
   * and plan checks. Only positive hits are cached — a negative entry would
   * mask a fresh /link claim for up to a minute, and a miss is one indexed
   * lookup anyway. */
  private accountCache = new Map<string, { account: { id: string; plan: "free" | "premium"; creditBalance: number; purchasedBalance: number }; at: number }>();
  private static readonly ACCOUNT_CACHE_MS = 60_000;
  private static readonly RESOLUTION_CACHE_MAX = 10_000;

  /** creditBalance is the total; purchasedBalance is the persistent slice of
   *  it (packs + bonuses) — the rest is the daily allowance. */
  async accountForDiscordUser(discordUserId: string): Promise<{ id: string; plan: "free" | "premium"; creditBalance: number; purchasedBalance: number } | null> {
    if (!this.creditsEnabled) return { id: "selfhosted", plan: "premium", creditBalance: Infinity, purchasedBalance: 0 };
    const hit = this.accountCache.get(discordUserId);
    if (hit && Date.now() - hit.at < CreditStore.ACCOUNT_CACHE_MS) return hit.account;
    const rows = await this.sql<Array<{ id: string; plan: string; credit_balance: number; purchased_balance: number }>>`
      SELECT id, plan, credit_balance, purchased_balance FROM web_profiles WHERE discord_user_id = ${discordUserId}
    `;
    if (!rows[0]) return null;
    const account = {
      id: rows[0].id, plan: rows[0].plan as "free" | "premium",
      creditBalance: Number(rows[0].credit_balance), purchasedBalance: Number(rows[0].purchased_balance),
    };
    if (this.accountCache.size >= CreditStore.RESOLUTION_CACHE_MAX) this.accountCache.clear();
    this.accountCache.set(discordUserId, { account, at: Date.now() });
    return account;
  }

  /** Latest recorded Terms/Privacy acceptance for a Discord user — null when
   *  they've never accepted. Matches on discord_user_id OR the linked
   *  account_id when supplied, so a web-signup acceptance counts at the
   *  Discord gate. Append-only rows; the highest version wins.
   *  Uncached: a stale cache would let a just-bumped policy slip through. */
  async tosAcceptance(discordUserId: string, accountId?: string | null): Promise<{ version: number; acceptedAt: string } | null> {
    const rows = await this.sql<Array<{ version: number; accepted_at: string }>>`
      SELECT version, accepted_at FROM consent_events
      WHERE document = 'terms'
        AND (discord_user_id = ${discordUserId}
          OR (${accountId ?? null}::text IS NOT NULL AND account_id = ${accountId ?? null}))
      ORDER BY version DESC, accepted_at DESC LIMIT 1
    `;
    return rows[0] ? { version: Number(rows[0].version), acceptedAt: rows[0].accepted_at } : null;
  }

  /** Append a clickwrap acceptance. account_id is the web_profiles.id when the
   *  user has a linked account (or 'selfhosted'); document/version/source let
   *  one table serve every consent surface — 'terms'/'discord_verify' today,
   *  'web_signup' when the site adds a signup checkbox. */
  async recordTosAcceptance(discordUserId: string, accountId: string | null, version: number, source: string): Promise<void> {
    await this.sql`
      INSERT INTO consent_events (discord_user_id, account_id, document, version, source)
      VALUES (${discordUserId}, ${accountId}, 'terms', ${version}, ${source})
    `;
  }

  /** Linked accounts still missing the Discord display snapshot — code-links
   *  claimed before v38 only stamped discord_user_id. The boot backfill walks
   *  these and re-fetches each profile from Discord. */
  async linkedProfilesMissingDiscordIdentity(): Promise<string[]> {
    if (!this.creditsEnabled) return [];
    const rows = await this.sql<Array<{ discord_user_id: string }>>`
      SELECT discord_user_id FROM web_profiles
      WHERE discord_user_id IS NOT NULL AND (discord_username IS NULL OR discord_username = '')
    `;
    return rows.map(r => r.discord_user_id);
  }

  /** Stamp the Discord display fields on a linked web account. Bot-only —
   *  postgres bypasses the column-level grants that keep authenticated
   *  clients from writing these (same guarantee as discord_user_id). */
  async syncDiscordIdentity(discordUserId: string, username: string, avatarUrl: string): Promise<void> {
    if (!this.creditsEnabled) return;
    await this.sql`
      UPDATE web_profiles
      SET discord_username = ${username}, discord_avatar_url = ${avatarUrl}, updated_at = NOW()
      WHERE discord_user_id = ${discordUserId}
    `;
  }

  /** purchasedDelta moves the persistent (pack/bonus) slice alongside the
   *  total — the daily allowance is always credit_balance − purchased_balance. */
  private async writeLedger(tx: Sql, accountId: string, delta: number, kind: string, reason: string | null, purchasedDelta = 0): Promise<number> {
    const rows = await tx<Array<{ credit_balance: number }>>`
      UPDATE public.web_profiles
      SET credit_balance = credit_balance + ${delta},
          purchased_balance = purchased_balance + ${purchasedDelta},
          updated_at = now()
      WHERE id = ${accountId} RETURNING credit_balance
    `;
    const balance = Number(rows[0].credit_balance);
    await tx`
      INSERT INTO public.credit_ledger (account_id, delta, kind, reason, balance_after)
      VALUES (${accountId}, ${delta}, ${kind}, ${reason}, ${balance})
    `;
    return balance;
  }

  /** Debit n credits from the account linked to discordUserId. Applies any due
   * lazy grants first (daily for all plans — premium's floor is just higher)
   * lock — no scheduler, downtime-safe. ok:false when unlinked or broke.
   * `purchased` is how much of n came out of the persistent pack slice —
   * pass it back to refundCredits so a refund lands in the bucket it left. */
  async spendCredits(
    discordUserId: string,
    n: number,
    reason: string,
  ): Promise<{ ok: boolean; balance: number; purchased: number }> {
    if (!this.creditsEnabled) return { ok: true, balance: 0, purchased: 0 };
    return this.sql.begin(async tx => {
      const rows = await tx<Array<{
        id: string; plan: string; credit_balance: number; purchased_balance: number;
        last_daily_grant_on: string | Date | null;
        today: string;
      }>>`
        SELECT id, plan, credit_balance, purchased_balance, last_daily_grant_on,
               (now() AT TIME ZONE 'UTC')::date AS today
        FROM public.web_profiles WHERE discord_user_id = ${discordUserId}
        FOR UPDATE
      `;
      const acct = rows[0];
      // Live miss evicts any cached positive — a just-unlinked user must fail
      // the gate on their next turn, not ride the stale entry.
      if (!acct) { this.accountCache.delete(discordUserId); return { ok: false, balance: 0, purchased: 0 }; }
      // postgres.js returns computed ::date columns as strings but stored date
      // columns as Date objects — normalize both to YYYY-MM-DD before comparing.
      const isoDay = (v: string | Date | null): string | null =>
        v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
      const day = isoDay(acct.today)!;
      const lastDaily = isoDay(acct.last_daily_grant_on);
      let balance = Number(acct.credit_balance);
      const purchased = Math.max(0, Number(acct.purchased_balance ?? 0));
      // Two buckets in one total: the daily allowance (credit_balance −
      // purchased_balance) REFILLS to the plan floor; the purchased slice
      // (packs, bonuses) never expires and never suppresses that refill.
      // A negative allowance is debt (a clawed-back pack already spent) —
      // the grant pays it down instead of erasing it.
      if (lastDaily !== day) {
        const g = acct.plan === "premium" ? this.creditGrants.premiumDaily : this.creditGrants.freeDaily;
        const daily = balance - purchased;
        const delta = daily < 0 ? g : Math.max(0, g - daily);
        if (delta > 0) balance = await this.writeLedger(tx, acct.id, delta, "grant_daily", null);
        await tx`UPDATE public.web_profiles SET last_daily_grant_on = ${day} WHERE id = ${acct.id}`;
      }
      if (balance < n) return { ok: false, balance, purchased: 0 };
      // Allowance first — it's use-it-or-lose-it; packs only cover the rest.
      const fromDaily = Math.max(0, Math.min(n, balance - purchased));
      const fromPurchased = n - fromDaily;
      balance = await this.writeLedger(tx, acct.id, -n, "spend", reason, -fromPurchased);
      this.accountCache.delete(discordUserId);
      return { ok: true, balance, purchased: fromPurchased };
    });
  }

  /** Credit n back — a companion message that never sent didn't happen.
   *  `purchased` (from spendCredits) returns that part to the pack slice. */
  async refundCredits(discordUserId: string, n: number, reason: string, purchased = 0): Promise<{ ok: boolean; balance: number }> {
    if (!this.creditsEnabled) return { ok: true, balance: 0 };
    return this.sql.begin(async tx => {
      const rows = await tx<Array<{ id: string }>>`SELECT id FROM public.web_profiles WHERE discord_user_id = ${discordUserId} FOR UPDATE`;
      if (!rows[0]) return { ok: false, balance: 0 };
      const balance = await this.writeLedger(tx, rows[0].id, n, "refund", reason, Math.max(0, Math.min(n, purchased)));
      this.accountCache.delete(discordUserId);
      return { ok: true, balance };
    });
  }

  /** Pack purchase — credits an account by UUID (Stripe webhook path, keyed by
   * web_profiles.id rather than a Discord snowflake). stripeRef makes retries
   * idempotent: the ledger's unique stripe_ref index absorbs replays. */
  async purchaseCredits(accountId: string, n: number, reason: string, stripeRef: string): Promise<{ ok: boolean; duplicate: boolean; balance: number }> {
    if (!this.creditsEnabled) return { ok: true, duplicate: false, balance: 0 };
    return this.sql.begin(async tx => {
      const rows = await tx<Array<{ credit_balance: number }>>`
        SELECT credit_balance FROM public.web_profiles WHERE id = ${accountId} FOR UPDATE
      `;
      if (!rows[0]) return { ok: false, duplicate: false, balance: 0 };
      const inserted = await tx`
        INSERT INTO public.credit_ledger (account_id, delta, kind, reason, stripe_ref, balance_after)
        VALUES (${accountId}, ${n}, 'purchase', ${reason}, ${stripeRef}, ${Number(rows[0].credit_balance) + n})
        ON CONFLICT (stripe_ref) WHERE stripe_ref IS NOT NULL DO NOTHING
        RETURNING id
      `;
      if (!inserted[0]) return { ok: true, duplicate: true, balance: Number(rows[0].credit_balance) };
      const updated = await tx<Array<{ credit_balance: number }>>`
        UPDATE public.web_profiles
        SET credit_balance = credit_balance + ${n}, purchased_balance = purchased_balance + ${n}, updated_at = now()
        WHERE id = ${accountId} RETURNING credit_balance
      `;
      this.accountCache.clear(); // accountId is a uuid — evict broadly, cheap at pack volume
      return { ok: true, duplicate: false, balance: Number(updated[0].credit_balance) };
    });
  }

  /** Today's hosted:global LLM-call count — the fleet breaker's current spend.
   * Used to shed the free lane before the hard cap trips. */
  async hostedUsageToday(): Promise<number> {
    const rows = await this.sql<Array<{ llm_calls: number | string | null }>>`
      SELECT llm_calls FROM guild_usage
      WHERE guild_id = 'hosted:global' AND day = (now() AT TIME ZONE 'UTC')::date
    `;
    return Number(rows[0]?.llm_calls ?? 0);
  }

  /** Per-user bot toggles — the site writes via upsert_my_settings; defaults
   * cover users who never open the settings page. */
  private botSettingsCache = new Map<string, { value: { c2cEnabled: boolean; lowCreditAlerts: boolean }; at: number }>();

  async userBotSettings(discordUserId: string): Promise<{ c2cEnabled: boolean; lowCreditAlerts: boolean }> {
    if (!this.creditsEnabled) return { c2cEnabled: true, lowCreditAlerts: true };
    const hit = this.botSettingsCache.get(discordUserId);
    if (hit && Date.now() - hit.at < CreditStore.ACCOUNT_CACHE_MS) return hit.value;
    const rows = await this.sql<Array<{ c2c_enabled: boolean; low_credit_alerts: boolean }>>`
      SELECT c2c_enabled, low_credit_alerts FROM user_bot_settings WHERE discord_user_id = ${discordUserId}
    `;
    const value = rows[0]
      ? { c2cEnabled: Boolean(rows[0].c2c_enabled), lowCreditAlerts: Boolean(rows[0].low_credit_alerts) }
      : { c2cEnabled: true, lowCreditAlerts: true };
    if (this.botSettingsCache.size >= CreditStore.RESOLUTION_CACHE_MAX) this.botSettingsCache.clear();
    this.botSettingsCache.set(discordUserId, { value, at: Date.now() });
    return value;
  }
}
