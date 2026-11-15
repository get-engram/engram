/**
 * The corpus and labelled queries for the search relevance benchmark
 * (engram#758). Everything here is invented: no customer text, no real
 * conversation.
 *
 * The shape copies what a real account holds. Short spoken conversations sit
 * next to coding sessions that are mostly tool output, some titles are the
 * auto-generated `project (date time)` kind, one session was saved twice, and
 * conversations range from a day to most of a year old.
 *
 * Changing any text here changes its embedding. Re-record after an edit:
 *   pnpm --filter @getengram/mcp-server bench:record
 */

export type Role = "user" | "assistant" | "tool";

export interface BenchConversation {
  id: string;
  title: string;
  /** Days before "now" the conversation was last updated. */
  ageDays: number;
  tags?: string[];
  messages: Array<[Role, string]>;
}

export interface BenchQuery {
  id: string;
  /** What the case is there to measure. */
  scenario: "semantic" | "keyword" | "tool-noise" | "tool-answer" | "title-recency" | "freshness" | "duplicate" | "filter" | "no-answer";
  query: string;
  /**
   * Groups of conversation ids. Each group is one thing the search should
   * find; any member counts (a session saved twice is one group of two).
   * Empty for a query nothing in the corpus answers.
   */
  relevant: string[][];
  tags?: string[];
  project?: string;
}

// ── Tool output ─────────────────────────────────────────────────────────────
// Long, keyword-dense, and not what anyone is looking for.

const SEARCH_TS_DUMP = `     1	import type { Env } from "../types.js";
     2	import { generateEmbedding } from "./embedding.js";
     3
     4	// Recall tuning. Recency: boost recent conversations. Multiplier decays
     5	// from (1 + weight) at age 0 to 1.0, half-life 30 days.
     6	const RECENCY_WEIGHT = 0.5;
     7	const RECENCY_HALFLIFE_DAYS = 30;
     8	const TITLE_BOOST = 1.4;
     9
    10	export function recencyMultiplier(updatedAt?: string | null): number {
    11	  if (!updatedAt) return 1;
    12	  const t = Date.parse(updatedAt);
    13	  if (Number.isNaN(t)) return 1;
    14	  const ageDays = (Date.now() - t) / 86_400_000;
    15	  if (ageDays <= 0) return 1 + RECENCY_WEIGHT;
    16	  return 1 + RECENCY_WEIGHT * Math.pow(0.5, ageDays / RECENCY_HALFLIFE_DAYS);
    17	}
    18
    19	export function queryTerms(query: string): string[] {
    20	  return [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])];
    21	}
    22
    23	export async function searchConversations(env: Env, organizationId: string, query: string, limit: number) {
    24	  const fetchK = Math.min(limit * 3, 50);
    25	  const filter = { organization_id: organizationId };
    26	  const embedding = await generateEmbedding(env.AI, query);
    27	  const vectorResults = await env.VECTORIZE.query(embedding, { topK: fetchK, filter });
    28	  const vectorRank = new Map<string, number>();
    29	  vectorResults.matches.forEach((m, i) => vectorRank.set(m.id, i));
    30	  // recency half-life 30 days, recency weight 0.5, see the recency constants above
    31	  const boosted = score * recencyMultiplier(meta.updatedAt) * (titleHit ? TITLE_BOOST : 1);
    32	  results.sort((a, b) => b.score - a.score);
    33	  return results.slice(0, limit);
    34	}`;

const SEARCH_TEST_DUMP = `$ pnpm vitest run search-service
 RUN  v4.1.12 /repo/apps/mcp-server

 ✓ src/__tests__/search-service.test.ts (14 tests) 212ms
   ✓ search recall helpers > recencyMultiplier is 1.0 for missing timestamps
   ✓ search recall helpers > recencyMultiplier boosts recent conversations more than old ones
   ✓ search recall helpers > recency half-life is 30 days
   ✓ search recall helpers > queryTerms extracts distinct lowercased terms
   ✓ search service > does not return a messages field on search results
   ✓ search service > truncates chunk_text to the snippet cap with a marker
   ✓ search service > honours a custom snippet_chars parameter
   ✓ search service > recency boost keeps the 30 day half-life
   ✓ search service > ranks a recent conversation above an old one

 Test Files  1 passed (1)
      Tests  14 passed (14)
   Duration  1.31s`;

