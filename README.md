# ProofLore

Reviewed project memory for coding agents.

[![npm](https://img.shields.io/npm/v/prooflore?logo=npm)](https://www.npmjs.com/package/prooflore)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

ProofLore helps coding agents reuse approved project rules across chats. Agents can propose reusable rules backed by evidence. You decide what becomes active and what to share with your team.

## Try it in your project

Requires Node.js 20 or later. From your project root, run:

```sh
npm install -D prooflore
npx prooflore setup
```

Open a new chat in Codex, Claude Code, or Cursor. Use an MCP client that supports review forms to approve or edit rules in chat. The CLI also supports review.

Ask for the project rules to see the active catalog. You can filter by language, tag, or test type. The agent can display the rules in your chat language or show the stored wording on request.

<details>
<summary>Share rules with your team</summary>

ProofLore keeps pending rules and rejected reviews in the Git-ignored `.prooflore/local/` directory. Approving a rule for the team makes it shareable through Git. To keep an approved rule personal, choose **Keep only on this computer** in the review form.

Review or edit a proposed rule in the chat language. The agent saves approved edits in English, and ProofLore keeps earlier versions and review decisions in history. Follow-up evidence can refine a pending draft. Changes to approved rules go through review.

To share team rules, commit the generated setup files and the shared `.prooflore/records/` files you intend to share. Teammates install the project dependencies and open a new agent chat. Older records already in the shared directory stay there after upgrade.

ProofLore stores memory and evidence references on disk. The connected coding agent handles chat, translation, and review.

</details>

<details>
<summary>Setup, updates, and troubleshooting</summary>

Preview setup or configure only one client:

```sh
npx prooflore setup --dry-run
npx prooflore setup --provider codex
```

Setup adds project-level MCP configuration and workflow instructions while preserving unrelated content. Codex uses `.codex/config.toml`, Claude Code uses `.mcp.json`, and Cursor uses `.cursor/mcp.json`. Other MCP clients can run `prooflore-mcp` over stdio.

After updating the dependency, run `npx prooflore sync` and open a new agent chat. Teams can opt into a `"postinstall": "prooflore sync"` script. If setup reports a conflict, use `npx prooflore sync --dry-run` to inspect it.

When upgrading from the older generated workflow, preview the migration and confirm it if the proposed changes look right.

```sh
npx prooflore sync --accept-rule-migration --dry-run
npx prooflore sync --accept-rule-migration
```

If the agent cannot find ProofLore, run `npx prooflore doctor`. To check reviewer identity, run `npx prooflore identity show`. ProofLore uses the repository-local Git name or a local override set with `npx prooflore identity set YOUR_ID`.

</details>

<details>
<summary>Import and manage rules from the terminal</summary>

```sh
npx prooflore import rules.md
npx prooflore import rules.md --apply
npx prooflore candidates
npx prooflore rules --state approved --language typescript --tag jest --test-type unit
npx prooflore history RECORD_ID
```

Import previews a Markdown file with one rule per top-level bullet or numbered item. Imported rules start as local pending candidates. Use `--local` when the imported rules should remain personal after approval. You can also paste existing rules into chat and ask ProofLore to preview an import.

If your client cannot open the review form, use the CLI:

```sh
npx prooflore review RECORD_ID approved --reason "Confirmed in review" --developer YOUR_ID
```

Use `revoked` in place of `approved` to retire a rule. Prior versions and decisions remain in history.

</details>

[MIT License](LICENSE)
