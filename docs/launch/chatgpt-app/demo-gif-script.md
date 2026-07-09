# Demo GIF / Video — Shot List & Script

The single highest-leverage launch asset. It carries Product Hunt, Show HN, the X thread, and the landing page. Goal: in ~25 seconds, show the one thing words can't — **memory saved in ChatGPT, recalled in a different app**, then the **import** kicker.

## Specs

- **Length:** 20–30s. Silent, looping GIF/MP4 (people scroll with sound off). Add captions/text overlays for each beat.
- **Format:** MP4 for X/PH (better quality), GIF fallback. ~1280×720 or the app's native aspect. Keep under ~10 MB so it autoplays.
- **Pace:** fast. Cut dead air — trim thinking/loading time, jump straight to results. No slow typing; pre-type or speed-ramp.
- **Look:** clean desktop, light mode, hide personal data / other tabs / notifications. One browser window, no clutter.
- **Capture:** screen recorder at 60fps, then export to GIF at ~15–20fps. Add a subtle cursor highlight.

## The narrative (3 beats)

**Beat 1 — Save in ChatGPT (0:00–0:08)**
The setup. Show memory going *in*, on request.

- On screen: a ChatGPT chat with Engram connected (tools visible).
- Type: `Remember: for the team offsite we picked Lisbon over Barcelona, and we're capping it at 12 people.`
- ChatGPT calls Engram and confirms it saved. Text overlay: **"Save anything to memory."**

**Beat 2 — Recall in a DIFFERENT app (0:08–0:18) ← the money shot**
Prove it's not locked to ChatGPT. This is the whole pitch.

- Hard cut to **Claude** (or Cursor). New session, different tool. Text overlay: **"Open a different app…"**
- Type: `Where did we land for the team offsite, and how many people?`
- It calls Engram `search` and answers: *"Lisbon (over Barcelona), capped at 12 people."*
- Text overlay: **"…it remembers. One memory, every AI."**

**Beat 3 — Import your history (0:18–0:25) — the kicker**
The "wow, I want that."

- Quick cut to a terminal. Text overlay: **"Bring your whole ChatGPT history."**
- Show: `engram import ~/Downloads/chatgpt-export/conversations.json`
- Output scrolls: `Imported 1,284 conversations ✓`
- End card: **Engram — one memory, everywhere.** + `getengram.app`

## Captions/overlay copy (exact)

1. "Save anything to memory." (ChatGPT)
2. "Open a different app…" (cut to Cursor)
3. "…it remembers. One memory, every AI."
4. "Bring your whole ChatGPT history." (terminal)
5. End card: "Engram — one memory, everywhere. · getengram.app"

## Honesty guardrail (don't fake it)

- Beat 1 must be an **explicit** "remember this," never implied always-on capture. The demo shows save-on-request + cross-app recall + import — all true. Do **not** stage ChatGPT "auto-saving" a message you didn't ask it to save.
- Use a real recall result, not a scripted fake — semantic search actually returns it, so show the real thing.

## Variants to cut from the same recording

- **6s teaser** (X reply / preview): Beat 2 only — the cross-app recall. The single most surprising moment.
- **Vertical 9:16** (Reddit/Shorts/TikTok): same beats, stacked.
- **Still frames** for the App Directory screenshots (#191): (a) Engram connected in ChatGPT, (b) a save confirmation, (c) a recall result.

## Pre-flight checklist

- [ ] Engram connected in both ChatGPT and Cursor, signed into the **same** account (shared memory won't work otherwise).
- [ ] A clean demo memory that recalls cleanly (rehearse the exact query).
- [ ] A real (or realistic sample) `conversations.json` for the import shot.
- [ ] Hide: API keys, emails, other conversations, browser bookmarks, OS notifications (enable Do Not Disturb).
- [ ] Record 2–3 takes; keep the tightest. Verify it loops without a jarring jump.
