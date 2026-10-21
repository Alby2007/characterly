---
target: landing page
total_score: 22
max_score: 32
na_heuristics: 7,10
p0_count: 0
p1_count: 3
target_identity: "file:C:\\Users\\alber\\CascadeProjects\\characterly\\website\\index.html"
target_fingerprint: "sha256:add19c75e0251cdc4e2214bd25d0380fa23277c316d8efb33bf246ae0095e485"
target_path: "C:\\Users\\alber\\CascadeProjects\\characterly\\website\\index.html"
timestamp: 2026-10-21T09-32-25Z
slug: website-index-html
---
# Critique: website/index.html (landing)

Method: dual-agent. Score 22/32 (n/a: 7, 10) — Acceptable (69%).

Heuristics: 1=3, 2=2, 3=3, 4=2, 5=3, 6=3, 7=n/a, 8=3, 9=3, 10=n/a.

Specificity: strongly authored visual system (The Familiar, real product figures, memory receipt). Weakness is audience: not specific to Character-AI migrants; H1 sells awaken/adopt instead of the pairing (remembers you + moves between DMs and servers).

Detector: 3 findings — low-contrast (false positive, .msg-av real color ~6.4:1), flat-type-hierarchy (false positive, CSS not applied), em-dash-overuse (real, 32). Overlay blocked by dev-server CSP.

Priority issues:
- [P1] First viewport doesn't address migrants or show the pairing; import absent from hero. -> clarify
- [P1] Invented proof in fig. i embed: "@alby", "41 ratings" (index.html:260-261). -> harden
- [P1] CTA path: raw discord.gg invites, no OAuth entry, no "what happens next" microcopy, closing "Add the bot to yours" contradicts FAQ. -> clarify, onboard
- [P2] #bring import section under-built: no figure, no guide link, low on page. -> layout
- [P2] Length/repetition: 5-item ledger orphan, 6 notes, 6 vows, 11 FAQ, repeated claims. -> distill

Minor: green "Add Nyx" (.dbtn.go #3b7a57) off-palette; two gold buttons per view vs One Candle rule (rule may be too strict); og/meta lead with "community"; "settle on the hour" opaque; pack expiry on Premium lapse unstated; nav wraps 900–1150px; slow reveal blank first frame.
