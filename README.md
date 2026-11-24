# Realm Guard

Check that an n8n workflow stays inside each client's QuickBooks books before you switch it on.

If you run automations for a bunch of clients, it only takes one copied workflow that still points at the last client's credential, or one AI agent that can reach every company, and entries land in the wrong books. You find out at month-end close, or when a client asks why they're looking at someone else's vendor list. I built Realm Guard to catch that before the workflow runs.

![Realm Guard report for a shared AP agent](docs/screenshot.png)

## Try it

The whole app is one HTML file with no server behind it, so nothing gets uploaded and it works offline. Build it once and open the file in any browser, then drop in a workflow or click one of the three samples:

```bash
npm ci
npm run build   # writes dist/index.html
npm run dev     # or work on it with hot reload
```

## What you give it

### The workflow export

In n8n, open the workflow, then use the ... menu and Download. Copying all nodes on the canvas works too. Template-site downloads usually strip credential names, and the report will tell you it couldn't verify those steps.

### The client manifest (optional)

This tells Realm Guard which n8n credential and which QuickBooks company belongs to which client. You don't have to write it from scratch: drop the workflow in and click "Draft from this workflow".

```yaml
version: 1
# The clients this workflow may touch. Leave it out to allow every tenant below.
scope: [harbor-dental]
tenants:
  - id: harbor-dental
    name: Harbor Dental
    credentials: ["QBO - Harbor Dental"]   # n8n credential names or IDs
    realmIds: ["9130354772541234"]         # QuickBooks company IDs
  - id: pine-street
    name: Pine Street Bakery
    credentials: ["QBO - Pine Street Bakery"]
    realmIds: ["4620816365181712"]
# Optional: your own approval steps, if you don't use n8n's Send and Wait.
approvalNodes: ["Airtable review queue"]
```

JSON works too. Realm IDs keep every digit even if you don't quote them.

Without a manifest you still get the agent, approval and state checks. Each credential or company ID is treated as its own client, so a flow from one company into another still shows up, but the verdict can't come out better than "Not verified".

## What it checks

| Rule | Flags | Severity |
| --- | --- | --- |
| **Shared credentials** | | |
| RG101 | A credential that isn't mapped to any client | High |
| RG102 | Another client's credential, the classic copied-workflow mistake | Critical |
| RG103 | A QuickBooks step with no credential in the export | Gap |
| RG104 | One credential mapped to, or used against, several clients | High |
| RG105 | An Authorization header built from workflow data | High, or medium when the token and company ID come from the same lookup |
| RG106 | A token pasted straight into the node | High |
| **Unpinned client IDs** | | |
| RG201 | A company ID that comes from data | High, critical when an AI model picks it |
| RG202 | A company ID that belongs to a client outside the scope | Critical |
| RG203 | A company ID that isn't in the manifest | High |
| RG204 | A company ID and a credential that belong to different clients | High |
| **Cross-client state** | | |
| RG301 | Data read from one client's books reaching a write into another's | Critical |
| RG302 | One AI agent holding tools for several clients | High, critical if one writes |
| RG303 | AI memory with a fixed session key | High in multi-client workflows, medium otherwise |
| RG304 | Workflow static data in a multi-client workflow | High |
| **Writes without approval** | | |
| RG401 | A create, update, delete, send or void with no approval step on the way | High, critical after an AI step, medium for manual-only runs |
| RG402 | An AI agent write tool with no human review step | Critical |
| **Export hygiene** | | |
| RG501 | Pinned data saved in the export | Low |

An approval step is n8n's Send and Wait (Slack, Gmail, Teams and friends), a Wait node that resumes on a webhook or form, a human review step on an agent tool, or anything you list under `approvalNodes`.

The verdict is **Fix before running** if anything is critical or high, **Not verified** if part of the workflow couldn't be checked, **Review before running** for medium and low findings, and **No boundary issues found** only when every QuickBooks step was fully checked and passed. You can copy any report as Markdown.

## Limitations

- It reads the export. It never runs the workflow or calls QuickBooks, so it can't see what happens at run time.
- It knows the QuickBooks node, its AI-tool version and HTTP Request calls to the QuickBooks API. Xero, Make and Zapier aren't covered yet.
- Sub-workflows and community nodes are listed, not opened. Scan each sub-workflow on its own.
- Vector stores aren't checked for per-client namespaces yet.
- When a company ID or token comes from an expression, it can only tell you where it comes from, not whether the lookup is right.

I checked every node type and default against the published n8n packages (`n8n-nodes-base` 2.48.5 and `@n8n/n8n-nodes-langchain` 2.48.6), and ran the engine over 2,066 public workflow exports without a crash.

## Security notes

**Assets:** the workflow export and manifest you load. Exports can hold client names, pinned run data and occasionally a pasted token.

**Untrusted inputs:** the workflow file and the manifest, whether dropped, browsed or pasted. Both are parsed as data (JSON and YAML), capped at 5 MB, and never evaluated. Expressions inside the workflow are read as text, never run.

**External systems:** none. The page makes no network requests. Fonts, styles and code are inlined in the one HTML file, and the end-to-end tests fail if the page tries to reach anything outside itself.

**Dangerous actions and their guards:**
- Copying the report puts client and node names on your clipboard. It only happens when you click Copy.
- The theme choice is saved in your browser's local storage. Nothing about your workflows is stored.

**Checks:** `npm audit` reports 0 vulnerabilities. Production dependencies are MIT, ISC and OFL-1.1 (the IBM Plex fonts, see `THIRD_PARTY_NOTICES.md`). A secrets scan of the repo and the build found nothing.

## Development

```bash
npm run lint        # ESLint with type-aware rules
npm run typecheck
npm test            # Vitest: parsers, every rule, samples, Markdown export
npm run build       # one self-contained dist/index.html
npm run preview     # serves the build on :4173
python3 e2e/test_slice.py --base http://localhost:4173/ --dark          # Playwright journey
python3 e2e/test_slice.py --base dist/index.html --file --dark          # same, from file:// with no server
```

The scanning engine lives in `src/engine` and doesn't touch the DOM, so it can sit behind a CLI or a CI check later. Design and technical choices are in `DECISIONS.md`, and what's next is in `ROADMAP.md`.

## License

MIT. The sample clients, credentials and company IDs are made up.
