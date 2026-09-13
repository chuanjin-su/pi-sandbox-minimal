# pi-sandbox-minimal

[![npm](https://img.shields.io/npm/v/pi-sandbox-minimal)](https://www.npmjs.com/package/pi-sandbox-minimal)
[![license](https://img.shields.io/npm/l/pi-sandbox-minimal)](./LICENSE)

Filesystem sandboxing for [pi](https://pi.dev/) with interactive permission prompts.

Source: [github.com/chuanjin-su/pi-sandbox-minimal](https://github.com/chuanjin-su/pi-sandbox-minimal)

This is a **filesystem-only** sandbox: network access is intentionally unrestricted.
It sandboxes pi like this:

- **bash**: filesystem read/write restrictions enforced at the OS level via
  [`@carderne/sandbox-runtime`](https://www.npmjs.com/package/@carderne/sandbox-runtime)
  (a fork of Anthropic's `@anthropic-ai/sandbox-runtime`) — `sandbox-exec` (macOS) or
  bubblewrap (Linux). Commands entered with `!` are sandboxed too (toggleable in
  settings). Network access from sandboxed commands is left unrestricted by design.
- **read / write / edit / ls / grep / find**: intercepted before execution and checked
  against the same filesystem policy. The OS-level sandbox cannot cover these tools
  because they run inside the Node.js process rather than in a subprocess.

When a blocked action is attempted, you are prompted to allow it temporarily or
permanently rather than it silently failing.

`/sandbox` opens an interactive menu with status, enable/disable, and settings.

Based on the [sandbox example extension](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts)
from pi-mono by Mario Zechner and on [pi-sandbox](https://github.com/carderne/pi-sandbox)
by Chris Arderne (both MIT).

## Requirements

- macOS (`sandbox-exec`) or Linux (bubblewrap, socat)
- [`ripgrep`](https://github.com/BurntSushi/ripgrep) (`rg`) on the PATH pi was launched with
- On Linux: bubblewrap, socat

If initialization fails with `ripgrep (rg) not found`, install it (`brew install ripgrep`
on macOS) and make sure pi's launcher environment includes its directory on `PATH`.

## Install

```bash
pi install npm:pi-sandbox-minimal
```

Then start pi as usual — the sandbox activates on session start when `enabled: true`.

## Development

```bash
git clone https://github.com/chuanjin-su/pi-sandbox-minimal.git
cd pi-sandbox-minimal
npm install
pi -e .
```

Run pi with this directory as an extension (`pi -e .`) to test local changes.

## Usage

```
/sandbox          open the sandbox menu
pi --no-sandbox   disable sandboxing for the session
```

### The /sandbox menu

- **Show status** — whether the sandbox is enabled for this session, whether the OS
  sandbox is active, platform, `!` command sandboxing, prompt timeout, config file
  locations, and all configured filesystem paths (including session-only allowances).
- **Enable / Disable (this session)** — runtime toggle only; never writes config.
  The footer's first line shows `[<lock> N write paths]` next to the cwd/branch
  while the sandbox is active, and `[<lock-open> Sandbox off]` when it is off
  (see the Footer section below).
- **Settings…**
  - *Toggle sandboxing of `!` commands* (`sandboxUserShell`)
  - *Add read path / write path* — uses the same permission prompt
    (session / project / global) as blocked actions
  - *Remove read path / write path* — removes from config files and session allowances
  - *Edit project config* / *Edit global config* — JSON editor with validation
- **Reload config from disk** — re-applies the merged config to the running sandbox.

## Configuration

Config is merged from two files:

- Global: `~/.pi/agent/sandbox.json` (respects `PI_CODING_AGENT_DIR`)
- Project: `<cwd>/.pi/sandbox.json`

Scalar settings: the project file takes precedence. Path arrays from both files are
combined and deduplicated; once an array is configured in either file, only the
combined entries are used (an explicit empty array disables that built-in default).

```json
{
  "enabled": true,
  "sandboxUserShell": true,
  "permissionPromptTimeoutSeconds": 600,
  "filesystem": {
    "allowRead": [".", "~/.config", "~/.local"],
    "denyRead": ["/Users", "/home"],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

### Read vs write precedence

- **Reads** (read/ls/grep/find tools, and bash reads): every read is blocked unless the
  path is in `allowRead` or `allowWrite`. Granting a prompt adds the path to
  `allowRead`, which overrides `denyRead`.
- **Writes** (write/edit tools, and bash writes): `denyWrite` always wins and is never
  prompted. Anything not in `allowWrite` is prompted. Empty `allowWrite` means nothing
  is writable. Write access implies read access.

Relative patterns (e.g. `.env`, `*.pem`) resolve against pi's working directory.

## Permission prompts

A blocked action opens a prompt:

- **Abort (keep blocked)** — default on timeout
- **Allow for this session only** — in-memory, reset when pi restarts
- **Allow for this project** — written to `<cwd>/.pi/sandbox.json`
- **Allow for all projects** — written to `~/.pi/agent/sandbox.json`

Persistent grants require an extra Enter to confirm; rules can be edited before granting
(Tab). `permissionPromptTimeoutSeconds` (default 600) auto-aborts; a timeout never grants.

Session allowances live in memory only and cannot be read or modified by the agent.

## Footer

The extension replaces pi's footer with a replica that merges the sandbox state into
the first line:

```
~/Workspace/project (main) [ 3 write paths]
↑1.2k ↓3.4k R12k $0.123 42.1%/200k          model • high
```

Line 1: cwd (~-formatted), git branch, sandbox segment, session name. The segment
is `[<lock> N write paths]` while enabled (N = effective write paths including
session-only allowances) and `[<lock-open> Sandbox off]` when disabled. The lock
glyphs are Nerd Font glyphs — `nf-fa-lock` (`\uf023`) and `nf-fa-lock_open`
(`\uf2fc`) — and require a Nerd Font terminal.
Line 2: token/context stats, model right-aligned — identical to pi's built-in footer.
Other extensions' status segments stay on their own trailing line. When the sandbox
is disabled for the session, the segment reads `[ Sandbox off]` (no blank status
area is left behind).

Note: the stats line is ported from pi's built-in footer; minor cosmetic drift
(e.g. the experimental-features badge) may appear across pi versions.

## No network sandbox

Bash commands run with unrestricted network access: the extension passes a network
config without `allowedDomains` to the runtime, which then applies no network
restrictions (`(allow network*)` on macOS, no proxy routing on Linux) while keeping
filesystem rules fully enforced. There are no domain prompts anywhere.

## Development

```bash
npm install
npm run check   # tsc --noEmit
npm test        # node:test via tsx
```

## License

MIT
