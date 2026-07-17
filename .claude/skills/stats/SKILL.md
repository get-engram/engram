---
name: stats
description: Show Engram's business and infrastructure metrics — signups, referrals, revenue/MRR, storage-cap conversion watchlist, and how much D1 headroom is left. Use when the user asks for stats, metrics, usage, "how are we doing", or "how much do we have left".
---

Pull live production metrics and present them as one compact report. All credentials are in `/Users/op/code/engram/.env` (source it first; export `CLOUDFLARE_API_KEY`, `CLOUDFLARE_EMAIL`, `CLOUDFLARE_ACCOUNT_ID`, and run wrangler with `CLOUDFLARE_API_TOKEN=` cleared).

Run these in parallel where possible, then synthesize — don't dump raw JSON at the user.

## 1. Users & growth (worker admin API)

```bash
curl -s -H "Authorization: Bearer $ADMIN_SECRET" https://mcp.getengram.app/admin/metrics
```

Report: total signups, last 1d/7d/30d, active (30d) + activation rate, tier breakdown, referral sources (chatgpt / web / smithery / cursor / hostnames — flag any NEW source appearing, it means a distribution channel started working).

## 2. Revenue (Stripe live)

```bash
curl -s -u "$STRIPE_LIVE_SECRET_KEY:" "https://api.stripe.com/v1/subscriptions?status=all&limit=100"
```

Report: active subscriptions with tier/amount, MRR (sum of active sub amounts, note which are the founder's own accounts — debragailinc@gmail.com and deb@27c1ub.com are internal), any cancel_at set (churn scheduled), plus new customers vs last check.

## 3. Storage-cap conversion watchlist (the metric that predicts revenue)

```bash
cd apps/mcp-server && CLOUDFLARE_API_TOKEN= npx wrangler d1 execute engram-db --remote --json --command "
SELECT name, email, tier, messages_stored_total,
       ROUND(100.0 * messages_stored_total / 10000, 1) AS pct_of_free_cap
FROM organizations
WHERE deleted_at IS NULL AND tier='free' AND COALESCE(referral_source,'') != 'internal'
  AND messages_stored_total >= 5000
ORDER BY messages_stored_total DESC LIMIT 20;"
```

These are free orgs past 50% of the 10,000-message cap — the people about to hit the paywall. Report how many are >80% (imminent) and whether anyone hit 100% (check for recent `storage_full` behavior: orgs AT 10,000). Also report **pay-at-cap**: any org that upgraded after approaching the cap.

## 4. Infrastructure headroom — "how much do we have left"

```bash
cd apps/mcp-server && CLOUDFLARE_API_TOKEN= npx wrangler d1 info engram-db
```

The `database_size` here is the one that matters: **D1 has a hard 10 GB per-database ceiling and writes fail for everyone at the wall.** Report: current size, % of 10 GB used, growth since the last /stats run if known, and a rough days-to-ceiling at recent growth. If usage crosses **8.5 GB, flag it loudly** — the R2-offload/sharding work (see issue tracker; discussed 2026-07-17) becomes urgent.

Also worth one line each: total messages stored (`SELECT COUNT(*) FROM messages` — but prefer `SUM(messages_stored_total)` from organizations, it's cheaper), and api_keys count.

## Output format

A short report: **Users** (with growth trend), **Revenue** (external MRR vs founder accounts), **Conversion watchlist** (names approaching the cap — these are tomorrow's customers), **Headroom** (D1 % used + days-to-ceiling). Lead with whatever changed most since the numbers the user last saw. Keep it under a screen.
