# ChatGPT App Directory — listing metadata

Draft copy + assets for submitting Engram to the ChatGPT App Directory via the
OpenAI Platform Dashboard. See the [submission guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines)
and epic get-engram/engram#184.

## Identity

- **Name:** `Engram`
- **MCP Server URL:** `https://mcp.getengram.app/mcp`
- **Authentication:** OAuth (Dynamic Client Registration; no client credentials to enter)
- **Developer / support contact:** `hello@getengram.app`
- **Website:** `https://getengram.app`
- **Privacy policy:** `https://getengram.app/privacy`
- **Terms:** `https://getengram.app/terms`

## Description

**Short (one line):**
> Lasting, portable memory for ChatGPT — remember context across chats, and bring your history with you.

**Long:**
> Engram gives ChatGPT durable, private memory that you own. Tell ChatGPT to
> remember something — a decision, a preference, a fact — and recall it days or
> weeks later, in this chat or a brand-new one. Already have months of ChatGPT
> history? Import it in one step and make all of it searchable by meaning.
>
> Your memory isn't locked to ChatGPT: the same Engram memory works across Claude,
> Cursor, and any MCP-compatible tool, so context follows you everywhere instead of
> being trapped in one app. Everything is stored verbatim, searchable by meaning,
> and private to your account.

**Getting started (put in the listing so first-run works):**
> - Say **"remember this"** or **"save that to Engram"** to store something.
> - Ask **"search Engram for …"** — or just ask about past context — to recall it.
> - Bring your history: export your ChatGPT data and run `engram import` (see getengram.app/docs).

**What it does (for the "functionality not native to ChatGPT" requirement):**
ChatGPT has no durable, user-owned, semantically-searchable memory store that
persists across conversations and is portable across clients. Engram provides
exactly that — verbatim storage + hybrid (semantic + keyword) retrieval that the
model calls as tools.

> **Honesty guardrail (keep the listing compliant):** Describe Engram as
> **save-on-request + import** — never "automatically records everything you say."
> ChatGPT gives connectors no per-turn hook, and OpenAI's guidelines prohibit
> pulling the full chat log; claiming silent full-capture would misrepresent the
> app and risk the listing. The framing above is both accurate and compelling.

## Categories / availability

- **Primary category:** Productivity (suggested)
- **Country availability:** start with the countries Engram already serves; widen after review.

## Assets

- **Icon:** `assets/engram-icon-256.png` (256×256, <10 KB — meets the Developer-mode form limit) and `assets/engram-icon-512.png` (512×512 for the directory). Source: `assets/engram-logo-mark.svg`.
- **Screenshots:** see #191 (connect/consent flow, storing a memory, recall via search).

## Tools exposed

Read-only: `search`, `get_conversation`, `list_conversations`.
Write: `create_conversation`, `append_messages`.
Destructive: `delete_conversation`.
(Annotations declared per get-engram/engram#185.)

> **Vault tools** (`vault_*`, `resolve_vault`) and `manage_subscription` — pending
> the get-engram/engram#188 decision on whether to exclude them from the published
> surface (OpenAI prohibits apps that collect credentials; vault stores
> client-encrypted secrets).

## Constraints to respect

- **Monetization:** ChatGPT apps may only sell **physical goods** via external
  checkout. Engram's Pro/Team upgrade must be a **link-out** to
  getengram.app/pricing, never an in-app purchase. The `manage_subscription`
  tool already returns a Stripe URL (link-out) — acceptable, but review whether
  to surface it in the published app at all.
- **Restricted data:** do not collect payment/health/government-id/credentials.
  See get-engram/engram#188.
- **Demo account:** reviewers need a working demo with sample data — get-engram/engram#193.
