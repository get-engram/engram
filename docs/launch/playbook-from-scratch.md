# Playbook: Launching a SaaS from scratch

This is a step-by-step replay of everything we did — corporate, legal, infra, product, distribution — to take Engram from "idea in my head" to "live at getengram.app with a trademark filed and an MCP endpoint agents can actually use." It's written so you can follow it for the next company without having to re-derive the order.

Assumptions:

- You're a solo founder or a tiny team (1–3 people).
- You're building a developer-focused SaaS that needs a domain, a live service, and eventual paid customers.
- You're based in the US and want to form a Delaware LLC (swap in your jurisdiction if different).
- You already know what you're building — this doc is about the *surrounding* work, not the product itself.

Legend:
- **[fast]** — can be done in under 30 minutes
- **[wait]** — involves external review / government processing, start early
- **[money]** — has a meaningful cost attached

---

## Phase 0: naming

Everything downstream depends on the name. Lock it before you do anything else.

1. **Brainstorm 5–10 candidate names.** Short, pronounceable, memorable. Avoid names that are literal descriptions of what you do (they age badly) and avoid anything that's a common English word (trademark impossible).
2. **Search USPTO TESS** at `tmsearch.uspto.gov` for each candidate. Any live mark in your class (typically 9 or 42 for software/SaaS) is a blocker. A dead mark is a weak signal — they can come back.
3. **Search google** + `site:github.com` + `site:ycombinator.com` for each candidate. You're looking for existing open source projects, abandoned startups, or HN launches with the same name. A conflict here isn't fatal but raises your trademark risk.
4. **Check the `.app`, `.com`, `.ai`, `.dev` domain availability.** Use `whois` or `namecheap` — `.app` is usually cleanest for a dev-focused launch. `.com` is often taken.
5. **Check social handles** (`x.com/name`, `github.com/name`, `npmjs.com/~name`). If any of these are taken by someone active, pick another name.
6. **Pick one.** Don't re-litigate. Trust the first pass.

**What we did:** Engram. Class 9 and 42 clear at filing time. `getengram.app` available, `npm @getengram/*` scope available, `github.com/get-engram` org available.

---

## Phase 1: the legal entity [wait] [money]

Before you spend money on anything serious, incorporate. Not because you need it for infra, but because you need to own IP under a company, not personally.

1. **Decide structure.** LLC or C-Corp. LLC is simpler and cheaper for bootstrapped; C-Corp is required for YC and standard VC. If you're not sure, LLC first — you can convert later.
2. **Pick a state.** Delaware is the default for US software companies. Wyoming is cheaper. Your home state is simplest if you have no funding ambitions.
3. **Form the entity.** Use Stripe Atlas ($500, easiest), Firstbase, or do it yourself via the state's website ($90–$300 depending on state). Delaware LLC filing is ~$110 + registered agent (~$50–$200/yr).
4. **Get an EIN.** Free, 10 minutes, at `irs.gov/ein`. Required for a bank account.
5. **Open a business bank account.** Mercury is the default for tech startups (no fees, works with Atlas). Bring your formation docs and EIN.
6. **Operating agreement.** Atlas gives you a template. Sign it. It matters the day you have a co-founder or sell equity.

**What we did:** Get Engram LLC, Delaware. Delaware LLCs let you exist with a single member and minimal filing overhead, and if we ever raise real money we'll convert to C-Corp.

---

## Phase 2: IP & brand protection [wait] [money]

Trademarks take 8–12 months. File early or you'll be stuck using an un-protected name at launch.

1. **Trademark search.** USPTO TESS again, this time seriously. If you're not confident, a flat-fee trademark attorney is ~$300 and worth it.
2. **File the trademark application.** USPTO TEAS Plus, ~$250/class. Typical SaaS: Class 9 (software) and Class 42 (SaaS services). Budget ~$500.
3. **Save the serial number.** You'll be asked for it at various points (investor DD, licensing, opposition monitoring).
4. **Set up brand basics:**
   - Logo (simple — a text wordmark is fine for v1)
   - Color palette (one primary, one accent, one neutral)
   - Favicon (32x32 + 180x180 apple-touch-icon + a `favicon.ico` fallback)

**What we did:** USPTO serial 99755255, filed 2026-04-09. Class 9 + 42.

---

## Phase 3: domain & DNS [fast] [money]