const WRANGLER_DUMP = `     1	name = "engram-mcp-server"
     2	main = "src/index.ts"
     3	compatibility_date = "2024-12-01"
     4
     5	# deploy with: npx wrangler deploy
     6	[[d1_databases]]
     7	binding = "DB"
     8	database_name = "engram-db"
     9
    10	[[r2_buckets]]
    11	binding = "CONTENT"
    12	bucket_name = "engram-content"
    13
    14	[[vectorize]]
    15	binding = "VECTORIZE"
    16	index_name = "engram-vectors"
    17
    18	[ai]
    19	binding = "AI"
    20
    21	[[routes]]
    22	pattern = "mcp.example.app/*"`;

const DEPLOY_LOG_DUMP = `$ npx wrangler deploy
 ⛅️ wrangler 4.84.1
Total Upload: 1843.22 KiB / gzip: 402.10 KiB
Worker Startup Time: 41 ms
Your Worker has access to the following bindings:
- D1 Databases: DB: engram-db
- R2 Buckets: CONTENT: engram-content
- Vectorize Indexes: VECTORIZE: engram-vectors
- AI: AI
Uploaded engram-mcp-server (9.12 sec)
Deployed engram-mcp-server triggers (2.20 sec)
  mcp.example.app/*
  schedule: * * * * *
Current Version ID: 5d0c2f6e-91aa-4c1e-8f0e-2b1d3a7c9e10
$ npx wrangler deployments list
Created: 2026-11-10T22:31:04Z  Author: ci  Source: Upload  deploy the worker
Created: 2026-11-09T18:02:44Z  Author: ci  Source: Upload  deploy the worker
Created: 2026-11-08T11:15:20Z  Author: ci  Source: Upload  deploy the worker
Created: 2026-11-07T09:48:51Z  Author: ci  Source: Upload  deploy the worker
$ gh run list --workflow main.yml --limit 5
completed  success  Deploy worker  main  push  2m41s
completed  success  Deploy worker  main  push  2m38s
completed  failure  Deploy worker  main  push  1m02s
completed  success  Deploy worker  main  push  2m44s`;

const COMPOSE_DUMP = `     1	services:
     2	  postgres:
     3	    image: postgres:16
     4	    ports:
     5	      - "5432:5432"
     6	  redis:
     7	    image: redis:7
     8	    ports:
     9	      - "6379:6379"
    10	  web:
    11	    build: .
    12	    command: npm run dev
    13	    ports:
    14	      - "3000:3000"
    15	    environment:
    16	      PORT: 3000
    17	      DEV_SERVER_PORT: 3000
    18	  mailhog:
    19	    image: mailhog/mailhog
    20	    ports:
    21	      - "1025:1025"
    22	      - "8025:8025"
$ lsof -i -P | grep LISTEN
node      4121 dev   23u  IPv4  TCP *:3000 (LISTEN)
postgres  4310 dev    7u  IPv4  TCP *:5432 (LISTEN)
redis-ser 4402 dev    6u  IPv4  TCP *:6379 (LISTEN)
com.docke 4498 dev   41u  IPv4  TCP *:8025 (LISTEN)
which port does the dev server run on: see PORT above`;

const PRICING_PAGE_DUMP = `     1	export const PLANS = [
     2	  { id: "free", name: "Free", price: 0, seats: 1, storageMb: 100 },
     3	  { id: "pro", name: "Pro", price: 12, seats: 1, storageMb: 10000 },
     4	  { id: "team", name: "Team", pricePerSeat: 9, minSeats: 2, storageMb: 50000 },
     5	];
     6
     7	export function priceFor(plan: string, seats: number): number {
     8	  const p = PLANS.find((x) => x.id === plan);
     9	  if (!p) throw new Error("unknown plan");
    10	  if (p.pricePerSeat) return p.pricePerSeat * Math.max(seats, p.minSeats ?? 1);
    11	  return p.price ?? 0;
    12	}
    13	// charge per seat: pricePerSeat * seats, see PLANS
    14	export const SEAT_LABEL = "per seat / month";`;

// ── Conversations ───────────────────────────────────────────────────────────

