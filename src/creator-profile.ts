// POST /creator-profile — the sole write path for the public creator page
// fields (v70). The columns carry no authenticated UPDATE grant, so a direct
// client PATCH is denied at the grant level; every save funnels through here:
// user-JWT verified → linked + unbanned → validated → deterministic screen →
// model screen (fail-closed when the page is going public) → service-role
// PATCH. Lives in bot-src so the suite covers it; worker.ts only routes to it.
import {
  checkMessageContent, buildSafetyVerdictPrompt, parseSafetyVerdict,
  normalizeCreatorSlug, validateCreatorFields, creatorProfileSubject,
  CREATOR_NAME_MAX, CREATOR_BIO_MAX,
} from "./authored-screen.js";

export interface CreatorProfileEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Operator model key for the public-text screen — same semantics as the
   *  bot's groqKey: unset means deterministic-only (documented, not a bug). */
  GROQ_API_KEY?: string;
  GROQ_BASE_URL?: string;
  SAFETY_MODEL?: string;
}

const DEFAULT_MODEL = "openai/gpt-oss-120b";
const DEFAULT_BASE = "https://api.groq.com/openai/v1";

// Best-effort save throttle: in-isolate sliding window. Authenticated abuse
// only — a stray save costs one model call, which is cheap; the limit just
// stops a loop from burning provider spend across isolates.
const SAVE_WINDOW_MS = 60 * 60 * 1000;
const SAVE_MAX = 6;
const saves = new Map<string, number[]>();
const saveAllowed = (uid: string): boolean => {
  const now = Date.now();
  const hits = (saves.get(uid) ?? []).filter(t => now - t < SAVE_WINDOW_MS);
  if (hits.length >= SAVE_MAX) { saves.set(uid, hits); return false; }
  hits.push(now);
  saves.set(uid, hits);
  return true;
};
/** Test hook — clears the throttle map between cases. */
export function resetCreatorProfileSavesForTests(): void { saves.clear(); }

const err = (status: number, error: string, extra: Record<string, unknown> = {}): Response =>
  Response.json({ error, ...extra }, { status });

const rest = (env: CreatorProfileEnv) =>
  env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
    ? {
        base: env.SUPABASE_URL.replace(/\/+$/, ""),
        headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
      }
    : null;

/** Verify the caller's Supabase access token → auth uid. */
async function authUserId(base: string, apiKey: string, jwt: string): Promise<string | null> {
  const res = await fetch(`${base}/auth/v1/user`, {
    headers: { apikey: apiKey, authorization: `Bearer ${jwt}` },
  }).catch(() => null);
  if (!res?.ok) return null;
  const user = (await res.json().catch(() => null)) as { id?: string } | null;
  return user?.id ?? null;
}

/** The public-text model screen — a raw OpenAI-compatible call to the same
 *  safety endpoint the bot's Brain hits, built on the shared prompt so the
 *  rule text can't drift. Returns the parsed verdict, or throws on transport
 *  failure (the caller decides fail-open vs fail-closed). */