1. **Buy the domain.** Cloudflare Registrar (at-cost pricing, no upsells) or Namecheap. Expect $12–$20/yr for `.app`, ~$80/yr for `.ai`.
2. **Move the domain to Cloudflare** if you didn't buy it there. Free DNS, SSL, and it's the nameserver you're going to want for everything else.
3. **Set up these DNS records upfront:**
   - `@` A/AAAA → your apex target (often Vercel/Cloudflare Pages/Workers)
   - `www` CNAME → apex
   - `mcp` CNAME → your Worker (if you're running an MCP server)
   - `api` CNAME → your API host
   - MX + SPF + DKIM + DMARC for email (via Google Workspace or Fastmail)
4. **Google Workspace** ($6/user/mo) for `you@yourdomain.app`. Everybody will email your domain — have a mailbox that isn't `@gmail.com`.
5. **Set up `_dmarc` record at `p=quarantine` or stricter.** Skipping DMARC is how launch emails hit spam.

**What we did:** `getengram.app` via Cloudflare Registrar, `mcp.getengram.app` CNAMED to the Worker, Workspace for `@getengram.app` email.

---

## Phase 4: infra foundation [fast]

1. **Pick your runtime.** For Engram it was Cloudflare Workers + D1 + Vectorize + Workers AI, because the write path is one network hop. For yours it may be Fly, Railway, Vercel, Supabase. Pick the one where your hot-path request has the fewest hops and you don't own any ops.
2. **Provision accounts upfront:**
   - Cloudflare (dashboard + `wrangler` CLI)
   - Vercel (for the marketing site / docs)
   - GitHub organization (not personal)
   - npm organization (matching your GitHub scope)
3. **Standard monorepo layout.** Turborepo + pnpm workspaces. Directories:
   - `apps/<service>/` — deployable units
   - `packages/shared/` — shared types and utilities
   - `packages/db/` — schema and query helpers
   - `packages/sdk/` — your public SDK
4. **CI from day one.** GitHub Actions with:
   - `lint` + `typecheck` on every push
   - `test` on every push
   - `deploy` on merge to `main` (with `workflow_dispatch` escape hatch)
5. **Secrets management.** Use Cloudflare secrets (for Workers), Vercel env vars (for the site), and a `.env.example` committed to the repo. Never commit `.env`.

**What we did:** Turborepo + pnpm. `apps/mcp-server` (Cloudflare Worker), `packages/shared`, `packages/db`, `packages/sdk`, `apps/cli`. GitHub Actions on `.github/workflows/{main,pr}.yml`.

---

## Phase 5: the product [wait]

This is the part you already know how to do. The playbook is just:

1. **Build the smallest version that's genuinely useful to one real user (you).**
2. **Dogfood for at least a week before thinking about launch.** Fix the annoyances you hit.
3. **Write tests for the contracts that cross a process boundary.** Types alone aren't enough — you need wire tests.
4. **Don't build for scale you don't have.** No queues until you have backpressure. No caching until you have reads. No hybrid search until you have query volume.

---

## Phase 6: billing, tiers, auth [wait] [money]

1. **Stripe account.** Activate with your LLC details. You'll need EIN and a business bank account (phase 1).
2. **Decide tiers.** A typical developer SaaS:
   - **Free** — enough to evaluate, not enough to replace the paid plan
   - **Pro** — solo paid tier, $20–$50/mo
   - **Team** — per-seat pricing, $40–$100/seat/mo
   - **Enterprise** — contact sales, for the handful who'll actually pay you $10k+
3. **Implement limits before you implement billing.** Users enforce themselves against free tiers if the tier is clearly communicated and the limit is visible.
4. **Stripe Billing, not Stripe Checkout.** You want metered billing and subscriptions, not one-off payments.
5. **API key authentication.** Prefix the key (`prod_sk_live_...`), store a hash, never log the raw value. Put the organization lookup on a D1/Postgres index.

**What we did:** Free 1,000 msgs/mo, Pro $39/mo 100k msgs, Team $49/seat 500k msgs. API keys prefixed `engram_sk_live_*`.

---

## Phase 7: the marketing site [fast]

1. **One-page landing.** Hero, three-feature bullets, code snippet, signup. Don't build a 12-page site before you have customers.
2. **Docs site from day one.** Nextra (Next.js) or Mintlify. Docs convert better than landing pages for developer tools.
3. **Required pages:**
   - `/` — landing
   - `/docs/getting-started` — can they install it in 2 minutes?
   - `/docs/api-reference` — every endpoint/tool
   - `/pricing`
   - `/privacy` — required for GDPR and app-store distribution
   - `/terms` — required for Stripe activation
4. **SEO + GEO (Generative Engine Optimization):**
   - `sitemap.xml` with every public page
   - `robots.txt` allowing everything you want indexed
   - JSON-LD `Organization` + `SoftwareApplication` schemas on the landing page
   - JSON-LD `FAQPage` on the FAQ
   - JSON-LD `BreadcrumbList` + `TechArticle` on every docs page
   - `/llms.txt` at the root, following the emerging convention — this is how LLMs with browse tools understand your product in one shot
5. **`/whitepaper` page** with a long-form, first-principles explanation of what your product is for. This becomes the most-linked document and the one LLMs cite when someone asks about your category.

**What we did:** Nextra on `getengram.app`. Full JSON-LD coverage (Organization, SoftwareApplication, FAQPage, TechArticle, BreadcrumbList). `llms.txt`. A `/whitepaper` on agent-authored project tracking.

---

## Phase 8: analytics & observability [fast]

Pick one of each and stop:

1. **Product analytics:** PostHog (self-hostable, generous free tier) or Plausible (simpler, privacy-first). Skip Google Analytics.
2. **Error tracking:** Sentry. Wire it into both the marketing site and the backend.
3. **Logging:** Cloudflare's Logpush → R2 if you're on Workers. Otherwise Axiom or Better Stack. Don't use Datadog at this stage — it's $$$.
4. **Uptime monitoring:** Better Stack's uptime product, or UptimeRobot. Ping your MCP endpoint + your landing page + your docs every minute.
5. **Status page:** Better Stack or `statuspage.io`. Even if you never have an outage, linking to a status page signals seriousness.

---

## Phase 9: developer experience [fast]

For a developer tool, DX *is* the product. The difference between "I'll try it later" and "I installed it" is whether the `npm install` → working state takes 2 minutes or 20.

1. **npm package** published from CI, not your laptop. Use changesets + `pnpm publish` in GitHub Actions.
2. **SDK** in TypeScript first. It's the language of most MCP clients. Type every field. Export your public types.
3. **CLI** that wraps the SDK. `npx @yourcompany/cli <cmd>` is a zero-install test drive.
4. **`/docs/getting-started`** that works in under 2 minutes. Test it on a fresh machine, not yours.
5. **Integration guides** for every client you support (Claude Desktop, Cursor, Windsurf, Zed, Codex, Claude Code). Each guide is a separate page — they rank individually in search and each is a conversion surface.
6. **Example repos** in a `/examples` directory in your GitHub org. Nothing sells a SaaS like "clone this, run one command, see it work".

**What we did:** `@getengram/sdk`, `@getengram/cli`, guides for Claude Desktop/Cursor/Windsurf/Claude Code/Codex/custom clients, auto-publish on merge.

---

## Phase 10: distribution

You're ready to launch. These are the channels, in rough order of impact for a devtool:

1. **Show HN.** See `show-hn.md` in this directory for the full playbook. This is the single biggest launch surface for dev tools.
2. **Category directories.** Get listed in `awesome-<your-category>-servers` / `awesome-<your-category>`-style lists. For MCP: `punkpeye/awesome-mcp-servers`, `glama.ai/mcp/servers`. See `awesome-mcp-servers-pr.md` for the format.
3. **A technical blog post** explaining *how* you built the thing, not *what* it does. This is the single best piece of evergreen content you can write. Cross-post to dev.to, Hashnode, and pitch to your cloud provider's blog (they're always hungry for well-written posts that show off their platform).
4. **Twitter/X thread** with a short demo video. Under 2 minutes. Caption everything — most people watch muted.
5. **Reddit** in the relevant subreddits (`r/LocalLLaMA`, `r/ClaudeAI`, `r/mcp` — pick the ones where the rules allow self-promotion).
6. **Discord communities.** MCP has an active Discord at glama.ai/mcp/discord. Join, don't spam, contribute, then mention your tool when relevant.
7. **Newsletter submissions:** TLDR Newsletter, Pointer, Console Dev. Each has a submission form. Hit them the day of your HN launch.

