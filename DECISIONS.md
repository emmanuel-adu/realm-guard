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
- **Without a manifest, each credential or company ID stands in for a client.** Cross-company flows and multi-client agents still show up, and the verdict can't be better than "Not verified". A credential joins a company only when it's used with that one company ID. Used with two, it never merges them: Intuit issues tokens per company, so the ID in the URL decides where a call goes.
- **Honest verdicts.** Missing credentials, unreadable company IDs, sub-workflow calls, unreadable connections and Code, community or MCP nodes that mention QuickBooks are coverage gaps that block "No boundary issues found".
- **Data flow follows n8n's runtime, not the canvas.** Disabled nodes pass data through, and `$('Node')` references count as data sources even across branches. Both were found by the fresh-eyes review, and both had produced false "clear" verdicts. Walks step through disabled nodes instead of adding a direct edge for every parent and child pair, because one disabled node with wide fan-in and fan-out turned that into millions of edges (a 1,500 by 1,500 hub took 4.9 seconds; it now takes milliseconds).
- **An approval needs a decision that reads the answer.** n8n continues past Send and Wait whatever the answer, so a write counts as approved only on a branch of an IF, Switch or Filter that reads the approver's answer and means yes (RG403). The engine knows where each approval puts its answer (`data.approved`, `data.text`, form field names), requires the condition to read it from the incoming item or from the approval node by name, and signs simple conditions: true or false, yes or no, approve or reject, and negated operators. "Exists" and "is empty" don't sign, because a no is present too. Switch routing follows n8n 2.48's source: V1 uses each rule's output field, V2 the rule's position, and a numbered fallback output or "continue on error" (IF and Filter send failed items to false, Switch to its first output) takes that output out of the yes set. A condition it can't sign protects no branch, so the error is a false alarm, never a false pass.
- **Reports never print an expression that could hold a secret.** RG105 and RG201 name where a token or company ID comes from (a node in this file, the incoming item, a variable) instead of quoting the expression, and text inside `$('...')` is quoted only when it's a real node name. A literal bearer token anywhere in a header, even inside an expression or in a header list the node no longer sends, is RG106.
- **Second review: CodeRabbit on PR #1.** It raised nine issues in ten comments after Emmanuel's approval, all fixed test-first: decision nodes that didn't read the answer or carried the write on the "no" branch, credential ownership that depended on node order, distinct company IDs merged through one credential, a company ID picked inside an expression read as fixed, inactive header lists read as active, agent tool writes that ignored the agent's inputs, parser-skipped nodes missing from the gaps, the quadratic disabled-node bridge, and the RG105 detail that could print part of a token. Its re-review of those fixes raised nine more, also fixed test-first: presence checks counted as yes, another step's `approved` flag counted as the person's answer, Switch V2 position routing, Switch fallbacks, swapped disabled-node marks that let a canvas-copy write pass as gated, a URL expression that could return an unread path, the AI tool's header field read on HTTP Request, `$('...')` text quoted without being a node, and credential names missed on disabled nodes. Checking the Switch source also turned up the "continue on error" routes.
- **The manifest is strict.** Unknown keys are rejected with a suggestion, because an ignored `Scope:` would silently allow every client.
- **The build enforces its privacy promise** with a Content Security Policy that refuses every network request.
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
**Open source**, provisional until Emmanuel agrees (triage 2026-11-23). Bias checklist: 7 of 12 flags, so the scores stay low and nothing here counts as demand.

| Item | Score | Evidence |
| --- | --- | --- |
| Severity | 2 | Paid Upwork posts (Nov 16-19, 2026) list "zero data crossover" and human review as requirements; repeated n8n forum threads on isolating client credentials; a forum write-up (Oct 30, 2026) of two successful requests hitting the wrong customers; Intuit's 2026 survey: 3 in 5 accountants say clients ask for proof of AI data protection always or frequently. Desk research, so capped at 2. |
| Willingness to pay | 1 | Firms pay for isolated builds, not for a checker. No spend on anything like this found. |
| Distribution | 1 | The n8n forum, r/n8n and Upwork freelancers are open channels, and other free linters got replies there. Nothing has been posted yet. |
| Edge | 2 | n8n's audit and four free linters don't check client boundaries at all. The common alternative, one n8n instance per client, removes most cross-client risk but costs a server per client, and it doesn't catch writes that skip approval. |
| Hosted value | 1 | A preflight check run before go-live. It runs in the browser, so hosting it adds little. |
| Upkeep | 3 | A static file with no server or API cost. Node-type changes in n8n are the only maintenance. |

Rule 2 applies: the people who'd run it are automation builders, running locally is the advantage, and hosted value is 1.
