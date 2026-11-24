# Decisions

## Why this exists
Bookkeeping firms and the freelancers who automate for them are wiring AI and n8n into many clients' QuickBooks companies at once. One copied workflow with the wrong credential, or one agent that can reach every client, posts entries to the wrong books or leaks one client's numbers into another's. Paid job posts in November 2026 ask for exactly this kind of build with "zero data crossover" and human review, and nothing checks for it before the workflow runs.

## V1 boundary
We are solving: drop an exported n8n workflow (plus a client manifest, or draft one in the app) and get a report of tenant-boundary problems, each naming the node, what was seen, why it matters and the fix.

We are intentionally not solving (see `ROADMAP.md`):
- Live scans through the n8n API.
- QuickBooks sandbox tests and runtime enforcement.
- Xero, Make and Zapier.
- A CLI and CI gate.
- Accounts, saved history and team sharing.
- Model-written explanations.
- Vector-store namespaces as a cross-client path.

## Key technical decisions
- **Client-only static app (Vite 8, React 19, TypeScript, Tailwind 4)** because the scan needs no server, and "your workflow never leaves this page" is the main trust point for accounting firms. The kit's web-app playbook puts client-only tools on Vite.
- **The production build is one self-contained HTML file** (`vite-plugin-singlefile`). It runs from `file://`, offline, and inside the approval artifact unchanged. The kit's `make_preview.py` drops the framework runtime, which would remove the scanner itself, so it isn't used here.
- **The engine (`src/engine`) has no DOM imports** so a CLI or CI gate can wrap it later without changes.
- **Node-type knowledge was checked against the published packages** (`n8n-nodes-base` 2.48.5, `@n8n/n8n-nodes-langchain` 2.48.6, `n8n-workflow` 2.48.4), not memory: QuickBooks operations and defaults, the `*Tool` agent-tool types, `*HitlTool` review steps, memory session-key defaults and `sendAndWait`.
- **Realm IDs are parsed as BigInt from YAML** because they run to 19 digits, past what a JS number holds.
- **Without a manifest, each credential or company ID stands in for a client.** Cross-company flows and multi-client agents still show up, and the verdict can't be better than "Not verified".
- **Honest verdicts.** Missing credentials, unreadable company IDs and sub-workflow calls are coverage gaps that block "No boundary issues found".
- **TypeScript 6.0, not 7.0**, because `typescript-eslint` supports up to 6.0 and type-aware lint matters more here than the faster compiler.
- **Fonts self-hosted** with `@fontsource` (IBM Plex Sans and Plex Mono), inlined into the build.
- Model: none. Every rule is deterministic.
- **Design reference lock** (Refero, 2026-11-23):
  - **Leading direction:** Hugging Face's "community meets workbench" style. White canvas, cool gray rules that stay faint, monospaced identifiers for technical names, compact 8px-corner rows, dense practical tables, modest actions. It fits people who want a useful tool, not a luxury brand.
  - **Borrowed from CodeRabbit ("instruments against chaos"):** color behaves only as a signal (severity colors appear in badges, the verdict and the severity bar, nowhere else), and small uppercase mono eyebrow labels mark sections. Its segmented color edge becomes a data-bearing severity bar.
  - **Borrowed from screens:** Lovable's security panel (status card on top, then an issue list with expandable rows) and Lemon Squeezy's dashed drop zone with "or click to browse".
  - **Rejects:** no marketing hero, gradients, glass or illustration; no decorative serif or color-swapped headline words; no indigo or violet; no pills on every card; no heavy shadows or black grid lines; don't copy Hugging Face's Source Sans or its dark product stage.
  - **Tokens:** canvas `#ffffff`, wash `#f8fafc`, rule `#e4e7ec`, ink `#0f172a`, muted `#5b6475`. Primary action is ink-filled, 8px corners. Severity: critical `#b42318`, high `#c2410c`, medium `#a16207`, low `#475467`, clear `#067647`. Dark theme is a cool near-black instrument panel: canvas `#0d1117`, panel `#151a22`, edge `#262d38`. Radius 8px for rows and controls, 12px for panels. Shadow at most `0 1px 2px rgba(0,0,0,.05)`.

## Employer overlap
Overlaps data security (tenant isolation and data-leak checks), the same broad area as Databolt at Capital One. It serves bookkeeping firms rather than banks or fintechs and reuses nothing built on the job. A note only, per the build kit.

## Kill criteria (written before testing)
- The engine crashes on, or misreads, real public n8n exports.
- The core journey can't run without a server or a paid API.
- Triage puts Edge at 0: a free tool already checks tenant boundaries in n8n workflows.

## Assumptions
- Exports from the n8n editor keep credential IDs and names per node. Template-library copies strip them, which the report treats as a gap.
- QuickBooks OAuth tokens are issued per company (realm), so a credential maps to one client.
- Firms don't keep a client manifest today, so the app drafts one from the workflow.
- The QuickBooks node and HTTP Request calls to the QBO API cover most real QuickBooks steps in n8n.

## What would change my mind
- n8n or Intuit shipping per-client policy checks for workflows.
- Firms telling us they only ever run one n8n instance per client (then wrong-credential mistakes can't happen and the agent rules carry the value).
- Real exports routinely lacking credential names, which would leave most reports "Not verified".

## Verdict
Pending triage at step 6.