Don't do all of these on day one. Show HN → listings → blog post is the first week. The rest can come later.

---

## Phase 11: the first customer

You're going to do several things wrong the first time someone pays you real money. That's fine. Here's what to have ready:

1. **A support email** (`support@yourdomain.app`) that goes somewhere you actually check. Not a ticket system — just an inbox.
2. **A webhook receiver** for Stripe events so you can handle subscription changes, disputes, and cancellations automatically.
3. **A way to grant credit/refund** without touching code. Manual fix via Stripe dashboard is fine at this stage.
4. **An onboarding email sequence.** Three emails: day 0 ("welcome, here's how to start"), day 2 ("here's a common pattern we didn't cover"), day 7 ("how's it going, any questions?"). Don't automate more than this.
5. **A cancellation exit survey.** One question: "what would have made you stay?" Read every response.

---

## Phase 12: ongoing hygiene

The stuff you'll forget to do if you don't schedule it:

- **Rotate API keys and secrets quarterly.** Document the rotation playbook in your repo.
- **Review Stripe disputes weekly.** Auto-refund obvious fraud, fight real disputes.
- **Monthly billing reconciliation.** Stripe revenue → bank → books. Use Pilot, Bench, or a bookkeeper.
- **Annual Delaware franchise tax.** Due March 1. LLC flat $300. Don't miss it.
- **Annual state registered-agent renewal.** Your agent will email you.
- **Trademark publication monitoring.** Once your mark publishes, anyone can oppose within 30 days. Set a calendar reminder.
- **Backup strategy.** D1 exports, Vectorize snapshots, Stripe data exports. Write the restore runbook before you need it.

