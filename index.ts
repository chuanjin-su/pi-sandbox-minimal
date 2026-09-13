/**
 * pi-sandbox-minimal - Filesystem sandboxing for pi with interactive permission prompts.
 *
 * Sandboxes pi like this:
 * - bash: filesystem access (read/write paths) enforced at the OS level via
 *   @carderne/sandbox-runtime (fork of @anthropic-ai/sandbox-runtime),
 *   including for `!` commands. Network access is intentionally unrestricted:
 *   this is a filesystem-only sandbox.
 * - read/write/edit/ls/grep/find: in-process tools checked against the same
 *   filesystem policy (allow/deny lists) before execution, since the OS-level
 *   sandbox cannot cover tools running inside the Node.js process.
 *
 * When a blocked action is attempted, the user is prompted to allow it
 * temporarily or permanently rather than silently failing.
 *
 * `/sandbox` opens an interactive menu: status, enable/disable for the
 * session, settings (toggle sandboxing of `!` commands, add/remove paths,
 * edit config files), and config reload.
 *
 * Based on:
 * - https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts
 *   by Mario Zechner (MIT)
 * - https://github.com/carderne/pi-sandbox by Chris Arderne (MIT)
 */

export { default } from "./src/extension.ts";
