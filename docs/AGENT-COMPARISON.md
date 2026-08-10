# Agent System Comparison: Current vs. crhis_agents

**Comparison Date:** 2026-05-21
**Purpose:** Identify strengths, gaps, and recommendations for each agent category

> **HISTORICAL SNAPSHOT — dated 2026-05-21, not current.** This document compares the agent
> system as it existed before ADR-001's Option B was implemented. Every gap it identifies against
> Jarvis (no default entry, no startup procedure, no routing) is closed — see `~/.claude/CLAUDE.md`
> and `docs/AGENTS.md`. The per-agent grades below (including Threepio's "D — Definition thin,
> unclear scope") describe the pre-implementation roster; Threepio, r2d2, and every other agent now
> have full definitions in `.agents/agents/<name>.md`, synced via `tools/sync-agents.js` (12 agents,
> `--check` passes). The "Effort to Production Ready" estimate at the bottom is likewise resolved —
> the work it lists was completed. Kept for historical context only; do not use it to judge current
> agent capability.

---

## 1. Orchestration / Leadership

### Current: Jarvis (CEO, Opus 4.7)
**What it does:**
- Defined as CEO with orchestration authority
- Autonomous decision on strategy, pivots, resource allocation, conflicts
- 8-step startup (parallel GitHub queries, decision synthesis)
- Weekly cadence review
- Escalation & decision authority

**Strengths:**
- ✅ Opus-class model (highest capability)
- ✅ Clear authority structure
- ✅ Decision-making focus

**Gaps:**
- ❌ Not marked as default entry agent
- ❌ No proactive dispatch (waits for conflicts)
- ❌ 8-step startup defined but not explicit
- ❌ No session logging structure

**Grade:** B+ (defined well, not fully operationalized)

---

### crhis_agents: Toni (Chief of Staff, Sonnet 4.6)
**What it does:**
- Proactive leader, agent orchestrator
- **Default entry agent** (loads on startup)
- 16-step startup checklist with parallel queries
- Daily cadence (startup, during, shutdown)
- Weekly company review
- Autonomous dispatch via GitHub Issues
- Intent-based leadership (specify intent, agent chooses method)

**Strengths:**
- ✅ **Default entry** (clear on startup)
- ✅ **Proactive dispatch** (initiates work, creates Issues)
- ✅ **Rich memory** (session logs with decisions, blockers, learnings)
- ✅ Explicit 16-step startup
- ✅ Coordination rules (8 explicit protocols)
- ✅ Domain ownership map
- ✅ Daily + weekly cadence
- ✅ Leadership framework documented (Marquet, Willink, Eddie's PM Law)

**Gaps:**
- ❌ Business-centric (not ideal for pure engineering)
- ❌ Less technical depth (no equivalent to Friday's TDD requirement)
- ❌ Sonnet model (not Opus)

**Grade:** A- (operationally mature, may be over-specified for engineering)

---

### Verdict
**For cross-domain, autonomous orchestration:** crhis's Toni wins by far.
**For engineering-specific orchestration:** Current Jarvis has better domain authority, but needs Toni-style operationalization.

**Recommendation:** Adopt Jarvis + add Toni's startup/dispatch/memory structure.

---

## 2. Security & Compliance

### Current: Sam (CSO, Sonnet 4.6)
**What it does:**
- Autonomous on security policies, compliance, vendor decisions
- **HARD GATE on main merges** (pre-merge security audit required)
- Pre-merge checklist: 10 items (data access, auth, credentials, PHI, compliance, audit trail, input validation, error messages, secrets, vendors)
- Blocks merge if: data validation missing, credentials in logs, auth skipped, PHI without review, new vendor without BAA, audit trail missing, encryption missing, rate limiting absent, tenant isolation compromised
- Quarterly security reviews
- Escalation: disagreement → human (CEO/CISO)

**Strengths:**
- ✅ **HARD GATE on main** (non-negotiable security)
- ✅ Comprehensive pre-merge checklist
- ✅ Clear block conditions
- ✅ Quarterly deep reviews
- ✅ Strong enforcement

**Gaps:**
- ⚠️ No policy documentation (what policies exist?)
- ⚠️ No vendor BAA tracking system
- ⚠️ No compliance roadmap (SOC-2, HIPAA, PCI-DSS)
- ⚠️ Quarterly reviews seem light for security-sensitive work

**Grade:** A (enforcement-strong, governance lighter)

---

### crhis_agents: Belissa (Chief Security Officer, Sonnet 4.6)
**What it does:**
- CSO role, policy-focused
- SOC-2, HIPAA, security policies, audit readiness
- Policy documentation, training, compliance tracking
- Audit preparation

**Strengths:**
- ✅ Governance-focused (policies documented)
- ✅ HIPAA/SOC-2 expertise
- ✅ Training programs (HIPAA training)

**Gaps:**
- ❌ No hard gate mechanism
- ❌ No pre-merge audit
- ❌ Less enforcement, more policy

**Grade:** B (strong governance, weak enforcement)

---

### Verdict
**For enforcement:** Current Sam wins decisively (hard gate > policy docs).
**For governance:** crhis's Belissa wins (policy documentation, training, compliance tracking).

**Recommendation:** Keep Sam's hard gate, add Belissa's governance structure (policy docs, training, compliance roadmap).

---

## 3. Backend Engineering

### Current: Ultron (Backend, Haiku 4.5) + Pym (Database, Haiku implied)
**What it does:**

**Ultron:**
- Domain authority: backend architecture, API design, service implementation, deployment
- Implementation discipline: TDD (tests first), SOLID principles, type hints, Pydantic validation
- API design standards: 10 RESTful standards (semantics, error responses, validation, rate limiting, tenant isolation, audit logging, PHI protection, idempotency, field preservation, postcondition verification)
- Deployment discipline: CI/CD only, infrastructure-as-code, gradual rollout, health checks, observability, rollback, smoke tests
- Pre-handoff checklist: tests passing, lint/type check clean, no security warnings, test receipts in PR, no hardcoded secrets

**Pym:**
- Database schema, migrations, pressure-testing
- Domain authority under Friday (escalates to Friday)

**Strengths:**
- ✅ **TDD mandatory** (tests first, code passes them)
- ✅ **SOLID principles** explicit
- ✅ **Type hints everywhere**
- ✅ **10 API standards** documented
- ✅ **Deployment discipline** strict (CI/CD only)
- ✅ **Pre-handoff checklist** clear
- ✅ **Separated database role** (Pym) = cleaner ownership

**Gaps:**
- ⚠️ Haiku model (smaller, faster but less capable for complex design)
- ⚠️ No implementation examples
- ⚠️ Pym definition minimal (implied behavior)

**Grade:** A (strong standards, great discipline)

---

### crhis_agents: Soren (Chief Engineer, implied)
**What it does:**
- Software engineering, debugging, deploying, architecture
- Hands-on: can read, write, build, deploy
- Includes database, backend, API, deployment (all-in-one)

**Strengths:**
- ✅ Hands-on engineer (actually implements)
- ✅ Broad domain (database to deployment)
- ✅ Proven production record (crhis uses in Arbor Genie, FaxGenie, Pathway Genie)

**Gaps:**
- ❌ No TDD mandate documented
- ❌ No SOLID principles listed
- ❌ No API standards documented
- ❌ Less precise technical standards
- ❌ Database role not separated (all-in-one role)

**Grade:** B (proven capability, lighter on standards)

---

### Verdict
**For technical rigor:** Current Ultron + Pym win decisively.
**For breadth:** crhis's Soren wins (all-in-one engineer).

**Recommendation:** Keep current split (Ultron + Pym) + keep TDD/SOLID/API standards.

---

## 4. Frontend Engineering

### Current: Astra (Frontend, Haiku 4.5)
**What it does:**
- Domain authority: frontend components, browser testing, performance, responsive design, state management, routing
- Component standards: 7 requirements (prop validation, event handlers, accessibility WCAG 2.1 AA, responsive breakpoints, dark mode, animation performance, error boundaries, loading states)
- Testing discipline: unit, integration, E2E, visual regression, accessibility, performance
- Performance standards: Lighthouse >90, Core Web Vitals (LCP <2.5s, INP <200ms, CLS <0.1), bundle monitoring, lazy loading, image optimization, CSS-in-JS profiling
- Pre-handoff: tests passing, Lighthouse audit clean, accessibility tests passing, no console errors, no hardcoded API keys, no sensitive data in state/localStorage
- Escalation: design → Wanda, conflicts → Friday, security → Sam

**Strengths:**
- ✅ **Accessibility mandate** (WCAG 2.1 AA)
- ✅ **Performance standards** specific (LCP, INP, CLS targets)
- ✅ **Testing discipline** comprehensive (5 types)
- ✅ **Security awareness** (client-side secrets, localStorage risks)
- ✅ **Clear escalation paths** (Wanda for design, Friday for conflicts)

**Gaps:**
- ⚠️ Haiku model (smaller for complex UI logic)
- ⚠️ No component library examples
- ⚠️ No CSS-in-JS framework preferences documented

**Grade:** A- (strong standards, slight capability gap)

---

### crhis_agents: Soren (includes frontend)
**What it does:**
- Includes frontend as part of all-in-one engineer role
- No specialized frontend standards documented

**Strengths:**
- ✅ Full-stack capability

**Gaps:**
- ❌ No accessibility standards
- ❌ No performance targets
- ❌ No testing discipline
- ❌ Frontend lost in general engineer role

**Grade:** C (all-in-one, not specialized)

---

### Verdict
**For frontend expertise:** Current Astra wins decisively.

**Recommendation:** Keep Astra as-is.

---

## 5. Design & UX

### Current: Wanda (Design, Sonnet 4.6)
**What it does:**
- Domain authority: UX/UI decisions, component design, design system, accessibility, design tokens, visual language
- Design process: research-driven, user testing, A/B testing, performance metrics, accessibility audit (WCAG 2.1 AA)
- Component review: naming, prop interfaces, variant coverage, responsive behavior, dark mode, animation performance
- Standards enforcement: design-to-code consistency, Code Connect mappings, design token sync, component naming mirrors code

**Strengths:**
- ✅ **Code Connect integration** (Figma ↔ code sync)
- ✅ **Accessibility audit** (WCAG 2.1 AA)
- ✅ **Design-to-code consistency** enforced
- ✅ **Design tokens** managed
- ✅ **User testing** mentioned

**Gaps:**
- ⚠️ No design system library examples
- ⚠️ No component variant strategy documented

**Grade:** A (strong design governance, good integration)

---

### crhis_agents: (No design agent)
**Gap:** No design role documented in crhis_agents (Arbor Genie may handle design differently, outside agent system).

**Grade:** N/A

---

### Verdict
**For design governance:** Current Wanda is the only contender.

**Recommendation:** Keep Wanda as-is.

---

## 6. DevOps & Infrastructure

### Current: Leo (DevOps, Haiku 4.5)
**What it does:**
- Domain authority: CI/CD pipelines, infrastructure, deployment automation, observability, monitoring, incident response, on-call rotation
- CI/CD discipline: 7 requirements (automated tests, lint/type checks, security scanning, artifact signing, staging deployment, production CD, rollback procedures, health checks)
- Infrastructure standards: infrastructure-as-code, version controlled, peer reviewed, immutable deployments, auto-scaling, disaster recovery, multi-region, encrypted secrets
- Observability: structured logging (JSON), log aggregation, metrics, distributed tracing, SLO alerting, dashboards, tuned on-call alerting
- Deployment gates: tests passing, security scan clean, staging smoke tests, performance baseline acceptable, rollback verified
- Pre-handoff: no secrets in logs/config, access control reviewed, encryption in-transit/at-rest, audit logging enabled, compliance scanning

**Strengths:**
- ✅ **Infrastructure-as-code required**
- ✅ **Observability standards** comprehensive
- ✅ **Deployment gates** clear
- ✅ **Security integration** (pre-handoff to Sam)
- ✅ **On-call rotation** managed

**Gaps:**
- ⚠️ Haiku model (smaller, may struggle with complex infra design)
- ⚠️ No specific tool examples (Terraform, Prometheus, ELK, etc.)

**Grade:** A- (strong discipline, model size light)

---

### crhis_agents: Soren (includes DevOps)
**What it does:**
- DevOps as part of all-in-one engineer role
- No specialized DevOps standards documented

**Grade:** C (all-in-one, not specialized)

---

### Verdict
**For DevOps expertise:** Current Leo wins.

**Recommendation:** Keep Leo as-is.

---

## 7. Business Strategy & Pricing

### Current: Nat (CBO, Sonnet 4.6)
**What it does:**
- Autonomous decision authority: business strategy, market positioning, pricing, customer segmentation, sales strategy, revenue targets
- Financial decisions: budget allocation, revenue forecasts, deal closure, financial commitments
- Customer focus: voice of customer, market research synthesis, competitive positioning, customer health scoring
- Escalation: disagree with Jarvis → escalate via GitHub Discussion with business rationale
- Reporting: quarterly business reviews, revenue forecasts, CAC tracking, LTV analysis

**Strengths:**
- ✅ **Revenue authority** (deal closure, budget allocation)
- ✅ **Metrics-focused** (CAC, LTV, revenue forecasts)
- ✅ **Escalation protocol** (GitHub Discussion)

**Gaps:**
- ⚠️ Thin definition (no detail on how)
- ⚠️ No market analysis examples
- ⚠️ No customer segmentation framework

**Grade:** B (authority clear, methods light)

---

### crhis_agents: Ralph (Strategy Advisor) + Scout (Sales & BD) + Tiffany (Marketing)
**What it does:**
- **Ralph:** Market analysis, competitive positioning, business model
- **Scout:** Sales pipeline, prospect research, outreach, meeting prep
- **Tiffany:** Brand, content, campaigns, website, sales collateral

**Strengths:**
- ✅ **Specialized roles** (strategy ≠ sales ≠ marketing)
- ✅ **Sales pipeline tracked** (Issues + GitHub board)
- ✅ **Content management** (Tiffany owns website, collateral)

**Gaps:**
- ⚠️ Lighter than Nat (less financial depth)
- ⚠️ No revenue forecast examples
- ⚠️ Scout & Tiffany roles less detailed

**Grade:** B+ (good separation, lighter on depth)

---

### Verdict
**For business strategy:** Nat (current) has more authority. Ralph (crhis) lighter on depth.
**For sales:** Scout (crhis) is explicit. Nat (current) doesn't have sales-specific role.
**For marketing:** Tiffany (crhis) owns it. Current system has no marketing role.

**Recommendation:** 
- Keep Nat for business strategy
- Add Scout equivalent (sales pipeline, prospect research)
- Add Tiffany equivalent (marketing, content, campaigns) or use r2d2 as fallback

---

## 8. Documentation & Communications

### Current: Threepio (Comms & Docs, model unspecified)
**What it does:**
- Documentation, comms, PR descriptions, release notes, email drafts, handoffs
- (Definition thin, unclear scope)

**Grade:** D (underspecified)

---

### crhis_agents: Tiffany (Head of Marketing, includes content)
**What it does:**
- Brand, content, campaigns, website, sales collateral
- (Comms & docs secondary to marketing)

**Grade:** C (marketing-focused, not documentation-specific)

---

### Verdict
**For documentation:** Current should have Threepio specialized. crhis doesn't have equivalent.

**Recommendation:** 
- Spec Threepio fully (README, CHANGELOG, API docs, PR descriptions, email templates, handoffs)
- Add to routing rules

---

## 9. HR & Operations

### Current: (No HR role)
**Gap:** No people/operations agent.

---

### crhis_agents: Keegan (Chief People Officer) + Margaret (Leadership Meeting Manager) + Toni (Chief of Staff for ops)
**What it does:**
- **Keegan:** Onboarding, offboarding, HR compliance, HIPAA training, payroll coordination
- **Margaret:** Leadership meeting agendas, meeting notes, WWW tracking
- **Toni:** Cross-domain operations, Open Loops, goals, decisions

**Strengths:**
- ✅ **People management** (Keegan)
- ✅ **Operations coordination** (Toni)
- ✅ **Meeting management** (Margaret)
- ✅ **Compliance training** (HIPAA)

---

### Verdict
**For pure engineering:** Current system correct to omit HR.
**For organization with employees:** Need Keegan + Margaret equivalents.

---

## Summary Matrix

| Category | Current | crhis_agents | Winner | Notes |
|----------|---------|-------------|--------|-------|
| **Orchestration** | B+ (Jarvis) | A- (Toni) | crhis | Toni operationally mature, Jarvis needs enhancements |
| **Security** | A (Sam) | B (Belissa) | Current | Sam's hard gate unbeatable, Belissa stronger on governance |
| **Backend** | A (Ultron + Pym) | B (Soren) | Current | Ultron's TDD/SOLID/API standards exceptional |
| **Frontend** | A- (Astra) | C (Soren) | Current | Astra's accessibility + performance standards strong |
| **Design** | A (Wanda) | N/A | Current | Wanda only contender |
| **DevOps** | A- (Leo) | C (Soren) | Current | Leo's infrastructure standards excellent |
| **Business** | B (Nat) | B+ (Ralph + Scout) | crhis | crhis better on sales/marketing separation |
| **Comms/Docs** | D (Threepio) | C (Tiffany) | crhis | Both weak, crhis at least has someone |
| **HR/Ops** | N/A | A (Keegan + Toni) | crhis | Current omits entirely (correct for engineering) |
| **Overall** | 70% | 75% | Tie | Current stronger on tech, crhis stronger on ops |

---

## Recommendation: Hybrid Approach

**Keep from Current:**
- ✅ Friday (CTO) — architecture authority
- ✅ Sam (CSO) — hard security gate
- ✅ Ultron (Backend) — TDD/SOLID/API standards
- ✅ Astra (Frontend) — accessibility/performance
- ✅ Leo (DevOps) — infrastructure standards
- ✅ Wanda (Design) — design governance
- ✅ Pym (Database) — schema expertise

**Enhance with crhis Ideas:**
- Add Jarvis as proactive orchestrator (startup, dispatch, memory)
- Add routing rules (Toni's dispatch model)
- Add memory structure (session logs, learnings)
- Add coordination rules (cross-agent protocols)
- Add domain ownership map

**Add New (if your org has these domains):**
- ⚠️ Sales agent (Scout equivalent) if you need sales tracking
- ⚠️ Marketing agent (Tiffany equivalent) if you need campaigns/content
- ⚠️ HR agent (Keegan equivalent) if you have employees

**Result:** 
- Engineering-precise + orchestration-ready + autonomous
- Current strengths preserved + crhis coordination added
- Optionally add business/HR roles as org grows

---

## Effort to Production Ready

| Item | Effort | Timeline |
|------|--------|----------|
| Mark Jarvis default | 30 min | Today |
| Memory structure template | 1 hour | Today |
| Routing rules | 1.5 hours | Tomorrow |
| Jarvis startup checklist | 2 hours | Tomorrow |
| Domain ownership map | 1 hour | This week |
| Bypass mechanism | 1 hour | This week |
| Spec Threepio & general-coding | 1.5 hours | This week |
| Coordination rules | 1.5 hours | Next week |
| Sync script update | 2 hours | Next week |
| Consolidated docs | 2 hours | Next week |
| **Total** | **14 hours** | **2-3 weeks** |

After completion: **System is production-ready.**
