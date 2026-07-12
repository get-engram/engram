# Engram Marketing Calendar — 27 Paying Users

**Goal:** 27 Pro subscribers ($9/mo) = $243/mo
**Math:** ~5% free-to-paid conversion = need ~540 signups. Higher-intent channels convert 10-15% = need ~200 signups.
**Timeline:** 6 weeks

---

## Week 1: Assets + Foundation (Jul 8-14)

**Designer deliverables (send these briefs):**
1. **30-second demo video** — split screen: left side "without Engram" (Claude says "I don't have access to previous conversations"), right side "with Engram" (Claude recalls full context). Terminal screen recording with light motion graphics.
2. **Comparison graphic** — "What Claude remembers vs what Engram remembers" side by side. Claude: bullet points like "user likes Python." Engram: full conversation excerpts with code.
3. **"How it works" diagram** — Agent -> Engram -> search/store -> vector DB. Clean, 3-step visual.
4. **Social cards** — branded 1200x630 for Twitter/Reddit/HN sharing. One for each platform.
5. **Setup GIF** — 15-second screen capture showing ChatGPT MCP connector setup (Settings > Apps > paste URL > done).

**You do:**
- [ ] Record the raw terminal footage for the demo video (follow the script above)
- [ ] Verify Stripe payments work end-to-end (prerequisite for everything)
- [ ] Claim Glama profile (log in at glama.ai, find Engram, claim it)

---

## Week 2: Show HN + Dev.to (Jul 15-21)

### Tuesday Jul 15 — Show HN
- Post `show-hn.md` (already drafted)
- Best time: 8-9am ET (US morning, EU afternoon)
- Be online for 3-4 hours to answer every comment
- Pin the demo video in comments

### Wednesday Jul 16 — Dev.to blog post
- Publish `devto-blog-post.md`
- Tags: #ai #mcp #cloudflare #opensource
- Include the comparison graphic and demo GIF

### Thursday Jul 17 — Cross-post
- Share HN post on Twitter with the demo video
- Share Dev.to post on LinkedIn

**Expected signups: 50-100**

---

## Week 3: Reddit Blitz (Jul 22-28)

One post per day, staggered. Don't spam — each subreddit gets a tailored post.

| Day | Subreddit | Post | Angle |
|-----|-----------|------|-------|
| Tue | r/ClaudeAI (180K) | `reddit-claude-ai.md` | "Cross-session memory for Claude Code" |
| Wed | r/ChatGPT (5M) | `social-posts.md` #2 | "Persistent memory via MCP, 30-second setup" |
| Thu | r/cursor (50K) | New — write for Cursor users | "Your Cursor agent forgets everything between sessions" |
| Sat | r/LocalLLaMA (500K) | `reddit-local-llama.md` | Self-host angle, BSL-1.1, technical architecture |

**Rules:**
- Post between 9-11am ET
- Reply to every comment within 2 hours
- Don't be salesy — share the problem, link the solution
- If a post gets traction, don't post the next one — let it ride

**Expected signups: 80-150**

---

## Week 4: Twitter/X + Short-form Video (Jul 29 - Aug 4)

### Twitter thread
- Post `social-posts.md` #4 (thread already drafted)
- Attach the demo video to tweet 1
- Tag @AnthropicAI @OpenAI @cursor_ai (they sometimes engage)

### Short-form content (designer makes these)
- **Video 1:** "Claude forgot everything I told it yesterday" — problem statement, 15 sec
- **Video 2:** "I fixed it" — show Engram search returning real context, 15 sec
- **Video 3:** "Setup in 30 seconds" — ChatGPT connector flow, 15 sec

Post to: Twitter, Instagram Reels, TikTok (if you want)

### Engagement farming
- Reply to tweets complaining about Claude/ChatGPT losing context (there are dozens daily)
- Don't pitch — just say "I built something for this" + link
- Search Twitter for: "claude forgot" "chatgpt memory" "lost context" "re-explain"

**Expected signups: 30-60**

---

## Week 5: Product Hunt + Directories (Aug 5-11)

### Tuesday Aug 5 — Product Hunt launch
- Use `product-hunt.md` (already drafted)
- Schedule for 12:01am PT (Product Hunt's day starts then)
- Need: 1-min demo video, 5 screenshots, tagline
- Rally anyone you know to upvote + leave a genuine comment in the first 2 hours
- Be online ALL DAY to reply to comments

### Directories (same week)
- [ ] Smithery — create account, publish via CLI
- [ ] Glama — claim profile (should be done by now)
- [ ] cursor.directory — submit plugin listing
- [ ] Submit to theresanaiforthat.com, alternativeto.net

**Expected signups: 50-100**

---

## Week 6: Convert Free to Paid (Aug 12-18)

By now you should have 200-400 free signups. Time to convert.

### Email sequence (send from hello@getengram.app)
- **Day 1 after signup:** Welcome + quick start guide
- **Day 3:** "Here's what Engram remembered for you this week" (show their actual search count)
- **Day 7:** "You've used X of 1,000 free messages" — soft nudge toward Pro
- **Day 14:** "Your conversations are building up — upgrade to keep full history searchable"

### In-product nudges
- Show usage meter in MCP tool responses (you already built this — issue #208)
- When they hit 800/1,000 messages, show upgrade prompt

### Direct outreach
- Anyone who stores 10+ conversations on free tier = warm lead
- Use the admin MCP tools to identify active free users
- Send personal email: "Hey, I saw you're using Engram for [X]. Want to chat about the Pro tier?"

---

## Content Calendar Summary

| Week | Channel | Content | Owner |
|------|---------|---------|-------|
| 1 | N/A | Assets: demo video, graphics, social cards | Designer |
| 2 | Hacker News, Dev.to | Show HN post, technical blog | You |
| 3 | Reddit (4 subs) | Tailored posts per community | You |
| 4 | Twitter/X, Instagram | Thread + short-form video | You + Designer |
| 5 | Product Hunt, directories | Full PH launch, directory claims | You |
| 6 | Email, in-product | Conversion sequence | You |

---

## Ongoing (every week)

- **Twitter engagement:** 15 min/day replying to people complaining about AI memory loss. Search: "claude forgot", "chatgpt memory sucks", "lost my context", "start over every session"
- **Reddit monitoring:** Answer questions in r/ClaudeAI and r/ChatGPT about memory/context. Be helpful first, mention Engram only when relevant.
- **GitHub:** Star and engage with MCP-related repos. People notice.
- **Content recycling:** Every Reddit post that does well becomes a Twitter thread. Every Twitter thread becomes a Dev.to post.

---

## Paid Ads (optional, only after organic works)

Skip paid ads until you have 15+ paying users from organic. Then:
- **Reddit ads** targeting r/ClaudeAI, r/ChatGPT, r/cursor — $5-10/day
- **Twitter/X promoted posts** — boost the demo video tweet — $10/day
- Don't do Google Ads yet (too expensive, low intent for this category)

---

## Tracking

Check weekly with admin MCP tools:
- Total orgs (signups)
- Active orgs (stored 1+ conversations in last 7 days)
- Paid orgs (Pro subscribers)
- Top free users by message count (conversion targets)

**Milestone targets:**
- End of week 2: 50 signups, 2 paid
- End of week 4: 200 signups, 10 paid
- End of week 6: 400 signups, 27 paid
