// Scope-prefix helpers. A "scope" (guild_id everywhere) names a data
// partition: a Discord guild id, a 1:1 user bond (`dm:<discord_id>` or
// `web:<uuid>`), or an internal bucket (`hosted:global`). User scopes share
// semantics that differ from guilds — live memory/reply defaults, the DM
// daily cap, exclusion from the zombie-guild sweep — so the check lives in
// one place: a new user-scope prefix must be added HERE, not at each site.
export const isUserScope = (scope: string): boolean =>
  scope.startsWith("dm:") || scope.startsWith("web:");
