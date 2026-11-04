# Codex skills in DSH

This fork includes `plugins/codex-skills`, which automatically adds
`~/.codex/skills` to DSH's skill catalog. If `CODEX_HOME` is set when DSH starts,
it scans `$CODEX_HOME/skills` instead. No copying or symlinking is needed.

Install into the existing TUI profile:

```sh
python3 scripts/dsh-codex-skills
```

Restart DSH once to load the plugin, then open `/skills`. Skills such as
`aoe-review` are advertised to the agent by name and description. Their full
instructions load on demand when the agent selects them. This does not start
a review or run every skill at startup.

The plugin mounts an additional host-level filesystem provider inherited by
DSH's agent presets. It preserves the normal project, DSH and shared agent
skill sources, including the TUI's preset-local scanner. The existing scoped
registry resolves duplicate names, with preset-local skills taking priority
over this additional host source.

It uses DSH's own skill parser and filesystem watcher. Directory bundles,
flat Markdown skills, symlinks and invocation restrictions keep their normal
DSH behavior. External additions and edits refresh the next catalog without
another restart. Malformed skills are logged and skipped. Skills in nested
directories such as `.system` are not recursively imported.

The installer supports `--profile <name>` and `DSH_HOME`. It links this
checkout into the profile, preserves its other bundles, and reapplies this
fork's session deletion fix when TUI 0.18.0 is installed. Keep the checkout
in place. Before changing the profile, its package manifest is saved under
`.artifacts/codex-skills/<profile>/`.

Run parser, loading, invocation-policy and watcher checks with:

```sh
node --test plugins/codex-skills/discovery.test.js
```

Verified against the installed TUI: `/skills` lists `/aoe-review` from the
Codex directory. Discovery found 17 user skills on this installation, and
loading `aoe-review` returned its original instruction file with both model
and user invocation enabled.
