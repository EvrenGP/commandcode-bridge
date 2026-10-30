# commandcode-bridge

Use your [Command Code](https://commandcode.ai) subscription from inside Claude Code.

Claude stays the lead. Bulk reading, audits and mechanical edits go to cheaper Command Code models such as DeepSeek, Kimi, GLM or Qwen, so Claude's quota is spent on the work where its judgment matters.

- **Subagents:** Claude delegates a task to a Command Code model with the `run` tool, gets a short report back, and can keep a named agent for follow-up questions.
- **Routing:** `/commandcode continue` answers the next turns of the same conversation with Command Code, without spending Claude quota.
- **Handoff:** writes the whole conversation as a native Command Code session you can continue with `commandcode --session <file>`.
- **Usage:** shows your 5-hour, weekly and monthly credits, and warns before a window runs out.

The interface speaks English and Turkish. It follows your system language by default; change it with `/commandcode set lang en` (or `tr`, or `auto`).

## Requirements

- Claude Code with plugin (mod) support.
- The Command Code CLI, signed in:

```bash
npm install -g command-code
```

```bash
commandcode login
```

## Install

From a shell, add the marketplace, then install the plugin from it:

```bash
claude plugin marketplace add EvrenGP/commandcode-bridge
```

```bash
claude plugin install commandcode-bridge@commandcode-bridge
```

Or at the prompt of a Claude Code session:

```
/plugin marketplace add EvrenGP/commandcode-bridge
```

```
/plugin install commandcode-bridge@commandcode-bridge
```

Restart Claude Code (or run `/reload-plugins`) afterwards.

Then check that everything works:

```
/commandcode doctor
```

## Commands

```
/commandcode                              status: routing, agents, permissions, usage, recent runs
/commandcode doctor                       CLI path, login, one real test call, usage
/commandcode usage                        5-hour / weekly / monthly credits and reset times
/commandcode models                       numbered list of all subscription models
/commandcode model <n|id|name>            default model for the run tool (e.g. /commandcode model 6)
/commandcode continue [note]              route this conversation's turns to Command Code
/commandcode route on|off                 routing for every session (off also stops "continue")
/commandcode route model <n|id|name>      model for routed turns
/commandcode route mode read|edit|full    permission tier for routed turns
/commandcode handoff [note]               write the conversation as a Command Code session
/commandcode agents                       bridge agents, Command Code agent profiles, recent runs
/commandcode revoke edit|full             forget an "always allow" for this project
/commandcode clear-cache                  clear cached answers
/commandcode set <key> <value>            change a setting
```

A model can be picked by its list number, its full id, the part after the slash (`kimi-k3`), or its display name. When a name matches several models, the candidates are listed with their numbers.

## Tools Claude can call

- `run`: delegate a task. `model` (default `deepseek/deepseek-v4.1-flash-fast`), `agent` (a named, persistent session for follow-ups), `subagent` (a Command Code agent profile from `.commandcode/agents`), `context` (`none`, `recent`, `full`: how much of the conversation to share), `mode` (`read`, `edit`, `full`). The result ends with the model, time, tokens, session id and credits left.
- `transcript`: read what a Command Code session did.
- `agents`: list or reset bridge agents.
- `models`: the numbered model list.
- `usage`: credits left; Claude checks it before a large delegation.
- `handoff`: write the conversation as a Command Code session.

## Permission tiers

- `read` (default): Command Code's headless defaults, no file writes, no shell.
- `edit`: may edit files, may not run shell commands. Command Code's print mode opens writes and the shell together (`--yolo`), so this tier loads `guard-edit-only.ts`, a Command Code mod that blocks `shell_command`, `monitor_command` and `kill_shell`.
- `full`: every tool.

`edit` and `full` ask you each time; "always allow in this project" is remembered until `/commandcode revoke`. In a headless run nobody can be asked, so those tiers are refused.

## Reliability

- An empty reply or a dropped connection is retried once; an auth error is not.
- An expired key is reported plainly. If `commandcode login` says you are already logged in but calls still fail with 401, run `commandcode logout` and then `commandcode login`.
- A cancelled turn is reported as cancelled, not as an error.

## Settings

`/commandcode set <key> <value>`: `cliPath`, `model`, `cacheTtlMin`, `maxContextChars`, `recentMessages`, `maxTurns`, `handoffThinking`, `warnAtPercent`, `route`, `routeModel`, `routeMode`, `lang` (`auto`, `en`, `tr`).

If the CLI is not found, set `cliPath` to the CLI's `index.mjs` or executable name.

## What it runs, reads and sends

Everything the plugin does outside Claude Code, in full:

- **Runs** the Command Code CLI you installed (`node <npm global>/command-code/dist/index.mjs`, or `cliPath`) as a child process, with the task on standard input. In the `edit` tier it passes this plugin's own `guard-edit-only.ts` to the CLI with `--mod`. To read the end of a transcript over 4 MiB it runs `node -e` with a short script written in `hooks/register.ts` (`readTail`) that only reads that file.
- **Sends to Command Code** (through that CLI, to Command Code's servers, under your Command Code account): the task prompt and, when `context` is `recent` or `full`, the recent or full text of this conversation, capped by `maxContextChars`. Routed turns, `/compact` while routing is on, and `handoff` send or write the conversation the same way. Nothing is sent when you do not call `run`, route, compact while routing, or hand off.
- **Reads** `~/.commandcode/auth.json` for your Command Code user name, login date and API key; Command Code transcripts under `~/.commandcode/projects/`; agent profiles under `.commandcode/agents` and `~/.commandcode/agents`.
- **Fetches** your own usage from `https://api.commandcode.ai/alpha/billing/credits`, `/alpha/billing/subscriptions` and `/alpha/usage/summary`, sending the API key from `auth.json` as a Bearer token: the same requests Command Code's `/usage` makes. This happens for `/commandcode usage`, `/commandcode doctor`, the `/commandcode` overview, the `usage` tool, and once after each `run`. The key goes to no other host.
- **Writes** a handoff transcript under `~/.commandcode/projects/` when you run `handoff`; keeps its settings, permissions, run history and answer cache in Claude Code's plugin store.

It sends no telemetry and contacts no other server.

## Notes

- The model list is copied from commandcode.ai/docs and is updated by hand.
- Usage is read from the same endpoints Command Code's own `/usage` uses (`api.commandcode.ai/alpha/...`) with the CLI's own key. They are not a documented public API and may change.
- Not affiliated with Command Code or Anthropic.

## License

MIT
