// Refuse to publish @getengram/cli with anything but pnpm.
//
// package.json declares "@getengram/sdk": "workspace:*". Only `pnpm publish`
// rewrites that to the real SDK version when it packs the tarball; `npm publish`
// ships the literal "workspace:*", and every `npm install -g @getengram/cli`
// then fails with EUNSUPPORTEDPROTOCOL. That shipped twice (0.3.0 in #120,
// 0.6.0 in #538), so prepublishOnly runs this check first.
//
// Package managers put themselves first in npm_config_user_agent for every
// lifecycle script they run ("pnpm/9.15.0 npm/? node/v22 ..." vs "npm/10 ...").
const agent = process.env.npm_config_user_agent ?? "";

if (!agent.startsWith("pnpm/")) {
  console.error(
    [
      `@getengram/cli must be published with "pnpm publish", not with npm.`,
      `Publisher detected: ${agent || "unknown"}.`,
      `npm leaves "@getengram/sdk": "workspace:*" in the published manifest, which`,
      `breaks installs (see issues #120 and #538). Run: pnpm publish --access public`,
    ].join("\n"),
  );
  process.exit(1);
}
