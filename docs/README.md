# docs/

**The website is the source of truth for user-facing documentation.**
Every page under https://getengram.app/docs is rendered from
`engram-web/content/*.mdx`, not from this directory. Nothing in the build,
CI, or wrangler config reads these files, and every documentation link in the
root README points at the website.

This directory used to be a full mirror of that content. It drifted for
months — by the time it was cleaned up in October 2026 the copy here still
advertised a 1,000-message free tier, Pro at 100,000 messages, and Team at
$27 per seat, none of which had been true for a long time, in a repository
that is public. The 17 files that were pure duplicates have been deleted;
`git log` has them if one is ever needed.

What remains is here for a reason:

- **No counterpart on the website at all** — `contributing.md`,
  `self-hosting.md`, `stripe-profile.md`, `vault.md`,
  `guides/import-chatgpt.md`.
- **Documents sections the website never got.** Most of these cover the
  Vault (`api-reference.md`, `cli.md`, `sdk.md`, `security.md`, `faq.md`),
  self-hosting (`troubleshooting.md`, `integrations.md`,
  `getting-started.md`), or Cloudflare platform limits (`limits.md`). The
  rest are `index.md`, `roadmap.md`, and the `guides/` pages whose setup
  steps are more detailed here.

So treat a file here as either developer-facing documentation or a draft
awaiting a home on the website — never as a second copy of a page that
already exists there. If you publish one of these to `engram-web/content`,
delete it here in the same change.