/** One session, saved under two conversations. */
const R2_PLAN_MESSAGES: Array<[Role, string]> = [
  ["user", "The database is close to its size cap. Most of it is chunk text. What is the plan for moving chunk text to R2?"],
  ["assistant", "Three stages. First copy: every save writes each chunk to R2 as well as the database, and a mover copies the rows that already exist. Second clear: empty a row's column only after its R2 copy has been read back and compared. Third rebuild the keyword index once the rows are small."],
  ["user", "Why not clear in the same step as the copy?"],
  ["assistant", "Because the chunk text is what the repair uses to rebuild a lost message body. If a copy failed quietly and we had already cleared the column, that text would be gone. Copy, verify, then clear."],
  ["user", "How long does a row wait before it can be cleared?"],
  ["assistant", "A settle window, so that no write of the same chunk can still be in flight. A row unchanged for the whole window is safe to clear."],
  ["user", "Good. Go with the three stages."],
];

export const CONVERSATIONS: BenchConversation[] = [
  {
    id: "conv_recency_decision",
    title: "Search tuning notes",
    ageDays: 200,
    messages: [
      ["user", "Old memories keep winning over what I worked on last week. Should newer conversations rank higher?"],
      ["assistant", "Yes, but gently. When someone says remember when we were doing X, they nearly always mean something recent. I would multiply the score by a factor that starts at 1.5 for today and decays toward 1."],
      ["user", "How fast should it fade?"],
      ["assistant", "A half-life of 30 days. After a month the bonus is half, after three months it is almost gone. Shorter than that and last month's project disappears; longer and it stops helping."],
      ["user", "Why 30 and not 7?"],
      ["assistant", "Seven days punishes anything from the previous sprint. Thirty matches how people talk about recent work, which is this month. We agreed on 30 days and a weight of 0.5."],
      ["user", "Agreed. Ship it."],
    ],
  },
  {
    id: "conv_tool_search",
    title: "engram (2026-11-13 09:12)",
    ageDays: 2,
    messages: [
      ["user", "open the search service"],
      ["tool", SEARCH_TS_DUMP],
      ["assistant", "Read the file."],
      ["user", "run the tests"],
      ["tool", SEARCH_TEST_DUMP],
      ["assistant", "All passing."],
      ["tool", SEARCH_TS_DUMP],
      ["assistant", "Nothing else to change here."],
    ],
  },
  {
    id: "conv_antonia",
    title: "Intro to Antonia",
    ageDays: 90,
    messages: [
      ["user", "Help me write to Antonia Reyes. She runs partnerships at the bookshop chain and I want to pitch a reading-notes integration."],
      ["assistant", "Keep it to four sentences: who you are, what the integration does for her customers, one number, and a clear ask for a 20 minute call."],
      ["user", "The number is that 40 percent of our users save book notes."],
      ["assistant", "Draft: Hi Antonia, I build a notes app where 40 percent of people save what they read. I think your loyalty members would use a way to keep notes on the books they buy from you. Could we talk for 20 minutes next week?"],
      ["user", "Send it Tuesday morning, she replies fastest then."],
      ["assistant", "Noted: send Tuesday morning, follow up the next Monday if there is no reply."],
    ],
  },
  {
    id: "conv_email_cleanup",
    title: "Email cleanup",
    ageDays: 2,
    messages: [
      ["user", "My inbox is drowning in newsletters. Help me clean up my email."],
      ["assistant", "Start with the senders that mail most often. Unsubscribe from anything you have not opened in a month and filter receipts into their own folder."],
      ["user", "What about the daily deal emails?"],
      ["assistant", "Unsubscribe from all of them. If one matters, you can search for it."],
      ["user", "Done, 46 senders gone."],
      ["assistant", "Good. Check again in a month and repeat for whatever crept back."],
    ],
  },
  {
    id: "conv_port",
    title: "Local dev setup",
    ageDays: 150,
    messages: [
      ["user", "The dev server will not start, it says the address is already in use."],
      ["assistant", "Something else has 3000. The local worker should not share it with the web app anyway."],
      ["user", "Which port should the dev server use then?"],
      ["assistant", "Run the dev server on port 8787. That is the default for the worker runtime, and it leaves 3000 for the web app."],
      ["user", "Works. So the worker dev server is on 8787 and the site stays on 3000."],
      ["assistant", "Yes. I wrote 8787 into the README so the next setup does not hit this again."],
    ],
  },
  {
    id: "conv_support",
    title: "Support reply drafts",
    ageDays: 3,
    messages: [
      ["user", "A customer says their import stopped half way. Draft a reply."],
      ["assistant", "Hi, thanks for telling us. The import stopped because the file was larger than the limit for your plan. Nothing was lost. You can split the export in two and run it again."],
      ["user", "Another one asks how to cancel."],
      ["assistant", "Hi, you can cancel any time from the billing page. Your data stays available until the end of the period you paid for."],
      ["user", "And one who wants a refund for a double charge."],
      ["assistant", "Hi, sorry about the double charge. We have refunded the second payment, it should reach your card in five to ten days."],
    ],
  },
  {
    id: "conv_tool_ports",
    title: "engram (2026-11-11 08:03)",
    ageDays: 4,
    messages: [
      ["user", "show me the compose file and what is listening"],
      ["tool", COMPOSE_DUMP],
      ["assistant", "Listed."],
      ["tool", COMPOSE_DUMP],
      ["assistant", "Same as before."],
    ],
  },
  {
    id: "conv_report",
    title: "Daily report (2026-11-14)",
    ageDays: 1,
    messages: [
      ["user", "What does today's report say?"],
      ["assistant", "Eleven new sign-ups, two from referrals. Storage is at 81 percent of the cap. No failed payments."],
      ["user", "Any errors?"],
      ["assistant", "Three slow queries, none failed. Search volume was normal."],
    ],
  },
  {
    id: "conv_pricing",
    title: "Pricing change",
    ageDays: 60,
    messages: [
      ["user", "The Team plan is not selling at 27 dollars. What should we charge?"],
      ["assistant", "Charge per seat instead of a flat price. Small teams compare against the cost of one more Pro account, so a flat 27 looks expensive for two people."],
      ["user", "What number?"],
      ["assistant", "Nine dollars per seat per month with a minimum of two seats. Two people pay 18, which is under two Pro accounts, and it grows with the team."],
      ["user", "And existing Team customers?"],
      ["assistant", "Keep them on the old price until they change seats. We decided: Team is 9 per seat, minimum 2 seats, starting next month."],
    ],
  },
  {
    id: "conv_tool_pricing",
    title: "engram (2026-11-12 16:40)",
    ageDays: 3,
    messages: [
      ["user", "print the plans file"],
      ["tool", PRICING_PAGE_DUMP],
      ["assistant", "Printed."],
      ["tool", PRICING_PAGE_DUMP],
      ["assistant", "No change."],
    ],
  },
  { id: "conv_r2_plan_a", title: "Database migration plan", ageDays: 75, messages: R2_PLAN_MESSAGES },
  { id: "conv_r2_plan_b", title: "engram (2026-09-01 14:20)", ageDays: 75, messages: R2_PLAN_MESSAGES },
  {
    id: "conv_r2_followup",
    title: "Stage two results",
    ageDays: 40,
    messages: [
      ["user", "How did clearing the chunk text go?"],
      ["assistant", "The clear moved the text of about a million chunks out of the database. Every row was compared with its R2 copy first, and 14 rows whose copy did not match were left in place."],
      ["user", "Did the database shrink?"],
      ["assistant", "Only after we moved each cleared row to a new position. Emptying a cell where it sits frees almost no pages. With the move, the file dropped by a third."],
      ["user", "What is left of the plan for moving chunk text to R2?"],
      ["assistant", "Stage three, rebuilding the keyword index now that the rows are small. Then the migration is finished."],
    ],
  },
  {
    id: "conv_mom",
    title: "Mom's birthday",
    ageDays: 110,
    messages: [
      ["user", "Mom turns 70 in March. I want to plan something."],
      ["assistant", "A dinner with the family is the safe choice. Does she have a favourite place?"],
      ["user", "The Italian place by the river. And I need a present."],
      ["assistant", "She gardens, so a good pair of pruning shears and a rose bush she can plant that week. Or a framed photo of the grandchildren."],
      ["user", "The rose bush is perfect. Book the restaurant for eight people."],
      ["assistant", "Noted: table for eight at the Italian place, rose bush and shears as the present."],
    ],
  },
  {
    id: "conv_gift_sam",
    title: "Gift ideas for Sam",
    ageDays: 20,
    messages: [
      ["user", "Sam's leaving party is Friday. What do I get a colleague who cycles to work?"],
      ["assistant", "A set of good bike lights or a waterproof pannier. Both get used every day."],
      ["user", "Budget is about 40."],
      ["assistant", "Then the lights. A front and rear set is around 35."],
    ],
  },
  {
    id: "conv_running",
    title: "Half marathon training",
    ageDays: 120,
    messages: [
      ["user", "My knee hurts on the outside after long runs."],
      ["assistant", "That pattern is often the band along the outside of the thigh. Cut the long run back and see someone before you add distance."],
      ["user", "I saw the physio today."],
      ["assistant", "What did she say?"],
      ["user", "She said it is not the joint. Two weeks without downhill running, side leg raises every day, and shorter strides. Then build back by ten percent a week."],
      ["assistant", "Noted. No downhill for two weeks, daily leg raises, shorter strides, then ten percent a week. The race is still realistic."],
    ],
  },
  {
    id: "conv_lisbon",
    title: "Lisbon trip",
    ageDays: 200,
    messages: [
      ["user", "Flights are booked for the first week of May. Now somewhere to sleep."],
      ["assistant", "Alfama is the old quarter with the views, but it is steep. Baixa is flat and central."],
      ["user", "Alfama. I found a guesthouse called Casa do Miradouro, four nights."],
      ["assistant", "Good choice. It is a ten minute walk to the tram and close to the viewpoint. Book the airport transfer too, taxis struggle in those streets."],
      ["user", "Booked. Day trip ideas?"],
      ["assistant", "Sintra by train for the palaces, and an evening in Belem for the custard tarts."],
    ],
  },
  {
    id: "conv_tax",
    title: "Company paperwork",
    ageDays: 180,
    messages: [
      ["user", "What do I owe Delaware each year for the company?"],
      ["assistant", "The annual report and franchise tax. For a corporation it is due on March 1 every year."],
      ["user", "How much?"],
      ["assistant", "The minimum is a few hundred dollars if you use the assumed par value method. The default method can show a frightening number, so recalculate before you pay."],
      ["user", "And the registered agent?"],
      ["assistant", "Billed separately, once a year, on the anniversary of when you signed up. Put both dates in the calendar."],
    ],
  },
  {
    id: "conv_deploy",
    title: "Release process",
    ageDays: 30,
    messages: [
      ["user", "How do we get a change to the worker into production?"],
      ["assistant", "Merge the pull request into main. The pipeline checks, does a dry run, applies the database migrations and then publishes the worker. It is live about four minutes after the merge."],
      ["user", "So nobody runs the command by hand?"],
      ["assistant", "Only as a fallback when the pipeline is down. The rule is that deploys come from a merge, never from a laptop."],
      ["user", "And if the release is bad?"],
      ["assistant", "Revert the pull request and merge the revert. That deploys the previous code the same way."],
    ],
  },
  {
    id: "conv_tool_deploy",
    title: "engram (2026-11-10 22:40)",
    ageDays: 5,
    messages: [
      ["user", "show the config and the last deploys"],
      ["tool", WRANGLER_DUMP],
      ["tool", DEPLOY_LOG_DUMP],
      ["assistant", "Listed."],
      ["tool", DEPLOY_LOG_DUMP],
      ["assistant", "Same list."],
    ],
  },
  {
    id: "conv_rate_limit",
    title: "Database overload",
    ageDays: 70,
    messages: [
      ["user", "The admin script died with error 7429 half way through."],
      ["assistant", "7429 is the database refusing work because too many statements arrived at once. The script was sending queries in parallel."],
      ["user", "How do I stop it happening?"],
      ["assistant", "Send one statement at a time and pause between them. The database runs a single statement at once, so parallel requests only queue up and time out."],
      ["user", "It finished this time."],
      ["assistant", "Good. I added the pause to the script so it is paced by default."],
    ],
  },
  {
    id: "conv_goals",
    title: "Goals for the year",
    ageDays: 310,
    messages: [
      ["user", "Let's set goals for 2026."],
      ["assistant", "Pick three you can measure. More than that and none of them get done."],
      ["user", "Reach 500 paying customers, ship the mobile app, and take four full weeks off."],
      ["assistant", "Written down. 500 paying customers by December, the mobile app in the stores by the summer, and four weeks of holiday booked in advance so they happen."],
    ],
  },
  {
    id: "conv_book",
    title: "Book notes",
    ageDays: 250,
    messages: [
      ["user", "I finished Thinking in Systems. Help me keep the main ideas."],
      ["assistant", "Three to hold on to. A system is stocks and the flows that change them. Feedback loops explain why things overshoot or settle. And the places to intervene that look obvious are usually the weakest."],
      ["user", "What was the strongest place to intervene?"],
      ["assistant", "Changing the goal of the system or the beliefs it runs on. Adjusting numbers such as taxes or subsidies comes last on her list."],
    ],
  },
  {
    id: "conv_acme",
    title: "Acme contract",
    ageDays: 100,
    tags: ["client-acme"],
    messages: [
      ["user", "Acme want the reporting dashboard rebuilt. Help me scope it."],
      ["assistant", "Split it into three milestones: the data model, the charts, and the export. Agree what done means for each before you start."],
      ["user", "They need it before their board meeting in June."],
      ["assistant", "Then the data model has to be finished in April. Put the dates in the contract with one round of changes per milestone."],
      ["user", "We settled on 18 thousand for the whole thing, paid in three parts."],
      ["assistant", "Recorded: Acme agreed a budget of 18 thousand, six per milestone, the last one due after the June board meeting."],
      ["user", "Their contact is Priya in finance."],
      ["assistant", "Noted. Invoices go to Priya."],
    ],
  },
  // The same subject discussed twice, months apart. The newer one is current.
  {
    id: "conv_sprint_old",
    title: "Sprint planning",
    ageDays: 170,
    messages: [
      ["user", "What are we working on this sprint?"],
      ["assistant", "Three things this sprint: the import from other chat apps, the billing page, and fixing the slow conversation list."],
      ["user", "Which one first?"],
      ["assistant", "The import. It is what new users ask for most, so the sprint starts there."],
    ],
  },
  {
    id: "conv_sprint_new",
    title: "Sprint planning",
    ageDays: 6,
    messages: [
      ["user", "What are we working on this sprint?"],
      ["assistant", "Three things this sprint: search quality, the mobile app's offline mode, and the failed payment emails."],
      ["user", "Which one first?"],
      ["assistant", "Search quality. It is what people complain about most, so the sprint starts there."],
    ],
  },
  {
    id: "conv_backup_old",
    title: "Backup routine",
    ageDays: 220,
    messages: [
      ["user", "How often do we back up the database?"],
      ["assistant", "Once a week, on Sunday night, to a second bucket. We keep four weekly copies."],
      ["user", "Is that enough?"],
      ["assistant", "For now. Losing up to a week of data is the risk we are accepting."],
    ],
  },
  {
    id: "conv_backup_new",
    title: "Backup routine",
    ageDays: 9,
    messages: [
      ["user", "How often do we back up the database?"],
      ["assistant", "Every night now, to a second bucket, plus a copy before each migration. We keep thirty daily copies."],
      ["user", "Is that enough?"],
      ["assistant", "Yes. The most we can lose is a day, and the restore was tested last week."],
    ],
  },
  // Six conversations that talk about budgets far more than the Acme one does.
  {
    id: "conv_budget_home",
    title: "Household budget",
    ageDays: 35,
    messages: [
      ["user", "Help me make a monthly budget for the house."],
      ["assistant", "List the fixed costs first. Rent, power, insurance and the phone go into the budget before anything else."],
      ["user", "The budget for food keeps going over."],
      ["assistant", "Set a weekly food budget instead of a monthly one. A weekly budget is easier to keep to and the overspend shows sooner."],
      ["user", "What about a budget for fun?"],
      ["assistant", "Give it its own line in the budget, ten percent. A budget with nothing for fun gets abandoned."],
      ["user", "And savings?"],
      ["assistant", "Treat savings as a bill in the budget. Move the money the day you are paid, then budget what is left."],
    ],
  },
  {
    id: "conv_budget_ads",
    title: "Ad budget",
    ageDays: 12,
    messages: [
      ["user", "What budget should I give the ad campaign?"],
      ["assistant", "Start with a small daily budget, enough for about fifty clicks a day. A bigger budget only buys the same lesson faster."],
      ["user", "The platform suggests a budget five times that."],
      ["assistant", "Platforms always suggest a larger budget. Hold the budget where it is until one ad clearly pays for itself."],
      ["user", "After a week the budget is mostly spent and I have one sign-up."],
      ["assistant", "Then pause it. A budget that buys one sign-up is not a budget worth renewing. Rewrite the ad before spending more."],
      ["user", "Paused."],
      ["assistant", "Good. Keep the unspent budget for the next test."],
    ],
  },
  {
    id: "conv_budget_cloud",
    title: "Cloud costs",
    ageDays: 25,
    messages: [
      ["user", "The cloud bill doubled. I need a budget for it."],
      ["assistant", "Set a monthly budget with an alert at 80 percent. A budget nobody is told about is just a number."],
      ["user", "What should the budget be?"],
      ["assistant", "Last quarter's average plus a fifth. Review the budget each quarter and lower it when you remove something."],
      ["user", "Embeddings are the biggest line."],
      ["assistant", "Then give embeddings their own budget line and alert. When one line eats the budget, track it on its own."],
      ["user", "Alerts are set."],
      ["assistant", "Good. The budget review is in the calendar for the first of each quarter."],
    ],
  },
  {
    id: "conv_budget_wedding",
    title: "Wedding planning",
    ageDays: 140,
    messages: [
      ["user", "My sister asked me to help with the wedding budget."],
      ["assistant", "Agree the total budget first, then split it. Venue and food usually take half the budget."],
      ["user", "The venue she likes takes sixty percent of the budget."],
      ["assistant", "Then something else in the budget has to shrink. Flowers and the band are where a budget usually has room."],
      ["user", "She will not move on the band."],
      ["assistant", "Then cut the flower budget and the favours. Keep a tenth of the budget unspent for surprises."],
      ["user", "Agreed."],
      ["assistant", "I wrote the budget down by line so she can see what each choice costs."],
    ],
  },
  {
    id: "conv_budget_marketing",
    title: "Marketing plan",
    ageDays: 55,
    messages: [
      ["user", "Draft a marketing budget for next quarter."],
      ["assistant", "Split the budget three ways: writing, sponsorships and experiments. Most of the budget should go where sign-ups already come from."],
      ["user", "Sponsorships are expensive."],
      ["assistant", "Cap them at a third of the budget. One newsletter sponsorship per month fits that budget."],
      ["user", "And the experiments budget?"],
      ["assistant", "A fixed small budget you expect to lose. If an experiment works, it earns a real budget the quarter after."],
      ["user", "Fine."],
      ["assistant", "The budget is in the plan with a review date at the end of the first month."],
    ],
  },
  {
    id: "conv_budget_trip",
    title: "Road trip costs",
    ageDays: 85,
    messages: [
      ["user", "Three of us are driving up the coast for a week. Budget?"],
      ["assistant", "Fuel, beds and food. Set a budget per day for each and a shared pot for the budget so nobody keeps receipts."],
      ["user", "What daily budget for food?"],
      ["assistant", "Cook breakfast and one other meal and the food budget halves. Eating out three times a day breaks any budget."],
      ["user", "And beds?"],
      ["assistant", "Book the first and last night, leave the middle open. The budget for beds goes further away from the famous towns."],
      ["user", "Sounds right."],
      ["assistant", "Budget per person comes to about what a flight would have cost."],
    ],
  },
];

