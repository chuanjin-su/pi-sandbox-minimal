# Changelog

## Unreleased

- Prompt for `touch` write denials and relative shell redirections. Preserve bash
  diagnostic lines when reporting errors so permission grants and retries work.

- Default filesystem allowlists to only the working directory (`.`), with empty
  read/write denylists. Remove implicit temp, home-config, and Library grants and
  sensitive-file write exclusions. Existing explicit configuration is unchanged.
- Replace bash filesystem wrapping with strict macOS Seatbelt and empty-root
  Linux bubblewrap policies using the same user-data allowlists as file tools.
  Make OS runtime/device exceptions explicit in status. Remove runtime-injected
  writable temp/log paths and sensitive-file denials.
- Launch the sandbox directly, fail closed on initialization/update errors, and
  prompt for recognized bash read denials as well as write denials. Snapshot
  active policy so agent edits to project config cannot self-grant access in the
  running session.
- Add policy/launch regression tests and native enforcement tests; CI requires
  native sandbox availability on macOS and Linux.

## 0.2.0

- Add opt-in `allowSystemTemp` read/write access for dynamically discovered system
  temporary directories, including the native per-user macOS temp directory.
- Show resolved system-temp allowances in sandbox status. Preserve `denyWrite`
  precedence and skip unsafe or unavailable temp paths with a warning.
- Remove `allowBrowserProcess` support. Existing entries are ignored; use a
  separately configured `agent-browser` MCP server for browser automation.
- Add regression coverage for temp discovery, configuration, policy, and status.
