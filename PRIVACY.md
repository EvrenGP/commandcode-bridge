# Privacy

Command Code Bridge runs on your computer inside Claude Code. Its author runs no server and collects nothing: no telemetry, no analytics, no accounts.

## What leaves your computer, and where it goes

- **To Command Code**, through the Command Code CLI you installed and under your own Command Code account: the task you or Claude give the `run` tool and, when its `context` is `recent` or `full`, the recent or full text of the current conversation (capped by the `maxContextChars` setting). Routed turns, `/compact` while routing is on, and `handoff` send or write the conversation the same way. Command Code's own privacy policy applies to that data.
- **To `api.commandcode.ai`**, for the usage display: three read-only requests (`/alpha/billing/credits`, `/alpha/billing/subscriptions`, `/alpha/usage/summary`) carrying the API key the Command Code CLI stored in `~/.commandcode/auth.json`. The key is sent to no other host, and the plugin never stores, logs or prints it.

Nothing is sent when you do not use the `run` tool, routing, `/compact` while routing, `handoff`, or the usage commands.

## What stays on your computer

- Settings, permission choices, run history and a short-lived answer cache, in Claude Code's plugin store.
- Handoff transcripts, written to `~/.commandcode/projects/<project>/<session>.jsonl`.

To remove everything, uninstall the plugin and delete any handoff files you no longer want.

## Contact

Questions or problems: https://github.com/EvrenGP/commandcode-bridge/issues
