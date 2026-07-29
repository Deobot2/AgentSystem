# AgentSystem -- Installation Guide

Complete step-by-step setup for every supported CLI and platform.
Claude Code and Gemini share the same agents and memory -- install once, use everywhere.

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
- Sync all 11 agents to `~/.claude/agents/` and `~/.gemini/agents/`
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
claude @friday     # engineering (CTO)
claude @jarvis     # strategy / CEO
claude @nat        # business / CBO
claude @sam        # security audit
claude @ultron     # backend API
claude @pym        # database
claude @leo        # DevOps / CI-CD
claude @astra      # frontend
claude @wanda      # design
claude @threepio   # docs / comms
claude @r2d2       # fallback / exploratory
```

**Install MCP server** (exposes agent tools natively -- recommended). `./install.sh`
already does this; run it by hand only on Windows or if that step warned:
```bash
# Replace /path/to with your actual path
claude mcp add agentsystem -- node /path/to/AgentSystem/tools/mcp-server.js
```

After MCP install, these tools are available in every Claude Code session:
- `agent_send_message` -- message any agent inbox
- `agent_list_inbox` -- read inbox
- `agent_archive_inbox` -- archive inbox
- `graph_query` -- query Bayesian graph memory
- `memory_read_brain` -- read your personal brain
- `memory_read_agent` -- read any agent's memory

**Verify:**
```bash
claude @friday
# Friday should greet you with inbox check and pending items
```

---

### Gemini CLI

**Install:**
```bash
# Follow: https://github.com/google-gemini/gemini-cli
npm install -g @google/generative-ai-cli
```

**Authenticate:**
```bash
gemini auth login
```

Agents are synced to `~/.gemini/agents/` automatically by `install.sh` / `install.ps1`.

**Use agents:**
```bash
gemini @friday     # engineering
gemini @jarvis     # strategy
gemini @nat        # business
```

- Same agent roster and routing rules as Claude Code
- Memory is shared via `~/agent-memory/nexus/`
- Gemini executes agents **sequentially** (no parallel swarm spawning)
- Model assigned: gemini-3-flash-preview (standard), gemini-3.1-pro-preview (Jarvis/Sam)

**Verify:**
```bash
gemini @friday
# Should load Friday agent with model: gemini-3-flash-preview
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
# Agents present (expect 11 each)
ls ~/.claude/agents/*.md | wc -l
ls ~/.copilot/agents/*.md | wc -l
ls ~/.gemini/agents/*.md | wc -l

# Memory exists
ls ~/agent-memory/nexus/

# Personal brain
cat ~/agent-memory/nexus/personal-brain/user-brain.md

# Config synced
ls ~/.claude/agents/config/

# MCP server (should start silently -- Ctrl+C to exit)
node tools/mcp-server.js

# Run tests
npm test
```

---

## Troubleshooting

**Agent not found in CLI**
Re-run sync: `node tools/sync-agents.js`

**MCP tools not available in Claude Code**
Check: `claude mcp list` -- agentsystem should appear.
Re-add: `claude mcp add agentsystem -- node /path/to/AgentSystem/tools/mcp-server.js`

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