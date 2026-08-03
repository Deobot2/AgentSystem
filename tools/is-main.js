// is-main.js — the one correct "am I being run directly?" check for tools/ and hooks/.
// Pure Node builtins only (tools/ rule).
//
// Usage:
//   import { isMainModule } from './is-main.js';
//   if (isMainModule(import.meta.url)) main();
//
// Why this file exists rather than an inline comparison in each tool:
//
// `import.meta.url` is ALWAYS symlink-resolved by Node's ESM loader. `process.argv[1]` is not —
// it is whatever path the caller typed. So the obvious check
//
//   pathToFileURL(process.argv[1]).href === import.meta.url        // WRONG
//   path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) // ALSO WRONG
//
// is false for every caller that reaches the file through a symlink. `~/dev/AgentSystem` is a
// symlink to the real checkout, and it is the path that config/routines.yml, the installed hooks,
// the slash commands, and the docs all tell callers to use. The result is not a crash: `main()`
// simply never runs and the process exits 0 having done nothing. A silent, exit-code-clean no-op
// is the worst possible failure mode for a scheduled job — the cron looks healthy forever.
//
// This bit session-namer.js once already (fixed + regression-tested in
// tools/session-namer-symlink.test.js), then stayed broken in 25 other tools because the fix was
// a local edit rather than a shared helper. tools/is-main.test.js now asserts no tool
// hand-rolls the comparison again.
//
// Both sides are realpath'd, so the check holds whether the caller used the symlink, the real
// path, or a relative path, and on Windows (where argv[1] arrives with backslashes).

import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

function resolvedHref(p) {
  try {
    return pathToFileURL(realpathSync(p)).href;
  } catch {
    // Path does not exist (or is unreadable): fall back to the unresolved form. Never throw from
    // an is-main check — a tool must not fail to start because of how it was invoked.
    return pathToFileURL(p).href;
  }
}

/**
 * True when `importMetaUrl`'s module is the entry point of this process.
 * @param {string} importMetaUrl - pass `import.meta.url` from the calling module.
 */
export function isMainModule(importMetaUrl) {
  if (!process.argv[1]) return false;
  let self;
  try {
    self = resolvedHref(fileURLToPath(importMetaUrl));
  } catch {
    self = importMetaUrl;
  }
  return resolvedHref(process.argv[1]) === self;
}
