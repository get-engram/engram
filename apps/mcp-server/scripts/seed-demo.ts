/**
 * Seed a demo Engram org with realistic sample conversations so an app-store
 * reviewer can immediately see memory store + recall working.
 *
 * Prereq: a demo account already exists and you have its API key. The reviewer
 * logs in via OAuth (which provisions the org); grab that org's API key from
 * the dashboard, then run:
 *
 *   ENGRAM_API_KEY=engram_sk_live_... \
 *   ENGRAM_API_URL=https://mcp.getengram.app \
 *   pnpm --filter @getengram/mcp-server seed:demo
 *
 * Idempotency: re-running appends fresh conversations; delete the org's
 * conversations first if you want a clean slate.
 */
import { Engram } from "@getengram/sdk";

const apiKey = process.env.ENGRAM_API_KEY;
const baseUrl = process.env.ENGRAM_API_URL ?? "https://mcp.getengram.app";

if (!apiKey) {
  console.error("ENGRAM_API_KEY is required (the demo org's API key).");
  process.exit(1);
}

interface DemoConversation {
  title: string;
  tags: string[];
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

// Generic, professional demo content — shows the kinds of durable context
// Engram is built to remember (decisions, preferences, facts, projects).
const DEMO: DemoConversation[] = [
  {
    title: "Rate limiting approach",
    tags: ["architecture", "api", "decision"],
    messages: [
      { role: "user", content: "For our public API, should we use a token bucket or a sliding window for rate limiting?" },
      { role: "assistant", content: "We decided on a sliding-window log keyed per API key, backed by Redis, because it gives smoother enforcement than a fixed window and avoids the burst-at-the-boundary problem. Limit: 120 req/min on the Pro tier." },
    ],
  },
  {
    title: "Writing style preferences",
    tags: ["preferences", "writing"],
    messages: [
      { role: "user", content: "When you draft things for me, keep them short and skip the preamble. No 'I'd be happy to'." },
      { role: "assistant", content: "Noted: concise, direct, no filler or preamble. Lead with the answer. Prefer bullet points over long paragraphs for anything with more than two items." },
    ],
  },
  {
    title: "Q3 product goals",
    tags: ["product", "planning", "goals"],
    messages: [
      { role: "user", content: "What are we focused on this quarter?" },
      { role: "assistant", content: "Q3 priorities: (1) ship the public API + SDK, (2) launch the usage dashboard, (3) reduce p95 search latency under 200ms. Stretch goal: a self-serve onboarding flow." },
    ],
  },
  {
    title: "Database choice for the new service",
    tags: ["architecture", "database", "decision"],
    messages: [
      { role: "user", content: "Postgres or SQLite at the edge for the new metadata service?" },
      { role: "assistant", content: "Chose SQLite at the edge (D1) for the metadata service: the data is small, read-heavy, and per-tenant isolated, so global edge reads beat a central Postgres on latency. We'll revisit if write contention becomes an issue." },
    ],
  },
];

async function main() {
  const engram = new Engram({ apiKey: apiKey as string, baseUrl });
  console.log(`Seeding ${DEMO.length} demo conversations → ${baseUrl}`);

  for (const conv of DEMO) {
    const { conversationId } = await engram.createConversation({
      title: conv.title,
      agentId: "demo",
      tags: conv.tags,
    });
    await engram.store({ conversationId, messages: conv.messages });
    console.log(`  ✓ ${conv.title}  (${conversationId})`);
  }

  // Prove recall works end-to-end.
  const probe = "what did we decide about rate limiting?";
  const { results } = await engram.search({ query: probe, limit: 3 });
  console.log(`\nSearch "${probe}" → ${results.length} result(s):`);
  for (const r of results) {
    console.log(`  • (${r.conversationId}) ${(r.chunkText ?? "").slice(0, 100)}…`);
  }
  console.log("\nDone. Use these credentials in the submission's testing guidelines.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
