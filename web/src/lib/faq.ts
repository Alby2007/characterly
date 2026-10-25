// The landing FAQ. One source feeds both the visible answers and the FAQPage
// JSON-LD, so they can't drift. `html` may hold links and <code>; the JSON-LD
// gets the tag-stripped text.
import { PLANS } from "./config";

export type Faq = { q: string; html: string };
export type FaqGroup = { title: string; items: Faq[] };

export const FAQ: FaqGroup[] = [
  {
    title: "Getting started",
    items: [
      { q: "Is Characterly free?", html: `Yes. Every companion runs on our hosted models with ${PLANS.free.dailyTokens} free tokens a day, with no API key or setup. Free covers your awakened companion and one adopted character. <a href="#pricing">Premium</a> ($${PLANS.premium.monthly}/month) raises that to ${PLANS.premium.dailyTokens} a day with live memory and web tools. If you already run your own provider key, you can connect it in Discord for unlimited use instead.` },
      { q: "What's the difference between awakened and adopted?", html: "An awakened companion is shaped by your first conversation in DMs, so nobody else has one like it. Adopted companions come off the community shelf: someone designed them, you take home your own version, and it remembers you from the first hello." },
      { q: "Can I bring a character I already have?", html: `Yes. <code>/companion import</code> reads standard character cards (<code>.png</code> or <code>.json</code>), the same format card-sharing tools use, and so does the import on your dashboard. The imported character is private to you unless you publish it, and a <code>.jsonl</code> chat export can carry your history over. <a href="/guides/import-character-cards">How to import a character card</a> · <a href="/guides/leaving-character-ai">coming from Character.AI?</a>` },
      { q: "Can I have more than one companion?", html: "Your awakened companion is one per account, permanent once awakened. On top of that you can adopt characters off the shelf: one at a time on Free, unlimited on Premium. Each keeps its own private memory of you." },
      { q: "What are tokens?", html: `Hosted chat spends tokens: one for your message, one for your companion's reply. Free refills to ${PLANS.free.dailyTokens} each day and Premium to ${PLANS.premium.dailyTokens}. Premium members can buy token packs that never expire, and purchased tokens stay spendable even if Premium ends.` },
    ],
  },
  {
    title: "Memory and privacy",
    items: [
      { q: "Who can see what my companion remembers?", html: "You can, with <code>/memory list</code> and <code>/memory export</code> in Discord, or the memory panel on your dashboard, which shows the facts, journal and story recap each companion holds and lets you pin, edit or forget any of it. Roleplay stays fiction: story moments never become facts about the real you. Memories about you only form if you've opted in, and things said in your DMs never surface to other people in a server." },
      { q: "How do I delete my data?", html: "<code>/opt-out</code> forgets your memories, deletes your profile and revokes consent, and journal entries about you go too. <code>/memory forget</code> removes a single memory, and the dashboard does the same. Removing the bot from a server wipes everything it stored there." },
      { q: "How do you keep the community safe?", html: `The shelf is SFW-only: every listing is screened at publish and again on every edit, every reply from an adopted character is checked before it posts, and reports go to human review. If a companion sees signs you're struggling, it breaks character to point you toward real crisis lines. The full picture is on the <a href="/safety">safety page</a>.` },
    ],
  },
  {
    title: "Servers",
    items: [
      { q: "Do I need to add the bot to my own server?", html: "No. You can chat with your characters right here on the web, or in private threads in the Characterly server. Add the bot to your own server only when you want to bring companions into your channels." },
      { q: "What happens if Characterly leaves a server?", html: "Everything it stored for that server is deleted: the archive, memories and settings. Your companion itself, and the journal it keeps in your DMs, are untouched." },
      { q: "What permissions does the bot need?", html: "View channels, send messages, read message history, manage webhooks (that's how companions get their own name and avatar), embed links, attach files and add reactions. It never asks for administrator." },
    ],
  },
];

const stripTags = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");

export const faqJsonLd = () => ({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.flatMap(g => g.items).map(f => ({
    "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: stripTags(f.html) },
  })),
});
