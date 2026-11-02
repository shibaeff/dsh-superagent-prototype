# 009 Codex sign-in

Use this guide to run dsh-superagent on a ChatGPT subscription through OpenAI's Codex sign-in instead of a model API key. It builds on the Settings section of [006 Deployment](006-deployment.md) and on the role models of [007 Architecture](007-architecture.md).

> This path relies on community provider plugins for DeepSeek Harness, none of them from DeepSeek or OpenAI. Check the plugin you install, and check that automated use is allowed under your ChatGPT plan before you point a worker at it.

## How it fits

dsh-superagent never talks to a model provider itself. Each of its Sessions runs under the profile, and the profile's LLM registry resolves the model: the DSH default, unless the Eval settings name an assessor model or the Execution settings name an Executor model. Both take a `provider` and a `model` id, and optionally a reasoning effort (`src/app/role-models.ts`).

A Codex provider plugin registers the provider `openai-codex` in that registry, signs in to a ChatGPT account with OAuth, stores the tokens in the DSH credentials store under `DSH_HOME`, and refreshes them. After that, `openai-codex` is a provider like any other: it appears in the Provider list of the Eval and Execution cards, in `GET models`, and in the model selector of the profile.

## Install the provider

From the checkout, with the profile created as in the Install section of [006 Deployment](006-deployment.md):

```sh
scripts/dsh-superagent codex-install
scripts/dsh-superagent restart   # only if the service was running
```

`codex-install` runs `dsh plugin --profile superagent add @jcy2387/dsh-codex-provider@0.2.1-rc.2`, the npm build of [DamonBao/dsh-codex-suite](https://github.com/DamonBao/dsh-codex-suite). It requires DSH `>=0.2.0-rc.2 <0.3.0-0`, which matches the DSH version this bundle pins. Pass `--codex-package <name@version>` or set `DSH_SUPERAGENT_CODEX_PACKAGE` to add another plugin instead; see Alternatives below. Install one Codex provider per profile: two plugins that register `openai-codex` conflict at load.

What was checked on 2026-11-02, with DSH 0.2.1-rc.3 and the plugin above in a fresh `superagent` profile: the plugin installs next to this bundle, the profile starts, the panel answers, and `GET models` lists `openai-codex` with its models and reasoning efforts before any sign-in. No model call was made.

## Sign in

Signing in is an operator step: it needs a browser or a device code, and dsh-superagent must never see the account's password or tokens.

1. Open the panel URL from the log and choose **Plugins** in the sidebar.
2. Open the Codex provider card and click **Connect**.
3. Choose **Browser login** on the machine you sit at. It opens ChatGPT in the browser and returns through a loopback callback on port `1455`. Choose **Device login** on a headless or remote machine: it shows a code to enter at the address it prints.

The tokens live in the profile's credentials store (reference `OPENAI_CODEX_OAUTH` by default), not in this repository and not in `stateDir`. Back up `DSH_HOME` if you back up the sign-in.

## Choose the models

With the service running and signed in:

```sh
scripts/dsh-superagent codex-models
scripts/dsh-superagent codex-use --model <id> --effort <effort>
```

`codex-models` prints the DSH default and every `openai-codex` model with its reasoning efforts, from the running service's catalog. `codex-use` saves that model as both the Executor model and the assessor model through the Management API, each block against its current revision; `--roles executor` or `--roles eval` sets one of them, and `--effort` is optional. The same fields are on the Execution and Eval cards of the panel. A model applies to Sessions created afterwards; an existing Session keeps the model it was created with.

Alternatively, make it the profile default in the profile's model selector, so that everything in the profile, including subagents that a worker spawns under the `standard` preset, uses it, and leave both role models on *Inherit the DSH default*.

Pick a stronger model and effort for the Executor than for the assessor: the assessor reads candidates and routes, many times an hour; the Executor writes code.

## Alternatives

Other community plugins register the same provider and work with the same `codex-use` command. Each was found on 2026-11-02; check its DSH range against `engines.dsh` in `package.json` before installing it, since several target DSH 0.1.

- [unsocialz2/dsh-openai-oauth](https://github.com/unsocialz2/dsh-openai-oauth): talks to the local Codex app-server, so the sign-in and token refresh stay in the official Codex CLI. Its installer runs through `npx`, not `dsh plugin add`, so install it by its own instructions rather than with `codex-install`.
- [suntianc/dsh-codex-auth](https://github.com/suntianc/dsh-codex-auth) and [zlclovetb/deepseek-harness-codex-auth](https://github.com/zlclovetb/deepseek-harness-codex-auth): reuse an existing Codex CLI login instead of signing in themselves.
- [gooosie/dsh-openai-codex-auth](https://github.com/gooosie/dsh-openai-codex-auth), [Yan-Zero/dsh-codex](https://github.com/Yan-Zero/dsh-codex), [Hu9956/dsh-codex-provider](https://github.com/Hu9956/dsh-codex-provider), [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect): device-code or browser sign-in of their own.
- [askdkc/dsh-auth-fork](https://github.com/askdkc/dsh-auth-fork): also covers Claude Pro/Max and SuperGrok subscriptions.

## What to expect

- **Quota.** Workers run in parallel, up to `maxWorkers`, and the assessor runs on every batch of candidates. A subscription's usage limits are shared by all of them and by your own use of the same account. Start with `maxWorkers` of 1 and `observe` mode, and raise them once you see the usage.
- **Rate limits.** A 429 from the provider counts as a passing failure: the launch or turn is tried again three times with a growing backoff, as [003 Execution](003-execution.md) describes, and the `models` health entry shows Sessions waiting on a retry.
- **Two consumers of one login.** A plugin that imports the Codex CLI's own login shares its refresh token with the CLI; refreshing in one place can sign the other out. Prefer a plugin with its own sign-in, as the default one has, when you also use the Codex CLI.
- **Region and account access.** The plugin reports a sign-in that ChatGPT refuses for the account's region or plan on its card; dsh-superagent only sees that the model is unavailable.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `codex-models` says the catalog has no `openai-codex` provider | The plugin is not in the profile, or the service was not restarted after `codex-install`. Run `dsh plugin --profile superagent list`, then `scripts/dsh-superagent restart`. |
| `codex-use` is refused with `The executor model is not available: …` | Not signed in, or the model id is wrong. Sign in on the Plugins card, then read the ids from `codex-models`. |
| `codex-use` is refused with 409 | Settings changed between the read and the save. Run it again. |
| Browser login never returns | Port `1455` is taken, or `localhost` resolves to IPv6 only. Free the port, or use Device login. |
| Two Codex plugins in one profile, and the profile fails to load | Remove one with `dsh plugin --profile superagent remove <name>`. |
| `dsh: host preparation failed: node-addon-require-builtin unsupported` at start | The Node binary is not an official build (seen with a nix-built Node on macOS arm64). Run `dsh` with a Node from nodejs.org, Homebrew, or an `npm install node@22` download. |
| Tickets fail with a 429 in their reason | The subscription's usage limit. Lower `maxWorkers`, or wait for the reset the Plugins card shows. |
