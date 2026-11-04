# Vibe CLI in `/model`

`plugins/vibe-provider` adds **Vibe CLI (YOLO)** as a DSH model provider, with
route ID `vibe-cli`. It invokes your installed `vibe` CLI and uses its existing
authentication and configured model. DSH continues to own the agent loop,
conversation history, tool execution and approvals.

```sh
python3 scripts/dsh-vibe-provider
```

Restart `dsh tui`, open `/model`, select **Vibe CLI (YOLO)** with Tab, then
choose **Vibe configured model** and press Enter. That entry follows Vibe's
configured active model rather than hardcoding a Mistral model name. Set
`DSH_VIBE_MODELS` to a comma-separated list of existing Vibe model aliases
before starting DSH to expose additional choices. `VIBE_EXECUTABLE` selects
another installed Vibe executable.

The installer supports `--profile <name>` and `DSH_HOME`, backs up the profile
manifest under `.artifacts/vibe-provider/`, and preserves the other bundles.
It links this checkout, which must stay in place. It also reapplies the TUI
0.18.0 session deletion fix after dependency installation.

## How tool handoff works

Each model step invokes `vibe --yolo` in headless streaming mode, using an
owner-only temporary Unix socket. All of Vibe's native tools are disabled.
The input preserves message-source metadata and identifies the actual latest
user request separately from DSH's runtime-context snapshots. Conversation
history may contain replies from other providers; it must not establish the
current provider's identity.

Vibe receives the current DSH tool schemas and a response contract: return a
JSON tool-call list, or a final answer explicitly marked complete, blocked or
needing input. The bridge converts declared tool requests into real DSH tool
calls; DSH validates their argument schemas before execution. Undeclared names
and malformed calls are rejected. A short promise such as "Reading the summary
now" is rejected instead of being treated as a completed response.

Direct client tools through Vibe's agent-socket protocol v2 remain supported.
Prefixed aliases avoid native-name conflicts. A direct call is recorded and
stopped with the protocol's explicit abort response before execution; only an
acknowledged handoff is accepted. Vibe can still choose a disabled native tool,
so a native-tool turn-limit or an invalid response gets one correction attempt
requiring the JSON contract. A second failure reports an error rather than
claiming work was performed. Usage across correction attempts is retained.

DSH executes requested tools under its own
permission mode, and the next Vibe step receives the result and conversation
history. Consequently `--yolo` in the child does not change DSH's own approval
settings. Use DSH's Full access preset when that is your intended policy.

The bridge handles process failures, token limits and cancellation. It
terminates the child process group on cancellation, escalates if necessary,
waits for process closure, and removes temporary socket, prompt and export
files. Usage is read from Vibe's export and cached input is separated from
uncached tokens for DSH's accounting. `maxTokens` is passed through Vibe's
`VIBE_AGENT_MAX_OUTPUT_TOKENS` setting rather than its cumulative-token CLI
budget, which also counts the prompt.
Only the child Vibe process group created for the current model step is
signaled. Installation and cleanup do not stop or restart any DSH instance.
Already-running DSH processes retain their loaded adapter until the user
chooses to restart them.

## Compatibility and limits

Validated against Vibe 3.0.4, DSH 0.2.1-rc.2 and TUI 0.18.0 on macOS.
The agent-socket interface is experimental, so future Vibe releases may need
adapter changes. This provider supports Unix sockets (macOS/Linux), text,
reasoning, and DSH tool calls/results. Image/file attachments are not supported.
Thinking and temperature follow Vibe configuration; this initial provider does
not expose DSH overrides for them or for stop sequences.

Each request starts a new Vibe process and supplies the DSH conversation as
JSON. It does not resume a native Vibe thread. Output appears after the model
step completes. Authentication, project context, managed policies and quotas
remain Vibe's responsibility. Normal Vibe session journals may still be stored
by the CLI according to its own configuration.

Offline subprocess/socket tests:

```sh
node --test plugins/vibe-provider/bridge.test.js
```

Live validation covered a standalone Vibe reply and tool request, then a full
DSH turn that requested `bash`, executed `printf VIBE_DSH_TOOL_OK` through
DSH, and continued from its result. The installed provider was also verified
in the TUI's `/model` picker.

The 0.1.1 regression check required DSH to read a disposable `summary.md`
containing a random code absent from the prompt. The recorded DSH `read` call
and matching result contained that code, and Vibe's final answer reported it.
Subprocess tests also cover recovery from native-tool turn limits, rejected
progress-only replies, and preserving runtime-context metadata.
The live follow-up regression also included a prior "Reading the summary now"
reply followed by "so"; it returned an actual `read` tool request.
