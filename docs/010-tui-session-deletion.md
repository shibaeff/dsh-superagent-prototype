# TUI session deletion

The separate community package `@deepseek-harness-tui/dsh-tui` 0.18.0 already
implements deletion of stored DSH sessions. Its unified session manager gates
the Ctrl+D binding to non-DSH backends, however, so pressing it on a DeepSeek
session does nothing. This is independent of the terminal or operating system.

This fork includes a compatibility installer for that version:

```sh
python3 scripts/dsh-tui-session-delete
```

Restart the TUI, open `/resume`, press the right arrow to focus the session list,
select a stored session, press **Ctrl+D**, then **Enter** to confirm. **Esc**
cancels. The normal DSH footer now shows the shortcut. Deletion uses the TUI's
existing channel operation, which removes the transcript directory, updates
the listing cache, and clears its recent-session and resume markers.

The current session, sessions loaded in the same TUI, and sessions held by
another TUI are refused. To delete a loaded session, switch to another session,
open `/resume`, select the target, and press **Ctrl+X** to stop it before
**Ctrl+D**. Stop any other DSH application using that session before deleting;
the TUI's occupancy ledger does not cover every external session writer.

The default package location is
`$DSH_HOME/profiles/tui/node_modules/@deepseek-harness-tui/dsh-tui`, with
`DSH_HOME` defaulting to `~/.dsh`. Use `--package-dir /path/to/dsh-tui` for a
different installation. This changes the installed TUI, rather than adding a
terminal interface to the Superagent web plugin. It does not restart processes
or delete any session during installation.

Original files are backed up inside the package. Restore them with:

```sh
python3 scripts/dsh-tui-session-delete --restore
```

The installer checks the package version and every expected source fragment
before making changes. It can resume an interrupted installation and refuses
to overwrite subsequent modifications. Updating or reinstalling the TUI may
replace the patch; other versions require reviewing the integration again.

Run installer regression tests with `python3 tests/tui-session-delete.py`.
After installation, exercise the actual patched keyboard, confirmation and
deletion handlers without deleting sessions:

```sh
node tests/tui-session-delete-runtime.mjs "$HOME/.dsh/profiles/tui/node_modules/@deepseek-harness-tui/dsh-tui"
```
