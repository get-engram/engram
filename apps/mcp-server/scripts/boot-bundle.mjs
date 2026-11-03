// Boot the built Worker bundle in workerd and require GET /health to answer.
//
// `wrangler deploy --dry-run` (our `pnpm build`) bundles the worker but never
// evaluates it. An error thrown while the module graph loads - a dependency
// that esbuild wrapped lazily and initialised too late, a missing polyfill, a
// bad top-level call - passes typecheck, tests and the dry-run, and surfaces
// only when Cloudflare validates the upload (error 10021). That is how main
// became undeployable in #528. This script runs the exact bundle the deploy
// job would upload, in the same runtime (workerd via Miniflare), with the
// compatibility settings and bindings read from wrangler.toml through
// wrangler's own config reader, so a new binding needs no change here.
//
// AI, Vectorize and non-self service bindings have no local implementation and
// are left out (a stub answers 503). Module evaluation and /health touch no
// binding, so that does not weaken the check.
//
// Usage: pnpm smoke:bundle [path/to/bundle.js]   (default: dist/index.js)

import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const require = createRequire(import.meta.url);
const { unstable_readConfig } = require("wrangler");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = resolve(root, process.argv[2] ?? "dist/index.js");
if (!existsSync(bundle)) {
  console.error(`boot-bundle: ${relative(root, bundle)} not found; run \`pnpm build\` first`);
  process.exit(1);
}

const config = unstable_readConfig({ config: resolve(root, "wrangler.toml") }, { hideWarnings: true });
const sqliteClasses = new Set((config.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []));
const unavailable = () => new Response("binding has no local implementation in boot-bundle", { status: 503 });

const options = {
  name: config.name,
  rootPath: dirname(bundle),
  modulesRoot: dirname(bundle),
  modules: [{ type: "ESModule", path: basename(bundle) }],
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags ?? [],
  bindings: { ...(config.vars ?? {}) },
  durableObjects: Object.fromEntries(
    (config.durable_objects?.bindings ?? []).map((b) => [
      b.name,
      { className: b.class_name, useSQLite: sqliteClasses.has(b.class_name) },
    ]),
  ),
  d1Databases: Object.fromEntries((config.d1_databases ?? []).map((d) => [d.binding, d.database_name ?? d.binding])),
  r2Buckets: Object.fromEntries((config.r2_buckets ?? []).map((b) => [b.binding, b.bucket_name ?? b.binding])),
  kvNamespaces: Object.fromEntries((config.kv_namespaces ?? []).map((k) => [k.binding, k.id ?? k.binding])),
  serviceBindings: Object.fromEntries(
    (config.services ?? []).map((s) => [s.binding, s.service === config.name ? { name: config.name } : unavailable]),
  ),
};

const names = (o) => Object.keys(o).join(",") || "-";
console.log(
  `boot-bundle: ${relative(root, bundle)} (${(statSync(bundle).size / 1024).toFixed(0)} KiB)` +
    ` compat ${options.compatibilityDate} [${options.compatibilityFlags.join(", ")}]` +
    ` vars=${names(options.bindings)} do=${names(options.durableObjects)} d1=${names(options.d1Databases)}` +
    ` r2=${names(options.r2Buckets)} kv=${names(options.kvNamespaces)} services=${names(options.serviceBindings)}`,
);

const mf = new Miniflare(options);
let code = 0;
try {
  const res = await mf.dispatchFetch("http://localhost/health");
  const body = (await res.text()).slice(0, 200);
  if (res.status === 200) {
    console.log(`boot-bundle: OK, bundle evaluated in workerd; GET /health -> 200 ${body}`);
  } else {
    code = 1;
    console.error(`boot-bundle: FAILED, GET /health -> ${res.status} ${body}`);
  }
} catch (err) {
  code = 1;
  console.error(
    "boot-bundle: FAILED, the bundle did not boot in workerd. Cloudflare would reject this upload (error 10021).",
  );
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
} finally {
  await mf.dispose().catch(() => {});
}
process.exit(code);
