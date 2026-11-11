# ProofLore

Local, shared memory for coding agents.

ProofLore gives Codex, Claude Code, Cursor and other MCP clients the same reviewed
project knowledge. Decisions, corrections and approved rules live in the repository,
so every developer and agent can work from the same context.

- Local-first: no hosted ProofLore service is required.
- Provider-neutral: one memory store works across supported agents.
- Reviewable: agents may propose rules, but only a human can approve them.
- Merge-friendly: knowledge is stored as immutable, content-addressed JSON records.
- Privacy-aware: prompts, chat transcripts and source files are not collected.

## Quick start

Requires Node.js 20 or newer.

```sh
npm install --save-dev prooflore
npx prooflore setup
```

To preview the planned changes without writing files:

```sh
npx prooflore setup --dry-run
```

`setup` configures Codex, Claude Code and Cursor by default. To configure selected
clients only:

```sh
npx prooflore setup --provider codex
npx prooflore setup --provider claude --provider cursor
```

Restart any agent sessions that were already open.

## How it works

ProofLore creates a project-local store:

```text
.prooflore/
  .gitignore
  config.json
  setup.json
  AGENT_WORKFLOW.md
  records/
    <sha256>.json
```

Commit the generated configuration and `records/` directory. Each record is immutable,
so contributions from different developers normally merge as separate files.

Local caches, sessions, traces, transcripts, logs and temporary files are excluded by
`.prooflore/.gitignore`. ProofLore does not upload the store or open a network port.

Depending on the selected clients, `setup` also creates or updates:

```text
AGENTS.md            # ProofLore workflow pointer for Codex/Cursor
CLAUDE.md            # ProofLore workflow pointer for Claude Code
.codex/config.toml   # Codex MCP configuration
.mcp.json            # Claude Code MCP configuration
.cursor/mcp.json     # Cursor MCP configuration
```

If any of these files already exists, ProofLore preserves unrelated configuration
and changes only its managed block or MCP entry.

## Supported clients

| Client | Project configuration |
| --- | --- |
| Codex | `.codex/config.toml` and an `AGENTS.md` pointer |
| Claude Code | `.mcp.json` and a `CLAUDE.md` pointer |
| Cursor | `.cursor/mcp.json` |
| Other MCP clients | Manual stdio configuration using `prooflore-mcp` |

Existing configuration and instructions outside ProofLore-managed blocks are
preserved. Setup never changes global agent settings, permissions or approval policy.

## Agent workflow

1. Retrieve relevant memory before planning or editing, using a concise English task
   description while preserving exact identifiers.
2. Treat approved rules as project guidance.
3. Treat historical records as advisory and verify them against the current code.
4. Record durable decisions, corrections, outcomes and exemplars after verification.
5. Propose reusable rules for human review.

An agent cannot approve its own rule. Supported clients can present a review form in
chat; the CLI is available as a fallback:

```sh
npx prooflore candidates --limit 20
npx prooflore review RECORD_ID approved \
  --reason "Confirmed in code review" \
  --developer REVIEWER_ID
```

## MCP tools

| Tool | Purpose |
| --- | --- |
| `project_memory_context` | Retrieve bounded context for a task and affected paths |
| `project_memory_get` | Read an immutable record by ID |
| `project_memory_status` | Check store integrity, contributors and setup state |
| `project_memory_candidates` | List rules awaiting human review |
| `project_memory_record` | Save a verified observation |
| `project_memory_propose_rule` | Propose a reusable rule |
| `project_memory_review_rule` | Request a human-controlled review form |

## Team identity

For consistent attribution, configure a stable developer ID in the MCP environment:

```text
PROJECT_MEMORY_DEVELOPER_ID
PROJECT_MEMORY_PROVIDER
PROJECT_MEMORY_MODEL
PROJECT_MEMORY_SESSION_ID
```

Server-bound values take precedence over values supplied by an agent. Developer IDs
are provenance labels, not authentication.

## Updates

Update the dependency, preview the reconciliation, then apply it:

```sh
npm update prooflore
npx prooflore update --dry-run
npx prooflore update
```

ProofLore updates only content it owns. If a managed block was edited, removed or
replaced, the update stops without overwriting the project version.

To reconcile setup automatically after dependency installation, add an explicit
project script:

```json
{
  "scripts": {
    "postinstall": "prooflore sync"
  }
}
```

If the project already has a `postinstall` script, append `prooflore sync` rather
than replacing the existing command.

## CLI

| Command | Description |
| --- | --- |
| `prooflore setup` | Initialize the store and configure supported clients |
| `prooflore update` | Reconcile an existing installation |
| `prooflore sync` | Setup/update command suitable for package lifecycle scripts |
| `prooflore init --project ID` | Initialize only the memory store |
| `prooflore doctor` | Verify records, reviews and managed setup |
| `prooflore context TASK --path PATH` | Retrieve bounded local context |
| `prooflore candidates` | List rule candidates |
| `prooflore record --file INPUT.json` | Append a validated record |
| `prooflore review ID VERDICT ...` | Record a human review |
| `prooflore mcp` | Start the stdio MCP server |

## Security and privacy

- No runtime network requests or hidden model calls.
- No raw prompts, chat transcripts or source trees are stored.
- Likely credentials and private keys are rejected before storage.
- Paths must remain inside the current project.
- Stored records are revalidated and their content hashes are checked on read.
- Corrupted, tampered or foreign-project records fail closed.
- Agents cannot supply human rule-review verdicts.
- The package does not execute project code or modify global provider configuration.

Normal client approval and project-trust controls still apply.

## Troubleshooting

### The agent does not see ProofLore tools

Run `npx prooflore doctor`, confirm the client-specific configuration exists, then
restart the agent session.

### Setup or `postinstall` stops

ProofLore detected stale or edited managed content. Inspect the proposed changes:

```sh
npm install --ignore-scripts
npx prooflore sync --dry-run
npx prooflore sync
```

### A proposed rule is not applied

Rules remain advisory until a human approves them. Run `npx prooflore candidates`
and review the candidate in chat or through the CLI.

### `doctor` reports a review conflict

Two valid human verdict branches exist. Neither becomes authoritative automatically;
a human must submit a later review that joins the branches.

## License

MIT. See [LICENSE](LICENSE).
