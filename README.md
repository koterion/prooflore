# ProofLore

Reviewed project memory for coding agents.

[![npm](https://img.shields.io/npm/v/prooflore?logo=npm)](https://www.npmjs.com/package/prooflore)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

ProofLore helps your agent reuse team decisions and coding rules across chats. The agent can propose a rule after finishing a task. Once you approve it, future agents can use it when it applies.

## Try it in your project

Requires Node.js 20 or later. From your project root, run:

```sh
npm install -D prooflore
npx prooflore setup
```

Open a new chat in Codex, Claude Code, or Cursor.

## See it in Codex

Codex tested a team convention on checkout and profile forms, then reused the
approved rule for a billing form in a fresh chat. The excerpts below are from a
demo project with a test approval through the ProofLore form.

```text
You: Can you add a regression test for the invalid checkout form? Assert the validation message and make sure the save request never fires. We want both checks for invalid submissions on all our forms, including profile.

Codex: Added invalid-submission tests for checkout.test.js and profile.test.js.

Both assert:

- The validation message.
- The save request never fires.

`npm test`: 4/4 passing.

I also saved this pattern as a pending ProofLore rule. Would you like to review it?

You: Open the approval form for the form validation rule.
```

In the ProofLore form, choose **Approve → Accept**.

```text
Codex: The form validation rule was approved through the ProofLore review form.
```

In a new chat:

```text
You: Show me the active ProofLore rules.
```

| Rule | Tags | Programming languages | Test types |
|---|---|---|---|
| For every form, invalid-submission regression tests must assert both the returned validation message and that the save request is never invoked. | forms, validation | Any | unit |

```text
You: Can you add a test for an invalid billing form submission?

Codex: Added invalid submission coverage in billing.test.js.

It verifies:

- The billing validation message is returned.
- The save request is never invoked.

`npm test`: all 6 tests pass.
```

<details>
<summary>Share rules with your team</summary>

Pending rules and rejected decisions stay on the computer that created them. Approval for the team makes a rule available in the shared store. Commit the generated setup files and the shared `.prooflore/records/` directory. Teammates install the project dependencies and open a new agent chat. For a personal rule, choose **Keep only on this computer** in the review form. ProofLore stores the approved version in the Git-ignored `.prooflore/local/` directory.

ProofLore runs locally and stores rule records and short evidence references. It does not upload the store or collect chat transcripts. The connected agent handles translation when displaying rules or saving a localized edit.

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

Import previews a Markdown file with one rule per top-level bullet or numbered item. Add `--local` to keep the imported candidates on this machine. You can also paste existing rules into chat and ask ProofLore to preview an import.

If your client cannot open the review form, use the CLI:

```sh
npx prooflore review RECORD_ID approved --reason "Confirmed in review" --developer YOUR_ID
```

Use `revoked` in place of `approved` to retire a rule. Prior versions and decisions remain in history.

</details>

[MIT License](LICENSE)
