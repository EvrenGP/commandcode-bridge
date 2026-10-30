import type { ModApi } from '@commandcode/harness'

/*
 * The bridge's edit tier: Command Code's print mode opens file writes and the
 * shell only together (--yolo), so this mod closes the shell again. The run
 * may read, search, and edit files; it may not run, watch or kill commands.
 */

const SHELL = new Set(['shell_command', 'monitor_command', 'kill_shell'])

export default function (cmd: ModApi): void {
  cmd.hooks({
    beforeToolCall: ({ toolName }) =>
      SHELL.has(toolName)
        ? {
            block: true,
            additionalContext:
              'Blocked by commandcode-bridge: this run is in the edit tier and may change files, not run shell commands. Report what you could not do instead.',
          }
        : undefined,
  })
}
