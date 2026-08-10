# AgentSystem -- Installation Guide

Complete step-by-step setup for every supported CLI and platform.
Claude Code and Antigravity (`agy`) share the same agents and memory -- install once, use
everywhere. There is no `gemini` CLI or GitHub Copilot integration in this system.

---

## Prerequisites (all platforms)

| Tool | Install | Verify |
|------|---------|--------|
| Node.js >= 20 | https://nodejs.org | `node --version` |
| Git | https://git-scm.com | `git --version` |
| GitHub CLI | https://cli.github.com | `gh --version` |

Authenticate GitHub CLI:
```bash
gh auth login
```

---

## Step 1 -- Clone the repo

```bash
git clone https://github.com/Zene8/AgentSystem.git
cd AgentSystem
npm install
```

---

## Step 2 -- First-time machine setup

Run once per machine. Idempotent -- safe to re-run.

**Windows (PowerShell):**
```powershell
.\install.ps1

# Also set up self-hosted runner (requires admin):
.\install.ps1 -Runner
```

**Linux / macOS:**
```bash
chmod +x install.sh
./install.sh

# Skip label creation if not in a repo:
./install.sh --skip-labels

# Fresh server, everything (prerequisites + Mission Control + phone access + CI runner):
./install.sh --with-mission-control --with-tailscale --with-runner
```

What both scripts do:
- Check prerequisites (node, git, gh, CLIs)
- Initialize personal brain at `~/agent-memory/nexus/personal-brain/user-brain.md`
- Sync all 12 agents to `~/.claude/agents/` and `~/.gemini/agentsystem-plugin/agents/`
  (the Antigravity plugin directory, via `tools/sync-agents.js`)
- Create GitHub labels (`agent:friday`, `priority:high`, etc.)

`install.sh` additionally (Linux/macOS only — `install.ps1` does not do these yet):
- Bootstraps missing prerequisites on a bare box instead of aborting: apt packages,
  Node 22, `gh`, and the `claude` / `agy` CLIs, via
  `tools/mission-control/install-local.sh`
- Builds the repo graph brain (`nexus/agentsystem/`, gitignored)
- Registers the `agentsystem` MCP server with Claude Code (Step 3's manual
  `claude mcp add` is then unnecessary)
- Forwards any unrecognised flag to the Mission Control installer

---

## Step 3 -- CLI-specific setup

### Claude Code

**Install:**
```bash
curl -fsSL https://claude.ai/install.sh | bash    # installs to ~/.local/bin/claude
```

**Use agents:**
```bash
claude @friday                  # engineering (CTO)
claude @jarvis                  # strategy / CEO
claude @nat                     # business / CBO
claude @sam                     # security audit
claude @ultron                  # backend API
claude @pym                     # database
claude @leo                     # DevOps / CI-CD
claude @astra                   # frontend
claude @wanda                   # design
claude @threepio                # docs / comms
claude @r2d2                    # general technical worker
claude @clarification-needed    # asks clarifying questions on vague requests
```
(`claude --agent <name>` is equivalent to `claude @<name>`.)

**MCP server (currently non-functional -- do not install for production use):**
`./install.sh` attempts `claude mcp add agentsystem -- node <repo>/tools/mcp-server.js`
automatically. `tools/mcp-server.js` requires the `@modelcontextprotocol/sdk` npm package, which is
not installed (the `tools/**` path in this repo is npm-deps-free by rule) -- running it fails
immediately with `ERR_MODULE_NOT_FOUND`. Registering it with `claude mcp add` does not fix that; the
tools it would expose (`agent_send_message`, `agent_list_inbox`, `agent_archive_inbox`,
`graph_query`, `memory_read_brain`, `memory_read_agent`, `memory_remember`, `memory_context`,
`memory_reflect`) are unavailable until this is fixed. Use the equivalent CLI tools directly instead:
`node tools/agent-message.js`, `node tools/graph/graph-query.js`.

**Verify:**
```bash
claude @friday
# Friday should greet you with inbox check and pending items
```

---

### Antigravity (`agy`)

Antigravity is the second supported harness -- there is no `gemini` CLI in this system. See
`docs/harness-support.md` for the full list of what does and does not work under it (notably: no
hooks, so no session auto-rename and no continuous brain sync at session start/end).

**Install:** follow Antigravity's own setup instructions to get the `agy` CLI on PATH.

