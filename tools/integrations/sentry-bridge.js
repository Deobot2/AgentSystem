'use strict';

const fs = require('fs');
const { execSync } = require('child_process');
// This file is CommonJS (require/module.exports) despite the repo-wide "type": "module" in
// package.json — Node throws before this line is even reached when run, so the CJS-native
// `require.main === module` guard below (not tools/is-main.js, which is import.meta.url-based
// ESM only) is what actually applies once that separate, pre-existing bug is fixed. Guard added
// for structural consistency with #374; not a claim this file currently runs.

const SECURITY_KEYWORDS = [
  'auth', 'token', 'secret', 'permission', 'csrf',
  'xss', 'injection', 'sql', 'credential',
];

function isSecurityRelated(title, culprit) {
  const text = `${title} ${culprit}`.toLowerCase();
  return SECURITY_KEYWORDS.some(kw => text.includes(kw));
}

function parsePayload(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse payload JSON: ${err.message}`);
  }

  // Support both direct event and wrapped { event: ... }
  const event = data.event || data;

  // Extract title
  let title = event.title || '';
  if (!title && event.exception?.values?.[0]) {
    const ex = event.exception.values[0];
    title = `${ex.type || 'Error'}: ${ex.value || ''}`.trim();
  }
  if (!title) title = 'Unknown Error';

  const culprit = event.culprit || event.transaction || 'unknown';
  const level = event.level || 'error';
  const url = event.url || '';

  // Stack frames (last 5)
  let frames = [];
  try {
    const rawFrames = event.exception?.values?.[0]?.stacktrace?.frames || [];
    frames = rawFrames.slice(-5).map(f => {
      const file = f.filename || f.abs_path || 'unknown';
      const line = f.lineno || '?';
      const fn = f.function || '<anonymous>';
      return `  ${file}:${line} in ${fn}`;
    });
  } catch (_) {
    // Missing stack trace — continue
  }

  return { title, culprit, level, url, frames };
}

function buildIssueBody(parsed) {
  const { title, culprit, level, url, frames } = parsed;

  const stackBlock = frames.length > 0
    ? frames.join('\n')
    : '  (no stack trace available)';

  return `## Sentry Error

**Level:** ${level}
**Culprit:** ${culprit}

## Stack Trace (last 5 frames)
\`\`\`
${stackBlock}
\`\`\`

## Sentry Link
${url || '(no link provided)'}

_Auto-created by sentry-bridge.js_`;
}

async function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  // Check env vars
  const available = process.env.SENTRY_DSN || process.env.SENTRY_AUTH_TOKEN || false;
  if (!available) {
    console.log('[sentry] not configured — skipping');
    process.exit(0);
  }

  // Get payload
  let raw = '';
  const payloadArg = process.argv.find(a => a.startsWith('--payload='));

  if (payloadArg) {
    const filePath = payloadArg.split('=').slice(1).join('=');
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error(`[sentry] Failed to read payload file: ${err.message}`);
      process.exit(1);
    }
  } else {
    raw = await readStdin();
    if (!raw.trim()) {
      console.error('[sentry] No payload provided (use --payload=<file> or pipe JSON via stdin)');
      process.exit(1);
    }
  }

  let parsed;
  try {
    parsed = parsePayload(raw);
  } catch (err) {
    console.error('[sentry] Parse error:', err.message);
    process.exit(1);
  }

  const { title, culprit } = parsed;
  const securityRelated = isSecurityRelated(title, culprit);
  const agentLabel = securityRelated ? 'agent:sam' : 'agent:friday';

  const issueTitle = `[sentry] ${title}`;
  const issueBody = buildIssueBody(parsed);

  console.log(`[sentry] Creating GitHub issue: "${issueTitle}"`);
  console.log(`[sentry] Labels: bug, ${agentLabel}${securityRelated ? ' (security-related)' : ''}`);

  try {
    // Write body to temp file to avoid shell escaping issues
    const tmpFile = require('os').tmpdir() + '/sentry-issue-body.md';
    fs.writeFileSync(tmpFile, issueBody, 'utf8');

    const result = execSync(
      `gh issue create --title "${issueTitle.replace(/"/g, '\\"')}" --body-file "${tmpFile}" --label "bug" --label "${agentLabel}"`,
      { encoding: 'utf8' }
    );

    console.log('[sentry] Issue created:', result.trim());

    // Clean up temp file
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  } catch (err) {
    console.error('[sentry] Failed to create GitHub issue:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[sentry] Unexpected error:', err.message);
    process.exit(1);
  });
}