// ── Queries ─────────────────────────────────────────────────────────────────

export const QUERIES: BenchQuery[] = [
  // Meaning, with little or no wording in common with the answer.
  { id: "sem-portugal", scenario: "semantic", query: "where am I staying in Portugal", relevant: [["conv_lisbon"]] },
  { id: "sem-knee", scenario: "semantic", query: "advice from the physiotherapist about my leg injury", relevant: [["conv_running"]] },
  { id: "sem-tax", scenario: "semantic", query: "when is the yearly state filing for the corporation due", relevant: [["conv_tax"]] },
  { id: "sem-mom", scenario: "semantic", query: "what present did I pick for my mother", relevant: [["conv_mom"]] },
  { id: "sem-rollback", scenario: "semantic", query: "how to undo a bad production release", relevant: [["conv_deploy"]] },
  { id: "sem-systems", scenario: "semantic", query: "most effective leverage point according to the systems book", relevant: [["conv_book"]] },

  // A name or a code that has to match exactly.
  { id: "kw-antonia", scenario: "keyword", query: "Antonia", relevant: [["conv_antonia"]] },
  { id: "kw-7429", scenario: "keyword", query: "error 7429", relevant: [["conv_rate_limit"]] },
  { id: "kw-miradouro", scenario: "keyword", query: "Casa do Miradouro", relevant: [["conv_lisbon"]] },
  { id: "kw-priya", scenario: "keyword", query: "who is Priya", relevant: [["conv_acme"]] },

  // The discussion exists; so does tool output full of the same words.
  { id: "tool-recency", scenario: "tool-noise", query: "why is the recency half-life 30 days", relevant: [["conv_recency_decision"]] },
  { id: "tool-fade", scenario: "tool-noise", query: "how fast should the recency boost fade", relevant: [["conv_recency_decision"]] },
  { id: "tool-deploy", scenario: "tool-noise", query: "how do we deploy the worker", relevant: [["conv_deploy"]] },
  { id: "tool-port", scenario: "tool-noise", query: "which port does the dev server run on", relevant: [["conv_port"]] },
  { id: "tool-seat", scenario: "tool-noise", query: "how much do we charge per seat", relevant: [["conv_pricing"]] },

  // Only tool output holds the answer. Ranking tool output lower must not
  // hide it when nothing spoken competes.
  { id: "toolans-startup", scenario: "tool-answer", query: "worker startup time", relevant: [["conv_tool_deploy"]] },
  { id: "toolans-mailhog", scenario: "tool-answer", query: "which image does mailhog use", relevant: [["conv_tool_ports"]] },
  { id: "toolans-tests", scenario: "tool-answer", query: "how many search-service tests passed", relevant: [["conv_tool_search"]] },
  { id: "toolans-storage", scenario: "tool-answer", query: "storageMb for the pro plan", relevant: [["conv_tool_pricing"]] },

  // The answer is old or plainly titled; newer conversations have titles that
  // contain a query word.
  { id: "title-email", scenario: "title-recency", query: "email to Antonia", relevant: [["conv_antonia"]] },
  { id: "title-engram", scenario: "title-recency", query: "what did we decide about engram team pricing", relevant: [["conv_pricing"]] },
  { id: "title-2026", scenario: "title-recency", query: "goals for 2026", relevant: [["conv_goals"]] },
  { id: "title-report", scenario: "title-recency", query: "report from the physio", relevant: [["conv_running"]] },
  { id: "title-support", scenario: "title-recency", query: "port for local development", relevant: [["conv_port"]] },

  // Two conversations answer equally well. The newer one is the current answer.
  { id: "fresh-sprint", scenario: "freshness", query: "what are we working on this sprint", relevant: [["conv_sprint_new"]] },
  { id: "fresh-backup", scenario: "freshness", query: "how often is the database backed up", relevant: [["conv_backup_new"]] },
  { id: "fresh-backup-kw", scenario: "freshness", query: "backup copies", relevant: [["conv_backup_new"]] },

  // One session saved twice, plus a second conversation on the same subject.
  {
    id: "dup-r2",
    scenario: "duplicate",
    query: "plan for moving chunk text to R2",
    relevant: [["conv_r2_plan_a", "conv_r2_plan_b"], ["conv_r2_followup"]],
  },
  {
    id: "dup-settle",
    scenario: "duplicate",
    query: "why copy and verify before clearing the column",
    relevant: [["conv_r2_plan_a", "conv_r2_plan_b"]],
  },

  // A filter that only one conversation passes, on a subject many discuss.
  { id: "filter-tag", scenario: "filter", query: "budget", tags: ["client-acme"], relevant: [["conv_acme"]] },
  { id: "filter-project", scenario: "filter", query: "budget", project: "Acme", relevant: [["conv_acme"]] },
  { id: "filter-tag-agreed", scenario: "filter", query: "what budget did we set", tags: ["client-acme"], relevant: [["conv_acme"]] },

  // Nothing saved answers these. The right result is an empty page.
  { id: "none-sourdough", scenario: "no-answer", query: "sourdough starter feeding schedule", relevant: [] },
  { id: "none-k8s", scenario: "no-answer", query: "kubernetes ingress certificate renewal", relevant: [] },
  { id: "none-dentist", scenario: "no-answer", query: "when is my dentist appointment", relevant: [] },
  { id: "none-guitar", scenario: "no-answer", query: "guitar chord progression for the chorus", relevant: [] },
  { id: "none-visa", scenario: "no-answer", query: "visa requirements for travelling to Japan", relevant: [] },
  { id: "none-tax", scenario: "no-answer", query: "when is the quarterly tax payment due", relevant: [] },
  { id: "none-recipe", scenario: "no-answer", query: "recipe for chicken soup", relevant: [] },
  { id: "none-car", scenario: "no-answer", query: "what did the mechanic say about the brakes", relevant: [] },
  { id: "none-python", scenario: "no-answer", query: "python asyncio event loop is closed error", relevant: [] },
  { id: "none-wifi", scenario: "no-answer", query: "wifi password for the office", relevant: [] },
  { id: "none-flight", scenario: "no-answer", query: "flight number for the trip to Berlin", relevant: [] },
  { id: "none-lease", scenario: "no-answer", query: "when does the apartment lease end", relevant: [] },
];

/** The instruction bge-base-en-v1.5 expects in front of a retrieval query. */
export const QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: ";
