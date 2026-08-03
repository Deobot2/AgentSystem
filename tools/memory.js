#!/usr/bin/env node
// memory.js — unified CLI for the agent memory system.
// Usage: node tools/memory.js <subcommand> [options]
// Subcommands: recall, context, remember, reflect, maintain, help

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { isMainModule } from './is-main.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function agentMemoryRoot() {
  return process.env.AGENT_MEMORY_ROOT || join(homedir(), 'agent-memory');
}

const USAGE = `
memory — unified agent memory CLI

Usage:
  memory recall <keywords...>          Query graph brain for relevant nodes
  memory context [--core=N]            Three-layer scoped read (user + project + episodic)
  memory remember --fact="..."         Write a durable fact to user brain
               [--section="..."]
  memory reflect [--top=N] [--dry-run] Generative reflection pass (LLM)
  memory maintain [--if-stale=N]       Run full memory maintenance pass
                  [--reflect] [--quiet]
  memory help                          Show this usage
`.trim();

// Pure: map argv to {tool, args} or {help: true}.
// toolsDir and nexus are injected so this stays environment-free for tests.
export function resolveSubcommand(argv, { toolsDir, nexus } = {}) {
  const [sub, ...rest] = argv;

  switch (sub) {
    case 'recall': {
      const keywords = rest.filter(a => !a.startsWith('--'));
      const extraFlags = rest.filter(a => a.startsWith('--'));
      return {
        tool: join(toolsDir, 'graph', 'graph-query.js'),
        args: [
          'personal-brain',
          ...keywords,
          `--brain-path=${join(nexus, 'personal-brain')}`,
          '--record-access',
          ...extraFlags,
        ],
      };
    }

    case 'context':
      return {
        tool: join(toolsDir, 'memory-context.js'),
        args: rest,
      };

    case 'remember':
      return {
        tool: join(toolsDir, 'brain-remember.js'),
        args: rest,
      };

    case 'reflect':
      return {
        tool: join(toolsDir, 'memory-reflect.js'),
        args: rest,
      };

    case 'maintain':
      return {
        tool: join(toolsDir, 'memory-maintenance.js'),
        args: rest,
      };

    case 'help':
    case undefined:
    default:
      return { help: true };
  }
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const nexus = join(agentMemoryRoot(), 'nexus');
  const resolved = resolveSubcommand(process.argv.slice(2), { toolsDir: __dirname, nexus });

  if (resolved.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const child = spawn('node', [resolved.tool, ...resolved.args], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', code => process.exit(code ?? 0));
}
