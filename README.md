# AgentSystem

A multi-agent orchestration system that runs a fleet of 11 specialized AI agents across Claude Code and Antigravity — sharing memory, routing work intelligently, and executing full engineering workflows autonomously.

[![Tests](https://img.shields.io/badge/tests-45%20passing-brightgreen)](#)
[![License](https://img.shields.io/badge/license-Source%20Available-blue)](LICENSE)

---

## What it does

- **11 specialized agents** — CEO (Jarvis), CTO (Friday), CSO (Sam), Backend (Ultron), DB (Pym), DevOps (Leo), Frontend (Astra), Design (Wanda), Docs (Threepio), Business (Nat), Fallback (r2d2)
- **Two CLIs, one brain** — Claude Code and Antigravity both load the same agents and share the same graph memory
- **Autonomous issue workflow** — label a GitHub issue `agent:friday` from your phone → agents branch, code, PR, audit, and ping you to merge
- **Bayesian graph memory** — Ebbinghaus decay, spreading activation, context-adaptive weight profiles
- **Dynamic model selection** — Friday classifies task complexity (COMPLEX/STANDARD/SIMPLE) and spawns workers on the right model tier
- **Lazy MCP loading** — each agent only loads the MCPs it needs, declared in frontmatter

## Architecture

```
Jarvis (CEO / Opus)
  └── Friday (CTO / Sonnet) ── dispatches ──→ Ultron · Pym · Leo · Astra · Wanda · Threepio
                                              (parallel swarms in Claude Code)
  └── Nat (CBO / Sonnet)
  └── Sam (CSO / Sonnet) ── hard gate on all main merges
```

Memory: `~/agent-memory/nexus/` — neutral path, readable by all three CLIs.

---

## Quick start

**First time on a new machine:**
```powershell
git clone https://github.com/Zene8/AgentSystem.git
cd AgentSystem
.\install.ps1
```

**With self-hosted runner** (enables autonomous GitHub issue workflow — run as Administrator):
```powershell
.\install.ps1 -Runner
```

**MCP server** (exposes agent tools natively in Claude Code sessions):
```powershell
npm install
claude mcp add agentsystem -- node C:\full\path\to\AgentSystem\tools\mcp-server.js
```

**New repo:**
```bash
cd /path/to/your-repo
node /path/to/AgentSystem/tools/bootstrap-repo.js
```

**After editing agents:**
```bash
node tools/sync-agents.js
```

> **Note:** `caveman:cavecrew-builder`, `caveman:cavecrew-investigator`, and `caveman:cavecrew-reviewer` are plugin-provided agents (installed via the Claude Code plugin system). They do **not** live in `.agents/agents/` and are **not** managed by `tools/sync-agents.js`. Do not try to edit them.

See [docs/INSTALL.md](docs/INSTALL.md) for the full step-by-step guide (per CLI, per platform, verification checklist).

---

## Using agents

```bash
claude @friday     # engineering tasks (CTO — dispatches workers)
claude @jarvis     # strategy / cross-domain
claude @nat        # business / GTM
claude @sam        # security audit
```

Or just tell Friday to `do work` — it reads open issues and picks the highest priority one automatically.

---

## File layout

```
.agents/agents/        canonical agent definitions (edit here)
.agents/memory/        agent runtime memory
                       (model: field in each .md is the source of truth for model assignment)
tools/
  mcp-server.js        MCP server (6 tools for Claude Code)
  bootstrap-repo.js    per-repo setup
  agent-message.js     inter-agent inbox messaging
  graph/               Bayesian graph memory engine
docs/
  INSTALL.md           full installation guide
  HANDOFF.md           current state and open work
install.sh             first-time machine setup (install.ps1 on Windows)
tools/sync-agents.js   sync agents → all 3 CLIs
```

---

## License

[Source Available](LICENSE) — free to use, no redistribution or commercial sale.
