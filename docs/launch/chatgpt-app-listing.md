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
> Persistent, searchable memory for ChatGPT — remember context across conversations.

**Long:**
> Engram gives ChatGPT long-term memory. It stores conversations verbatim and
> makes them searchable by meaning, so context, decisions, and preferences carry
> across sessions instead of being forgotten. Ask ChatGPT to remember something
> and recall it days or weeks later. Your memory is private to your account, and
> the same memory works across any MCP client you connect.

**What it does (for the "functionality not native to ChatGPT" requirement):**
ChatGPT has no durable, user-owned, semantically-searchable memory store that
persists across conversations and is portable across clients. Engram provides
exactly that — verbatim storage + hybrid (semantic + keyword) retrieval that the
model calls as tools.

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
