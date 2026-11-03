# Automatic topic names

Before a conversation has any messages, its session row uses the workspace
name, such as `chainsafe`. That is a placeholder, not a generated topic.
After the first message, DSH immediately shows a short fallback from its text.
A background model call then replaces it with a readable task name.

Previously the generated name considered only the first message and never
updated automatically. A greeting, vague opening, or later change of subject
could leave a session with an unhelpful name indefinitely.

This fork installs an adaptive title provider:

- It names the concrete project and task in 4–8 words, using your language.
- A meaningful new message can update the title when the main task changes.
- An adequate title keeps its exact wording. "Continue", "thanks", and
  "push build reinstall" keep the current name without another model call.
- A vague opening does not anchor later names. A later prompt can also recover
  title generation after an earlier failure or cancellation.
- **`/rename My chosen title` pins your name.** DSH's existing title service
  stops automatic updates after a manual rename.

For example, `hello` followed by a Canton metrics question can become
`Canton validator metrics`. Later switching to adding Claude support can
change it to `DSH Claude subscription provider`. Asking to push that work
does not change the name again.

## Install

```sh
python3 scripts/dsh-session-titles
```

Restart `dsh tui` after installation. The installer links this checkout into
the existing profile, so keep it in place. `--profile <name>` and `DSH_HOME`
select another existing profile. The Claude model provider and the TUI
session deletion fix remain installed.

Existing sessions are reconsidered on their next meaningful message; this
does not bulk-rename stored conversations. Manually named sessions remain
pinned. Fork inheritance and generation cancellation continue to use DSH's
title service.

## Implementation and checks

`plugins/session-titles` disables the built-in first-prompt strategy and mounts
one adaptive provider. It uses DSH's official title executor, persistence,
revision checks, cancellation and manual-title ownership. It runs in the
background without delaying the main response. Each request includes the
first meaningful prompt plus up to four recent ones, with Unicode-safe
clipping and an 8 KiB serialized input limit. Long conversations therefore
do not eventually exceed the old first-prompt input limit.

Titles use the selected conversation provider. The Claude Code route uses
its `haiku` model; other routes keep the selected model at its lowest
supported reasoning effort. Calls use your normal provider quota. Generation
errors retain the last title or fallback; later meaningful prompts retry.

Run policy tests with:

```sh
node --test plugins/session-titles/policy.test.js
```

Live validation resumed the same DSH session across a topic change: its title
changed from `Canton Validator Metrics Explained` to
`DSH Claude subscription provider SDK design`. A subsequent `continue` kept
that exact title and made no further auxiliary title request. The composed TUI
profile was checked to contain the adaptive provider with the old strategy
disabled.