---

## What to skip until you actually need it

Don't build these on day one. They will feel urgent and they aren't:

- Kubernetes / self-hosted anything
- A custom billing system
- A mobile app
- A SOC 2 certification (wait for the first enterprise customer who asks)
- A multi-region read replica
- A GraphQL gateway
- A design system
- A feature flag service
- A data warehouse + BI stack
- An observability pipeline more complex than "Sentry + Cloudflare logs"
- Anything where the answer to "why are we building this?" is "we might need it later"

---

## Timeline, ballpark

This is *not* a prescription, just a rough shape of how the phases stack:

- **Week 0:** Phase 0 (naming) and Phase 1 (legal entity filed). Phase 2 trademark application submitted at the end of this week — it starts its 8-month waiting period and you can ignore it.
- **Week 1:** Phase 3 (domain + DNS), Phase 4 (infra), Phase 5 begins (product).
- **Weeks 2–6:** Phase 5 full-time. You're dogfooding by week 3.
- **Week 7:** Phase 6 (billing + auth), Phase 7 (marketing site). Lock the pricing.
- **Week 8:** Phase 8 (analytics), Phase 9 (SDK/CLI/docs polish).
- **Week 9:** Phase 10 (launch). Show HN on a Tuesday.
- **Week 10+:** Phase 11 (first customers), Phase 12 (hygiene).

If you hit week 6 and you're not dogfooding your own product yet, stop and figure out why. The product isn't real until you use it.

---

## Cost summary (rough, USD)

| Line item | One-time | Monthly |
|---|---|---|
| Delaware LLC formation | $110–$600 | — |
| Registered agent | — | $4–$17/mo ($50–$200/yr) |
| Trademark (2 classes, TEAS Plus) | $500 | — |
| Domain (`.app`) | $20/yr | — |
| Google Workspace | — | $6/user |
| Cloudflare Workers + D1 + Vectorize | — | $5 Workers paid + pay-as-you-go |
| Vercel Pro (for the site) | — | $20 |
| Stripe | — | 2.9% + $0.30 per txn |
| Sentry | — | free tier, then $26 |
| PostHog | — | free tier, then $0.0001/event |
| Better Stack uptime | — | $30 |
| **Total to get to a live, paying-customer-ready SaaS** | **~$1,000** | **~$80–$150/mo** |

This is the baseline. The big cost is your time, not the line items.

---

## The one-page checklist

Print this, tape it to the wall, check items as you go.

- [ ] Name locked (USPTO searched, domain + handles checked)
- [ ] LLC formed
- [ ] EIN issued
- [ ] Business bank account open
- [ ] Trademark filed (class 9, class 42)
- [ ] Domain bought + on Cloudflare DNS
- [ ] Google Workspace email live with SPF/DKIM/DMARC
- [ ] GitHub organization + npm scope created
- [ ] Monorepo scaffolded (Turborepo, pnpm, CI)
- [ ] First deployment live behind custom domain
- [ ] Product usable end-to-end by you, every day
- [ ] Stripe account activated with LLC + bank
- [ ] Pricing tiers implemented and enforced
- [ ] API key auth working with per-tenant isolation
- [ ] Landing page + `/docs` + `/pricing` + `/privacy` + `/terms`
- [ ] JSON-LD schemas live on every public page
- [ ] `/llms.txt` at the root
- [ ] `/whitepaper` explaining the category first-principles
- [ ] SDK published to npm from CI
- [ ] CLI published to npm from CI
- [ ] Integration guides for every target client
- [ ] Sentry + PostHog + uptime monitoring wired
- [ ] Support email ready and checked
- [ ] Show HN post drafted, Tuesday scheduled
- [ ] Awesome-list PR drafted
- [ ] Technical blog post drafted and cross-posted
