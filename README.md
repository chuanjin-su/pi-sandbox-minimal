# pi-sandbox-minimal

[![npm](https://img.shields.io/npm/v/pi-sandbox-minimal)](https://www.npmjs.com/package/pi-sandbox-minimal)
[![license](https://img.shields.io/npm/l/pi-sandbox-minimal)](https://opensource.org/license/mit)

Filesystem sandboxing for [pi](https://pi.dev/) with interactive permission prompts.

- Restricts `bash` commands using macOS `sandbox-exec` or Linux bubblewrap.
- Checks `read`, `write`, `edit`, `ls`, `grep`, and `find` against the same user-data
  access rules.
- Supports session-only, project, and global permission grants.
- Provides a `/sandbox` menu for status, settings, and permission management.

By default, user-data reads and writes are allowed only within pi's working
directory and its descendants. Bash also has the OS runtime access described
below. Network access is unrestricted. MCP servers and other external processes
are not covered by this extension.

[Source code](https://github.com/chuanjin-su/pi-sandbox-minimal) ·
[Report an issue](https://github.com/chuanjin-su/pi-sandbox-minimal/issues)

## Requirements

- [pi](https://pi.dev/).
- macOS with `sandbox-exec`, or Linux with bubblewrap and usable user namespaces.
- [`ripgrep`](https://github.com/BurntSushi/ripgrep) (`rg`) on pi's launcher `PATH`.
- On Linux, `socat`.

Install dependencies on macOS:

```bash
brew install ripgrep
```

On Debian or Ubuntu:

```bash
sudo apt-get install bubblewrap ripgrep socat
```

## Installation

```bash
pi install npm:pi-sandbox-minimal
```

Start a new pi session. The sandbox activates automatically unless disabled in
configuration or with `--no-sandbox`.

## Usage

Open the menu inside pi:

```text
/sandbox
```

To start pi without sandboxing for that session:

```bash
pi --no-sandbox
```

The `/sandbox` menu includes:

| Action | Description |
| --- | --- |
| Show status | Open a scrollable panel with sandbox state, configuration locations, permissions, and bash runtime access. |
| Enable / Disable (this session) | Toggle protection without changing configuration files. |
| Settings… | Add or remove read/write paths, edit configuration, and toggle sandboxing of `!` commands. |
| Reload config from disk | Apply configuration changes to the running session. |

In the status panel, use **↑/↓**, **Page Up / Page Down**, or **Home / End** to
scroll. Press **Enter** or **Escape** to return to the menu. Selection shortcuts
follow your pi keybindings. Status is shown in a temporary panel, not added to the
session transcript.

Commands entered with `!` or `!!` are also sandboxed unless `sandboxUserShell` is
`false`.

### Permission prompts

Access outside the allowlists opens a permission prompt for file tools and
recognized bash denial messages. Explicit `denyWrite` matches remain blocked
without a prompt. The available choices are:

- **Abort (keep blocked)**.
- **Allow for this session only** — resets when pi restarts.
- **Allow for this project** — saves the rule in the project configuration.
- **Allow for all projects** — saves the rule in the global configuration.

Press **Tab** to edit the proposed rule. Persistent grants require an additional
**Enter** to confirm. Prompts time out after 600 seconds by default; a timeout
keeps access blocked.

Some programs report only a generic error. To grant access manually, use
**Settings… → Add read path / Add write path**. `!` and `!!` commands do not use
the bash tool's automatic denial prompts and retries.

**Retry caution:** granting access may retry the entire bash command, repeating
any earlier side effects.

### Footer

The footer shows the sandbox state beside the working directory and git branch:

- Enabled: a lock icon and the number of effective write paths, including
  session-only and system-temp allowances.
- Disabled: an unlocked icon and `Sandbox off`.

Lock icons require a Nerd Font. Token/context statistics and other extensions'
status information remain visible.

## Configuration

Configuration is read from:

- **Global:** `~/.pi/agent/sandbox.json`. Set `PI_CODING_AGENT_DIR` to use a different
  agent directory.
- **Project:** `<cwd>/.pi/sandbox.json`.

After editing a file, use **/sandbox → Reload config from disk**. Editing a config
file alone does not change the active session's policy. Permission prompts apply
grants immediately.

### Defaults

```json
{
  "enabled": true,
  "sandboxUserShell": true,
  "allowSystemTemp": false,
  "permissionPromptTimeoutSeconds": 600,
  "filesystem": {
    "allowRead": ["."],
    "denyRead": [],
    "allowWrite": ["."],
    "denyWrite": []
  }
}
```

`.` refers to pi's working directory, including its descendants. Both denylists
are empty by default. Files such as `.env` and private keys are writable within
allowed write directories unless protected with `denyWrite`.

| Setting | Description |
| --- | --- |
| `enabled` | Enable sandboxing at session startup. |
| `sandboxUserShell` | Apply sandboxing to `!` and `!!` commands. |
| `allowSystemTemp` | Grant read/write access to discovered system temporary directories. |
| `permissionPromptTimeoutSeconds` | Time before a permission prompt automatically aborts. |
| `filesystem.allowRead` | User-data paths that may be read. |
| `filesystem.allowWrite` | User-data paths that may be written; also grants read access. |
| `filesystem.denyRead` | Read-denial entries; explicit read/write allowances override them. |
| `filesystem.denyWrite` | Write-denial entries; override write allowances and cannot be bypassed by a permission prompt. |

### Merging configuration

- For scalar settings, project configuration takes precedence over global
  configuration.
- Path arrays from both files are combined and deduplicated.
- Once an array is configured in either file, it replaces that array's built-in
  default. Include `"."` explicitly to retain working-directory access.
- An explicit empty array removes the default entries for that array. Write
  access still implies read access, and `allowSystemTemp` grants remain separate.

For example, to retain project access and add two directories:

```json
{
  "filesystem": {
    "allowRead": [".", "~/Documents/reference"],
    "allowWrite": [".", "~/Documents/output"]
  }
}
```

On Linux, create the output directory before granting write access.

### Path rules

- Relative paths resolve against pi's working directory; `~` expands to the home
  directory.
- Directory rules include their descendants. Symlink targets are checked using
  resolved paths.
- Reads outside `allowRead` and `allowWrite` are blocked. `denyRead` does not
  exclude paths already covered by those allowances.
- `denyWrite` takes precedence over `allowWrite`.
- With an empty `allowWrite`, user-data writes require a permission grant, unless
  another option such as `allowSystemTemp` grants access.

**macOS:** `*` matches any sequence of characters, including directory separators.
For example, `*.pem` matches `.pem` files below the working directory.

**Linux:** use existing literal paths. Wildcard rules, nonexistent write roots,
nonexistent `denyWrite` targets, and host-root or kernel-filesystem binds are
unsupported. Grant an existing containing directory to allow creating new files.
Unsupported policies block bash execution.

### Bash runtime access

In addition to the configured user-data rules, bash has access to:

- Read-only OS executable and library directories, including `/bin`, `/usr/bin`,
  `/usr/lib`, and platform-specific library locations.
- OS locale/timezone data and specific resolver, host, and certificate files.
- Process I/O devices, including `/dev/null`, stdout/stderr, terminal devices,
  and file descriptors.
- On Linux, an isolated `/proc` and minimal `/dev`, without host `/proc` or `/sys`.
- On macOS, directory/symlink traversal metadata and root-directory entry names.

Use **Show status** to view runtime access separately from your configured paths.
Home directories, `/usr/local`, Homebrew installations, and other `PATH` entries
are not automatically granted. Add an explicit read rule for user-installed tools
and their required libraries or data.

Temporary files must be written within an allowed directory. For a project-local
temporary directory:

```bash
mkdir -p ./tmp
TMPDIR="$PWD/tmp" your-command
```

If initialization or a policy update fails, bash stays blocked until the problem
is resolved or sandboxing is explicitly disabled.

### System temporary directories

To allow system-temp access for bash and file tools:

```json
{
  "allowSystemTemp": true
}
```

This grants read/write access to:

- Pi's process temporary directory, normally influenced by `TMPDIR`.
- `/tmp` on macOS and Linux.
- On macOS, the current user's native temporary directory, even when `TMPDIR`
  points elsewhere.

Resolved paths appear in **Show status**. Only the discovered directories are
granted, not all of `/private/var/folders` or adjacent macOS cache directories.
Unavailable or unsafe paths are skipped with a warning. `denyWrite` still applies.

To revoke these grants, set `allowSystemTemp` to `false` and reload configuration.
Clearing `filesystem.allowWrite` alone does not revoke system-temp access or other
explicit grants.

**Security:** this option permits reading, modifying, and deleting files belonging
to other applications within the granted directories, subject to OS permissions.
Check `TMPDIR` before enabling it: if it points to your home directory, that entire
directory is granted. No additional `~/Library` or browser IPC permissions are
included.

## Troubleshooting

| Problem | Action |
| --- | --- |
| `ripgrep (rg) not found` | Install ripgrep and ensure its directory is on the `PATH` used to launch pi. |
| A Homebrew or user-installed command cannot run | Add a read grant for its installation directory and required dependencies. |
| A command cannot create temporary files | Set `TMPDIR` to a writable project directory, or enable `allowSystemTemp`. |
| Configuration edits have no effect | Select **Reload config from disk** in `/sandbox`. |
| Linux policy validation fails | Replace wildcard rules with existing literal paths and check write/deny targets exist. |
| Sandbox creation fails | Check OS sandbox availability; on Linux, check bubblewrap and user-namespace permissions. |
| A blocked command does not prompt | Add the required path through **Settings…**. |

## Development

```bash
git clone https://github.com/chuanjin-su/pi-sandbox-minimal.git
cd pi-sandbox-minimal
npm install
pi -e .
```

Use `/reload` in pi after changing extension code.

### Checks and tests

```bash
npm run check   # TypeScript checks
npm test        # Unit tests and available native sandbox tests
npm run all     # TypeScript checks and tests
```

Require native sandbox tests to run:

```bash
PI_SANDBOX_REQUIRE_NATIVE_TESTS=1 npm run all
```

Without that environment variable, native tests are skipped when the host cannot
create a sandbox. With it, unavailable native sandboxing fails the test run. Run
native tests on both macOS and Linux when changing enforcement code. CI requires
native tests on both platforms.

## Acknowledgments

Based on work from [pi-mono](https://github.com/badlogic/pi-mono) by Mario Zechner
and [pi-sandbox](https://github.com/carderne/pi-sandbox) by Chris Arderne. Uses
[`@carderne/sandbox-runtime`](https://www.npmjs.com/package/@carderne/sandbox-runtime).

## License

MIT
