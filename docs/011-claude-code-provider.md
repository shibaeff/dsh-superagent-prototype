# Claude Code in `/model`

This fork includes `plugins/claude-code-provider`, an optional DSH LLM provider
named **Claude Code (subscription)**, with route ID `claude-code`. It keeps the
DSH kernel and tools while Claude Code supplies model responses.

Sign in with the official `claude auth login` command first. Then, from this
checkout, install into the existing TUI profile:

```sh
python3 scripts/dsh-claude-code-provider
```

Restart `dsh tui`. Open `/model`, press Tab to select **Claude Code
(subscription)**, choose a model with the arrow keys, and press Enter. The
model catalog and supported effort levels come from the installed Claude Code
CLI, rather than a hardcoded model list. This is separate from `/claude`, which
switches the entire agent backend.

The installer supports `--profile <name>` and `DSH_HOME`. It links this checkout
into the profile, so keep the checkout in place. It preserves the session
deletion patch when installing into a profile using TUI 0.18.0. It does not
change your default model or restart an active session. The profile manifest
from before installation is saved under `.artifacts/claude-code-provider/`.

## Authentication and tools

The provider invokes the official Claude Agent SDK and unmodified Claude Code
binary. Claude Code owns authentication and credential refresh. The provider
does not read subscription tokens, copy credentials, or call Anthropic HTTP
endpoints itself. Inherited API-key, bearer-token and third-party cloud routing
variables are excluded from its child environment so the CLI can use your own
Claude login. `CLAUDE_CODE_EXECUTABLE` can select a different official binary.

DSH's tools are exposed to the SDK as MCP declarations. The MCP handlers are
inert: when Claude requests a tool, the provider ends that SDK step and returns
a normal DSH tool-call block. DSH executes it under its own permission policy.
The next SDK step receives the conversation history, including the tool call
and its result. Claude Code's own built-in tools are disabled, and permission
requests inside the child are denied. DSH remains responsible for workspace
instructions, approvals and tool execution.

## Limits and validation

This initial provider supports text and DSH tool calls/results. Use the native
`/claude` backend for images. Each model step starts a fresh SDK query with the
DSH conversation serialized as JSON; it does not reuse a native Claude thread.
Text appears when each assistant message completes. This can be slower and use
more subscription capacity than the native backend. The CLI's managed policies
and your subscription limits still apply.

Offline tests:

```sh
node --test plugins/claude-code-provider/bridge.test.js
```

Validated locally with DSH 0.2.1-rc.2, TUI 0.18.0, Claude Code 2.1.317 and SDK
0.3.317: catalog discovery, a live subscription reply, a live MCP tool request,
and a full DSH turn that executed `printf CLAUDE_DSH_TOOL_OK` through DSH's bash
tool and continued from the result. The provider was also verified in the TUI's
actual `/model` picker.
