# Changelog

## 0.2.0

- Add opt-in `allowSystemTemp` read/write access for dynamically discovered system
  temporary directories, including the native per-user macOS temp directory.
- Show resolved system-temp allowances in sandbox status. Preserve `denyWrite`
  precedence and skip unsafe or unavailable temp paths with a warning.
- Remove `allowBrowserProcess` support. Existing entries are ignored; use a
  separately configured `agent-browser` MCP server for browser automation.
- Add regression coverage for temp discovery, configuration, policy, and status.
