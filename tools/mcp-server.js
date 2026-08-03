#!/usr/bin/env node
/**
 * AgentSystem MCP Server
 *
 * Exposes agent memory, messaging, and graph tools as MCP tools so any
 * Claude Code session can call them without knowing the underlying scripts.
 *
 * Install in Claude Code:
 *   claude mcp add agentsystem -- node /path/to/AgentSystem/tools/mcp-server.js
 *
 * Or add to ~/.claude/settings.json mcpServers block:
 *   "agentsystem": {
 *     "command": "node",
 *     "args": ["/path/to/AgentSystem/tools/mcp-server.js"]
 *   }
 *
 * Tools exposed:
 *   agent_send_message   — send a structured message to an agent inbox
 *   agent_list_inbox     — read an agent's inbox
 *   agent_archive_inbox  — archive an agent's inbox
 *   graph_query          — query the Bayesian graph memory
 *   memory_read_brain    — read the user personal brain
 *   memory_read_agent    — read a specific agent's memory file
 */

import { Server }            from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execFile }  from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { isMainModule } from './is-main.js';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = __dirname;
const REPO_ROOT = join(__dirname, '..');

function memRoot() {
  return process.env.AGENT_MEMORY_ROOT || join(homedir(), 'agent-memory');
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'agent_send_message',
    description: 'Send a structured message to an agent inbox (inter-agent messaging).',
    inputSchema: {
      type: 'object',
      required: ['from', 'to', 'subject', 'action'],
      properties: {
        from:     { type: 'string', description: 'Sender agent name (e.g. Friday)' },
        to:       { type: 'string', description: 'Recipient agent name (e.g. Sam)' },
        subject:  { type: 'string', description: 'Short subject line' },
        action:   { type: 'string', description: 'What the recipient must do' },
        context:  { type: 'string', description: 'Background context' },
        links:    { type: 'string', description: 'Relevant URLs (PR, issue, file)' },
        priority: { type: 'string', enum: ['high', 'normal', 'low'], default: 'normal' },
      },
    },
  },
  {
    name: 'agent_list_inbox',
    description: "Read an agent's inbox messages.",
    inputSchema: {
      type: 'object',
      required: ['to'],
      properties: {
        to: { type: 'string', description: 'Agent name whose inbox to read' },
      },
    },
  },
  {
    name: 'agent_archive_inbox',
    description: "Archive an agent's inbox (moves current messages to archive folder).",
    inputSchema: {
      type: 'object',
      required: ['to'],
      properties: {
        to: { type: 'string', description: 'Agent name whose inbox to archive' },
      },
    },
  },
  {
    name: 'graph_query',
    description: 'Query the Bayesian graph memory for relevant nodes. Use before any complex task.',
    inputSchema: {
      type: 'object',
      required: ['slug', 'keywords'],
      properties: {
        slug:     { type: 'string', description: 'Repo slug (e.g. agentsystem)' },
        keywords: { type: 'string', description: 'Space-separated keywords to search' },
        top:      { type: 'number', description: 'Max results to return (default 10)', default: 10 },
        mode: {
          type: 'string',
          enum: ['default', 'debugging', 'architecture', 'routine', 'incident'],
          default: 'default',
        },
        spread: { type: 'boolean', description: 'Enable multi-hop spreading activation', default: false },
      },
    },
  },
  {
    name: 'memory_read_brain',
    description: "Read the user's personal brain (preferences, goals, context across all projects).",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_read_agent',
    description: "Read a specific agent's memory file.",
    inputSchema: {
      type: 'object',
      required: ['agent'],
      properties: {
        agent: { type: 'string', description: 'Agent name (e.g. Friday, Ultron)' },
      },
    },
  },
  {
    name: 'memory_remember',
    description: 'Write a durable fact about the user into the personal brain (dedup + re-split).',
    inputSchema: {
      type: 'object',
      required: ['fact'],
      properties: {
        fact:    { type: 'string', description: 'The fact to store (plain text, no bullet prefix)' },
        section: { type: 'string', description: 'Brain section to write under (default: Session Notes)' },
      },
    },
  },
  {
    name: 'memory_context',
    description: 'Return three-layer memory context: top user facts, active project nodes, recent SONA patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        core: { type: 'number', description: 'Number of top user facts to surface (default 7)', default: 7 },
      },
    },
  },
  {
    name: 'memory_reflect',
    description: 'Run a generative reflection pass: reads top facts, asks LLM for higher-level insights, writes them back.',
    inputSchema: {
      type: 'object',
      properties: {
        top:     { type: 'number', description: 'Number of top facts to reflect on (default 10)', default: 10 },
        dry_run: { type: 'boolean', description: 'Return prompt only, do not call LLM', default: false },
      },
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(text) {
  return { content: [{ type: 'text', text: String(text) }] };
}

function err(text) {
  return { content: [{ type: 'text', text: `ERROR: ${text}` }], isError: true };
}

async function runScript(args) {
  const scriptPath = join(TOOLS_DIR, 'agent-message.js');
  const { stdout, stderr } = await exec('node', [scriptPath, ...args], {
    cwd: REPO_ROOT,
    env: process.env,
  });
  return (stdout + (stderr ? `\n${stderr}` : '')).trim();
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function handleTool(name, input) {
  switch (name) {

    case 'agent_send_message': {
      const args = [
        `--from=${input.from}`,
        `--to=${input.to}`,
        `--subject=${input.subject}`,
        `--action=${input.action}`,
        `--priority=${input.priority || 'normal'}`,
      ];
      if (input.context) args.push(`--context=${input.context}`);
      if (input.links)   args.push(`--links=${input.links}`);
      try {
        const out = await runScript(args);
        return ok(out);
      } catch (e) {
        return err(e.message);
      }
    }

    case 'agent_list_inbox': {
      try {
        const out = await runScript([`--list`, `--to=${input.to}`]);
        return ok(out);
      } catch (e) {
        return err(e.message);
      }
    }

    case 'agent_archive_inbox': {
      try {
        const out = await runScript([`--archive`, `--to=${input.to}`]);
        return ok(out);
      } catch (e) {
        return err(e.message);
      }
    }

    case 'graph_query': {
      const scriptPath = join(TOOLS_DIR, 'graph', 'graph-query.js');
      const args = [scriptPath, input.slug, ...input.keywords.split(/\s+/),
        `--top=${input.top || 10}`,
        `--mode=${input.mode || 'default'}`,
        '--json',
      ];
      if (input.spread) args.push('--spread');
      try {
        const { stdout } = await exec('node', args, { cwd: REPO_ROOT, env: process.env });
        return ok(stdout.trim());
      } catch (e) {
        return err(e.message);
      }
    }

    case 'memory_read_brain': {
      const p = join(memRoot(), 'nexus', 'personal-brain', 'user-brain.md');
      if (!existsSync(p)) return err(`user-brain.md not found at ${p}. Run: node tools/personal-brain-init.js`);
      return ok(readFileSync(p, 'utf8'));
    }

    case 'memory_read_agent': {
      const agent = input.agent;
      // Try agent-brain dir first, fall back to agents-memory
      const candidates = [
        join(memRoot(), 'nexus', 'agent-brain', `${agent.toLowerCase()}.md`),
        join(memRoot(), 'nexus', 'agent-brain', `${agent}.md`),
        join(REPO_ROOT, '.agents', 'memory', `${agent.toLowerCase()}.md`),
      ];
      for (const p of candidates) {
        if (existsSync(p)) return ok(readFileSync(p, 'utf8'));
      }
      return err(`No memory file found for agent: ${agent}`);
    }

    case 'memory_remember': {
      const scriptPath = join(TOOLS_DIR, 'brain-remember.js');
      const args = [`--fact=${input.fact}`];
      if (input.section) args.push(`--section=${input.section}`);
      try {
        const { stdout, stderr } = await exec('node', [scriptPath, ...args], { cwd: REPO_ROOT, env: process.env });
        return ok((stdout + (stderr ? `\n${stderr}` : '')).trim());
      } catch (e) {
        return err(e.message);
      }
    }

    case 'memory_context': {
      const scriptPath = join(TOOLS_DIR, 'memory-context.js');
      const args = [];
      if (input.core != null) args.push(`--core=${input.core}`);
      try {
        const { stdout, stderr } = await exec('node', [scriptPath, ...args], { cwd: REPO_ROOT, env: process.env });
        return ok((stdout + (stderr ? `\n${stderr}` : '')).trim());
      } catch (e) {
        return err(e.message);
      }
    }

    case 'memory_reflect': {
      const scriptPath = join(TOOLS_DIR, 'memory-reflect.js');
      const args = [];
      if (input.top != null) args.push(`--top=${input.top}`);
      if (input.dry_run) args.push('--dry-run');
      try {
        const { stdout, stderr } = await exec('node', [scriptPath, ...args], { cwd: REPO_ROOT, env: process.env });
        return ok((stdout + (stderr ? `\n${stderr}` : '')).trim());
      } catch (e) {
        return err(e.message);
      }
    }

    default:
      return err(`Unknown tool: ${name}`);
  }
}

// ── Server setup ──────────────────────────────────────────────────────────────

export { TOOLS };

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const server = new Server(
    { name: 'agentsystem', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: input } = req.params;
    return handleTool(name, input || {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
