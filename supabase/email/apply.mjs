#!/usr/bin/env node
// Applies the branded auth-email templates to the hosted Supabase project via
// the Management API. Hosted templates don't live in config.toml (that's
// local-dev only) — they ride on the project's auth config.
//
//   SUPABASE_ACCESS_TOKEN=sbp_... node supabase/email/apply.mjs [--check]
//
// Get a personal access token at https://supabase.com/dashboard/account/tokens
// (classic sbp_ token, not a project key). --check prints the live subjects +
// body lengths without writing — useful before and after applying.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REF = "tfukkoektmsrolykliop";
const API = `https://api.supabase.com/v1/projects/${REF}/config/auth`;
const dir = fileURLToPath(new URL(".", import.meta.url));
const read = f => readFileSync(dir + f, "utf8");

const TEMPLATES = [
  ["confirmation", "Confirm your Characterly account", "confirm-signup.html"],
  ["magic_link", "Your Characterly sign-in link", "magic-link.html"],
  ["recovery", "Reset your Characterly password", "reset-password.html"],
  ["email_change", "Confirm your new Characterly email", "change-email.html"],
];

const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.error("SUPABASE_ACCESS_TOKEN is not set — create one at https://supabase.com/dashboard/account/tokens");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const checkOnly = process.argv.includes("--check");

// Sanity gate: every template must contain its confirmation link variable or
// the email is a dead letter — catch a corrupted file before it goes live.
for (const [, , file] of TEMPLATES) {
  if (!read(file).includes("{{ .ConfirmationURL }}")) {
    console.error(`${file} is missing {{ .ConfirmationURL }} — refusing to apply.`);
    process.exit(1);
  }
}

const res = await fetch(API, { headers });
if (!res.ok) {
  console.error(`GET config failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const live = await res.json();
for (const [key, subject] of TEMPLATES) {
  const subKey = `mailer_subjects_${key}`;
  const tplKey = `mailer_templates_${key}`;
  console.log(`${key.padEnd(12)} subject: ${JSON.stringify(live[subKey] ?? null)}  body: ${String(live[tplKey] ?? "").length} chars`);
}
if (checkOnly) process.exit(0);

const patch = {};
for (const [key, subject, file] of TEMPLATES) {
  patch[`mailer_subjects_${key}`] = subject;
  patch[`mailer_templates_${key}`] = read(file);
}
const wr = await fetch(API, { method: "PATCH", headers, body: JSON.stringify(patch) });
if (!wr.ok) {
  console.error(`PATCH failed: ${wr.status} ${await wr.text()}`);
  process.exit(1);
}
console.log(`\nApplied ${TEMPLATES.length} templates + subjects. Re-check with --check, or send a test signup.`);
