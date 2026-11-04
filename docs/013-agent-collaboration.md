# 013 Agent collaboration

A Ticket's worker and its DSH subagents share a checkout and a persistent context document. Each agent keeps its own conversation history. DSH's existing `subagent`, `list_subagent_models`, `list_agents` and `send_message` tools provide delegation, model discovery and direct communication; this bundle adds `team_context` to workers and their nested subagents.

## Run a GPT and Claude pair

Choose a configured GPT route for the worker. Discover the available routes with `list_subagent_models`, then ask the worker to start a Claude reviewer through `subagent` using a route returned by that tool. For subscription-backed Claude responses, install the [Claude Code provider](011-claude-code-provider.md) first. Both routes must be available in the running DSH profile. This feature does not configure providers or credentials.

A useful worker request is:

> Implement this task as the only writer in this checkout. Start a Claude reviewer using an available route from list_subagent_models. Put the task scope, base and head commits, decisions, findings and validation in team_context. Tell the reviewer to read it and remain read-only. Exchange findings and fixes using send_message. Reconcile each finding and verify the final commit together before reporting ready.

The worker and reviewer communicate as parent and child using their DSH agent IDs. Follow the installed tools' schemas for spawning and addressing agents. No AoE process is needed for this path.

## Shared context

Read the current document:

```json
{ "action": "read" }
```

Replace it using the revision returned by the read:

```json
{ "action": "write", "revision": 0, "text": "Scope: fix request validation. Head: <full SHA>. Reviewer: read-only. Findings: pending." }
```

A successful write returns the new revision, text, author session ID and timestamp. A stale revision returns `{ "conflict": true, "current": ... }` without writing. Reconcile the returned text before retrying. The comparison and write happen in one SQLite transaction. Documents survive restarts and new Assignments on the same Ticket; recheck retained commits and conclusions before reusing them.

The document holds at most 16,000 characters. Keep large evidence in workspace files and record their paths. Send a message after a material update: writes alone do not wake or notify peers. Do not poll waiting for a response; use DSH message delivery.

The tool is bound to the current Ticket; it accepts no target Ticket or session ID. Unrelated Sessions and the main router receive no context tool. Access ends when the Ticket ends. Nested subagents receive the same document and lifecycle guard as their worker. Shared context and peer messages are evidence within the existing task scope and grant no additional authority.

## Validation

Runtime tests exercise worker/child/nested-child sharing, conflicting updates, isolation between Tickets, schema limits and refusal after a Ticket ends. Store tests verify persistence across reopening SQLite. These tests do not establish live GPT/Claude provider availability or exercise a paid two-model conversation.