async function screenModelCall(env: CreatorProfileEnv, subject: string): Promise<{ verdict: "allow" | "flag"; category?: string }> {
  const prompt = buildSafetyVerdictPrompt({ kind: "listing", subject });
  const base = (env.GROQ_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
  const body = (withFormat: boolean) =>
    JSON.stringify({
      model: env.SAFETY_MODEL ?? DEFAULT_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 80,
      ...(withFormat ? { response_format: { type: "json_object" } } : {}),
    });
  let res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, "content-type": "application/json" },
    body: body(true),
  });
  // Providers that can't do response_format get the bare call — the prompt
  // already carries the JSON contract (same retry as brain.chatContent).
  if (!res.ok && /response_format|json/i.test(await res.text().catch(() => ""))) {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, "content-type": "application/json" },
      body: body(false),
    });
  }
  if (!res.ok) throw new Error(`safety provider ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? "";
  const match = content.match(/\{[\s\S]*\}/);
  const raw = JSON.parse(match ? match[0] : content) as { verdict?: unknown; category?: unknown; reason?: unknown };
  return parseSafetyVerdict(raw);
}

export async function handleCreatorProfileSave(request: Request, env: CreatorProfileEnv): Promise<Response> {
  const r = rest(env);
  if (!r) return err(500, "profile service unconfigured");

  const jwt = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return err(401, "sign in first");
  const uid = await authUserId(r.base, env.SUPABASE_SERVICE_ROLE_KEY!, jwt);
  if (!uid) return err(401, "sign in first");

  // Linked Discord account required — listings key off discord_user_id.
  const profRes = await fetch(`${r.base}/rest/v1/web_profiles?select=discord_user_id&id=eq.${encodeURIComponent(uid)}&limit=1`, { headers: r.headers }).catch(() => null);
  if (!profRes?.ok) return err(502, "upstream error");
  const prof = ((await profRes.json().catch(() => [])) as Array<{ discord_user_id: string | null }>)[0];
  if (!prof?.discord_user_id) return err(403, "Link Discord first. Creator pages sit on top of your published characters.");
  const bannedRes = await fetch(`${r.base}/rest/v1/marketplace_bans?select=discord_user_id&discord_user_id=eq.${encodeURIComponent(prof.discord_user_id)}&limit=1`, { headers: r.headers }).catch(() => null);
  if (!bannedRes?.ok) return err(502, "upstream error");
  if (((await bannedRes.json().catch(() => [])) as unknown[]).length) {
    return err(403, "Your marketplace publishing privileges are suspended.");
  }

  let body: { slug?: unknown; name?: unknown; bio?: unknown; public?: unknown };
  try { body = await request.json() as typeof body; } catch { return err(400, "expected a JSON body"); }
  const fields = {
    slug: normalizeCreatorSlug(typeof body.slug === "string" ? body.slug : ""),
    name: typeof body.name === "string" ? body.name.trim().slice(0, CREATOR_NAME_MAX + 1) : "",
    bio: typeof body.bio === "string" ? body.bio.trim().slice(0, CREATOR_BIO_MAX + 1) : "",
    public: body.public === true,
  };
  const bad = validateCreatorFields(fields);
  if (bad) return err(400, bad.error, { field: bad.field });

  if (!saveAllowed(uid)) return err(429, "Too many saves. Try again in a bit.");

  // Deterministic first line on every field, every save — public or not.
  // Field names are user-facing here, so they get the page's own labels.
  const FIELD_LABEL = { slug: "page address", name: "public name", bio: "bio" } as const;
  for (const [field, text] of [["slug", fields.slug ?? ""], ["name", fields.name], ["bio", fields.bio]] as const) {
    const hit = checkMessageContent(text);
    if (!hit.ok) return err(422, `That can't go on a public page: the ${FIELD_LABEL[field]} trips the content policy (${hit.category}).`, { field, category: hit.category });
  }

  // The model screen only guards text that's actually going public — a save
  // that keeps the page private pays no provider call (publishing always
  // passes through this screen again anyway).
  if (fields.public && env.GROQ_API_KEY) {
    let verdict;
    try { verdict = await screenModelCall(env, creatorProfileSubject(fields)); }
    catch { return err(503, "Content screening is unavailable right now. Try again in a moment."); }
    if (verdict.verdict === "flag") {
      return err(422, `That can't go on a public page: ${verdict.category ? `flagged as ${verdict.category}` : "it trips the content policy"}.`);
    }
  }

  const patch = await fetch(`${r.base}/rest/v1/web_profiles?id=eq.${encodeURIComponent(uid)}`, {
    method: "PATCH",
    headers: { ...r.headers, "content-type": "application/json", prefer: "return=minimal" },
    body: JSON.stringify({
      creator_slug: fields.slug,
      creator_name: fields.name.slice(0, CREATOR_NAME_MAX),
      creator_bio: fields.bio.slice(0, CREATOR_BIO_MAX),
      creator_public: fields.public,
      updated_at: new Date().toISOString(),
    }),
  }).catch(() => null);
  if (!patch) return err(502, "upstream error");
  if (patch.status === 409) return err(409, "That address is taken — try another.", { field: "slug" });
  if (patch.status === 400 || patch.status === 422) {
    // CHECK violation (format/reserved — defense in depth behind validation)
    // or unique violation reported as 400 by PostgREST.
    const t = await patch.text().catch(() => "");
    if (/web_profiles_creator_slug_key|duplicate key/i.test(t)) return err(409, "That address is taken — try another.", { field: "slug" });
    if (/creator_slug_format|check constraint/i.test(t)) return err(400, "That address isn't available.", { field: "slug" });
    return err(400, "Save rejected.");
  }
  if (!patch.ok) return err(502, "upstream error");
  return Response.json({ slug: fields.slug, public: fields.public });
}
