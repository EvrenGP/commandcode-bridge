# Changelog

## 0.7.1

- **Folders outside the project:** headless Command Code denies any file tool call on a path outside the folder it starts in and ends the run on the spot (`stopReason: permission_denied`); the bridge then returned the agent's opening line ("I'll start by…") as if it were the answer. `--add-dir` does not help: on v1.88.2 it opens the shell, not `glob` or `read_file`. Now a task whose prompt names only folders outside the project runs in that folder (or the deepest folder holding them all), with that folder's file map and its own shared session. `run` takes `cwd` (run in a given folder) and `dirs` (extra folders, passed as `--add-dir` for the shell).
- **Denied tools:** the bridge reads Command Code's `tool_denied` events. A run stopped by a denied path continues its same session once, started inside the denied folder (a session resumes from any folder and keeps what it read); if it still stops, the call fails with what was denied and how to fix it, never with the opening line as an answer, and is not retried blindly. Any other early stop is marked as possibly incomplete and is not cached.
- **Tests:** `hooks/run.test.ts` replays Command Code's recorded output for these cases (`claude plugin test`).
- **Prompt budget:** a long prompt used to be cut from the front, which dropped the rules ("do not modify any file") and the file map. The prompt is now built section by section under `maxPromptChars` (40,000): the rules and the task stay whole, the conversation loses its oldest part first, then the map its tail.
- **Smaller results:** answers handed back to Claude are cut at `maxResultChars` (20,000) with a pointer to the transcript, instead of 60,000.
- **Cheaper default:** `context` now defaults to `"none"` (the setting `defaultContext`); pass `"recent"` or `"full"` when the conversation matters.
- The file map and the shared read-only session follow the folder a task is about, so a task on another folder no longer gets this project's map.
- New settings: `defaultContext`, `maxResultChars`, `maxPromptChars`.

## 0.6.0

- **Project map:** each run gets a map of the project's folders and files with their sizes, built by the plugin from directory listings (no model, about 50 ms, cached for `mapTtlMin` minutes). The agent reads only the files it needs instead of listing folders first. It honours `.gitignore`, skips build and temp folders, and puts code folders first; folders past the `mapChars` budget are named with their file count.
- **Shared read-only session:** read-only one-off runs in a project continue one Command Code session (`project-scout`), so files it already read are not read again. It starts over after `sessionTokenCap` tokens, `sessionIdleMin` quiet minutes, or a model change. Turn it off with `/commandcode set reuseSession false`.
- **Turn limit (0.5.3):** a run that hits `maxTurns` no longer returns the agent's early "I'll explore…" line as its answer. The bridge reads Command Code's stop reason, resumes the same session once to ask for the answer from what was already found, and marks it as possibly incomplete if the limit hits again. The prompt tells the agent its turn budget, and a cut answer is never cached.
- New settings: `projectMap`, `mapTtlMin`, `mapChars`, `reuseSession`, `sessionTokenCap`, `sessionIdleMin`.

## 0.5.2

- Directory listing metadata, privacy policy, icon; English and Turkish interface; usage and credit limits; numbered model list.