Agents are synced automatically by `install.sh` / `install.ps1` (via `tools/sync-agents.js`) to a
plugin manifest at `~/.gemini/agentsystem-plugin/agents/`, then registered with
`agy plugin install ~/.gemini/agentsystem-plugin` if `agy` is found on PATH.

**Use agents:**
```bash
agy @friday     # engineering
agy @jarvis     # strategy
agy @nat        # business
```

- Same agent roster and routing rules as Claude Code
- Memory is shared via `~/agent-memory/nexus/`
- Model ids come from the `MODELS.gemini` map in `tools/sync-agents.js` (`gemini-*` ids -- Antigravity
  is a Gemini-family runtime)

**Verify:**
```bash
ls ~/.gemini/agentsystem-plugin/agents/*.md | wc -l   # expect 12
```

---

## Step 4 -- Bootstrap a repo

Run once per repo to register it with the graph memory system and inject agent context.

```bash
cd /path/to/your-repo
node /path/to/AgentSystem/tools/bootstrap-repo.js
```

What it does:
- Runs `graph-init` to build Bayesian graph of the repo
- Injects an agent-system context block into `CLAUDE.md`
- Registers the repo in `~/agent-memory/nexus/known-repos.json`

---

## Step 5 -- Self-hosted runner (enables autonomous GitHub issue workflow)

Without this, CI workflows queue but never run.

**Windows (run PowerShell as Administrator):**
```powershell
.\install.ps1 -Runner
```

**Linux:**
```bash
# GitHub > repo Settings > Actions > Runners > New self-hosted runner > Linux
# Follow the on-screen commands (curl | tar | ./config.sh | ./run.sh)
```

**macOS:**
```bash
# GitHub > repo Settings > Actions > Runners > New self-hosted runner > macOS
# Follow the on-screen commands
```

**Verify runner is online:**
```bash
gh api repos/OWNER/REPO/actions/runners --jq ".runners[] | {name, status}"
# Should show "status": "online"
```

---

## Step 6 -- Personal brain (recommended)

Stores preferences and context that all agents read at startup.

```bash
node tools/personal-brain-init.js --name="Your Name" --email="you@example.com"
```

File: `~/agent-memory/nexus/personal-brain/user-brain.md`

Edit it to tell agents about your tech stack, preferred style, current projects, and anything agents should always/never do.

---

## Autonomous workflow (phone -> agent does work)

Once runner is online:

1. Open GitHub on your phone
2. Create a new issue
3. Add label: `agent:friday` (or any `agent:*` label)
4. Agent branches, codes, opens PR, runs Sam audit
5. Agent posts: "Ready to merge -- reply /merge to proceed"
6. Reply `/merge` -> agent merges and closes issue

Priority labels: `priority:high`, `priority:medium`, `priority:low`

---

## After editing agents

When you change any `.agents/agents/*.md` file:

```bash
node tools/sync-agents.js
```

---

## Verification checklist

```bash
# Agents present (expect 12 each)
ls ~/.claude/agents/*.md | wc -l
ls ~/.gemini/agentsystem-plugin/agents/*.md | wc -l

# Memory exists
ls ~/agent-memory/nexus/

# Personal brain
cat ~/agent-memory/nexus/personal-brain/user-brain.md

# Sync drift check (exit 1 on drift, writes nothing)
node tools/sync-agents.js --check

# Run tests
npm test
```

There is no GitHub Copilot integration in this system, and `node tools/mcp-server.js` is expected
to fail (`ERR_MODULE_NOT_FOUND`) -- see the MCP server note in Step 3.

---

## Troubleshooting

**Agent not found in CLI**
Re-run sync: `node tools/sync-agents.js`

**MCP tools not available in Claude Code**
Expected -- `tools/mcp-server.js` is currently non-functional (missing
`@modelcontextprotocol/sdk`; see the note in Step 3). Use `node tools/agent-message.js` and
`node tools/graph/graph-query.js` directly instead.

**CI workflows queue but never run**
Runner not set up. Follow Step 5 above.

**`/merge` comment not triggering merge**
Runner offline. Check: `gh run list` for queued runs.

**Graph query returns no results**
Graph not initialized. Run bootstrap (Step 4) from the repo root.

**Personal brain not found**
Run: `node tools/personal-brain-init.js --name="Your Name"`

**install.sh: permission denied**
Run: `chmod +x install.sh` then retry.

**Windows PowerShell encoding errors in scripts**
Ensure scripts are read as UTF-8. All .ps1 files in this repo are ASCII-safe.