# dshrc guide

Everything you need to install, run, and operate dshrc.
For design internals see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Requirements

- **Node.js 20+**
- **[`deepseek-acp`](https://www.npmjs.com/package/deepseek-acp)** on your `PATH` (`npm install -g deepseek-acp`) — an unofficial, editor-facing ACP server over [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It wraps `dsh`; you do not install `dsh` itself separately.
- A DeepSeek API key, either via `deepseek-acp --setup` (stored once in `$DSH_HOME/.credentials.yaml`) or `export DEEPSEEK_API_KEY=sk-...`
- A phone browser that can open a URL on your network (or via Tailscale / relay)

| Platform | Status         | Service helper         |
| -------- | -------------- | ----------------------- |
| Linux    | Supported (CI) | systemd user unit       |
| macOS    | Supported (CI) | —                       |
| Windows  | Supported (CI) | Scheduled Task scripts  |

---

## Install

```bash
# deepseek-acp — the ACP adapter dshrc drives
npm install -g deepseek-acp
deepseek-acp --setup        # paste a DeepSeek API key once (or export DEEPSEEK_API_KEY)

# dshrc
npm install -g dshrc
```

Without global write access:

```bash
npm config set prefix ~/.local
npm install -g deepseek-acp dshrc
export PATH="$HOME/.local/bin:$PATH"
```

From source:

```bash
git clone https://github.com/sandeep-alluru/deepseek-harness-rc.git
cd deepseek-harness-rc && npm install && npm run build && npm link
```

---

## Required configuration

### The one required setting: default project directory

Sessions started from the phone open in `defaultCwd`. There is **no default** — set it explicitly:

```bash
dshrc config set defaultCwd /path/to/your/projects
dshrc config                    # show settings
```

Under systemd, the process cwd is often `$HOME`, which is not a project. Set `defaultCwd` before relying on new sessions.

### Approvals need no configuration

**`deepseek-acp` has no setting that could disable approvals.** Its sandbox (default
`workspace-write`) always sends `session/request_permission` for anything outside the
session's working directory or the system temp dir — there is no config key, CLI flag,
or environment variable that turns it off. `dshrc`'s own `permissionMode` field exists
for config-file compatibility but has no effect against this backend; `dshrc doctor`
reflects this too — it always reports that the agent will prompt. See
[SECURITY.md](../SECURITY.md#approvals-cannot-be-silently-disabled) for the full reasoning.

In short: pair a device, and one-tap approval already works. There is nothing else to set.

---

## Start the daemon

```bash
dshrc up --lan          # bind all interfaces (LAN)
# or
dshrc up                # loopback only
```

You get a URL and a 6-character pairing code. On your phone:

1. Open the URL
2. Enter the code
3. **Add to Home Screen** (required for iOS push)

```bash
dshrc pair              # new code (daemon must be running)
dshrc devices           # paired devices
dshrc revoke <id>       # remove a device
dshrc revoke --all
```

---

## Daily use

### Sessions

| Mode          | How it appears                              | Control                                   |
| ------------- | -------------------------------------------- | ------------------------------------------ |
| **Owned**     | Started from the phone                      | Full                                       |
| **Observed**  | Hand-started `dsh` session on the machine   | On the roadmap — see below |
| **Shared**    | Via a leader process / `dshrc term`         | `dshrc term` — the terminal drives the same session (one process per session on this backend) |

- **New session** — from the session list
- **Resume** — open a session `dshrc` itself created (including after a daemon restart); the composer returns when live. `deepseek-acp` advertises ACP's `loadSession` capability, and the on-disk existence check is verified against dsh's real session-directory naming (`$DSH_HOME/sessions/--encoded-cwd--/<id>/`)
- **Titles** — sessions created from the phone use the title you gave them, or the project directory name
- **Approvals** — tool requests always show as buttons; answer by option (see [Required configuration](#approvals-need-no-configuration) above)
- **Stop** — cancel the current turn
- **Take over / Hand back** — *Take over* reclaims a session another process has open. On this backend it resumes the session directly: the registry-checked version — verify the owning process first, with a "refuse to join a standalone owner" guard — is on the roadmap, and dsh keeps no live-process registry to check against. *Hand back* releases the session and returns resume commands; run `dshrc term --session <id>` to continue in a terminal — the released session's copy-paste commands suggest exactly that on every platform.

**Observed mode is next on the roadmap.** It mirrors a session by tailing its on-disk log file. `dsh` writes one compressed `session.jsonl.zstd` per session (event-sourced JSONL under zstd — verified against real files), and the zstd reader is the piece in development; the same reader powers session discovery (listing sessions dshrc did not itself create). The schema both features build on is documented in code comments in `src/daemon/session-manager.ts` and `src/daemon/observer.ts`.

### Terminal client

Same backend as the phone:

```bash
dshrc term
dshrc term --session <id>
```

### Commands

| Command                                          | Purpose                                       |
| ------------------------------------------------- | ---------------------------------------------- |
| `dshrc up [flags]`                               | Start daemon                                   |
| `dshrc doctor`                                   | Health check (agent, ACP, push, live daemon)   |
| `dshrc config` / `config set` / `config unset`   | Settings                                       |
| `dshrc pair` / `devices` / `revoke`              | Device auth                                    |
| `dshrc term`                                     | Terminal UI on a session                       |
| `dshrc relay`                                    | Self-hosted relay server                       |

Useful `up` flags: `--port`, `--host`, `--lan`, `--pair`, `--relay <url>`, `--room`, `--relay-key`, `--no-push`, `--cwd`, `--model`, `--agent-command <path>`, `--history`.

`--model` sets `DEEPSEEK_ACP_MODEL` on the spawned agent (`deepseek-acp` has no `--model` flag of its own). `--agent-command` overrides the `deepseek-acp` binary to spawn — useful for testing a different build, or a fork.

`--leader` and `--permission-mode` are still accepted (config-file compatibility) but have no effect against `deepseek-acp` — see [Required configuration](#approvals-need-no-configuration) above.

Config keys: `defaultCwd`, `port`, `host`, `lan`, `historyLimit`, `model`, `agentCommand`, `leader` *(deprecated, no effect)*, `permissionMode` *(deprecated, no effect)*.

---

## Networking

Pick one path. **Tailscale is the recommended way to use dshrc from anywhere** (cellular, coffee shop, travel) without opening ports on your router.

| Path              | When to use                                  | Phone URL shape                 |
| ----------------- | --------------------------------------------- | -------------------------------- |
| **Loopback only** | Desktop browser on the same machine          | `http://127.0.0.1:4319`          |
| **LAN**           | Phone on the same Wi‑Fi, trusted network     | `http://192.168.x.x:4319`        |
| **Tailscale**     | Phone anywhere on your tailnet (recommended) | `https://your-machine.….ts.net`  |
| **Relay**         | You control a VPS; daemon dials **out**      | Relay room URL (see below)       |

### LAN (same Wi‑Fi only)

```bash
dshrc up --lan
```

The daemon binds `0.0.0.0` and prints a URL using a local address, for example:

```text
  dshrc listening on http://192.168.1.10:4319
  ⚠ bound to all interfaces — keep this on a trusted network or a Tailnet.
```

- Replace `192.168.1.10` with whatever address **your** machine prints (any `192.168.x.x`, `10.x.x.x`, or `172.16–31.x.x` is fine).
- Only devices on that private network can reach it.
- Do **not** port-forward this to the public internet.

---

### Tailscale (access from anywhere)

Tailscale puts your PC and phone on a private mesh VPN ([tailnet](https://tailscale.com/kb/1136/tailnet)). The phone can reach your machine on cellular; you do **not** open inbound ports on your home router.

This is the best default for real phone use: **HTTPS**, works off-LAN, and satisfies browser requirements for **Web Push** and a stable PWA install.

#### 1. Install and sign in

**On the machine that runs dshrc**

- Linux / macOS / Windows: install from [tailscale.com/download](https://tailscale.com/download)
- Sign in with the same account (or an account invited to the same tailnet)

```bash
# Linux example (package managers also work — see Tailscale docs)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale status
```

**On the phone**

- Install the **Tailscale** app (iOS App Store / Google Play)
- Sign in to the **same** tailnet
- Leave Tailscale **connected** when you use dshrc away from home Wi‑Fi

#### 2. Start dshrc on the machine

Prefer loopback + Serve (nothing exposed on LAN):

```bash
dshrc up
# listens on 127.0.0.1:4319 by default
```

Or bind only the Tailscale interface if you prefer not to use Serve (HTTP, no TLS from Tailscale):

```bash
# Your Tailscale IP looks like 100.x.x.x — get it with:
tailscale ip -4

dshrc up --host 100.x.x.x --port 4319
```

Using raw `100.x.x.x:4319` works on many phones but is **HTTP**. For iOS push and a clean PWA install, use **Serve** (next step).

#### 3. Publish HTTPS with `tailscale serve`

On the **same machine** as the daemon, reverse-proxy **HTTPS** from your tailnet to local dshrc.
`dshrc` should already be listening on `127.0.0.1:4319` (`dshrc up`).

**Allow your user to run Serve without `sudo` every time** (Linux; run once):

```bash
sudo tailscale set --operator=$USER
```

**Point Serve at dshrc** (background, survives the shell closing):

```bash
tailscale serve --bg http://127.0.0.1:4319
```

Some Tailscale versions also accept an explicit path form:

```bash
tailscale serve --bg https / http://127.0.0.1:4319
```

Either is fine if `serve status` shows a proxy to `127.0.0.1:4319`.

**Confirm:**

```bash
tailscale serve status
```

Example output (names are **samples** — yours will differ):

```text
https://dev-laptop.tail-abc123.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:4319
```

**Phone URL** = that HTTPS hostname, for example:

```text
https://dev-laptop.tail-abc123.ts.net
```

Not the LAN address (`http://192.168.…`). Not a public Funnel URL.

| Placeholder   | Meaning                                                                        |
| ------------- | -------------------------------------------------------------------------------- |
| `dev-laptop`  | Your machine's MagicDNS name (set in the Tailscale admin console or hostname)   |
| `tail-abc123` | Your tailnet's DNS suffix (unique per account/org)                             |

Find your real hostname with:

```bash
tailscale status
# or
tailscale serve status
```

#### 4. Pair from the phone

1. Phone: Tailscale app **on** and connected to the **same** tailnet
2. Open your Serve URL, e.g. `https://dev-laptop.tail-abc123.ts.net`
   (use **your** name from `tailscale serve status`, not this sample)
3. Enter the pairing code (`dshrc pair` on the machine if you need a new one)
4. **Add to Home Screen** (required for iOS notifications)

You can now leave home Wi‑Fi; as long as both devices are on the tailnet, the phone keeps working.

#### 5. Persist across reboot

| Piece             | How                                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dshrc             | Linux: systemd user unit — [Run as a service](#run-as-a-service). Windows: Scheduled Task scripts under `packaging/windows/`.                                                      |
| `tailscale serve` | `--bg` keeps the serve config; Tailscale usually restores it after reboot once the client is up. Re-run the `tailscale serve` command if `serve status` is empty after an upgrade. |

Order after reboot: Tailscale online → dshrc listening → Serve still points at `http://127.0.0.1:4319`.

#### Serve vs Funnel

|                 | `tailscale serve`     | `tailscale funnel`                                             |
| ----------------- | ------------------------ | ------------------------------------------------------------------ |
| Who can connect | **Only your tailnet** | Public internet                                                  |
| For dshrc?      | **Yes — use this**    | **No** — remote control of a coding agent must not be public     |

Do **not** enable Funnel for dshrc.

#### Tailscale troubleshooting

| Symptom                                          | What to check                                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Phone can't load the page                        | Tailscale connected on **both** devices; same tailnet; `tailscale status` shows the machine online   |
| Connection refused                               | `dshrc` running? `curl -sS http://127.0.0.1:4319/api/health` on the machine                          |
| Serve 502 / bad gateway                          | Daemon not on `127.0.0.1:4319` — start `dshrc up` (not only Serve)                                    |
| Wrong URL on phone                               | Use the **`https://….ts.net`** Serve URL, not an old LAN `http://192.168.…` bookmark                  |
| Works on Wi‑Fi, dies on cellular                 | Phone Tailscale disconnected or battery optimization killed the VPN app                              |
| iOS push still broken                            | Must be **Home Screen** PWA over **HTTPS** (Serve). Tab Safari is not enough                          |
| Certificate warnings                             | Use the MagicDNS / Serve hostname Tailscale issued; don't invent hostnames                            |
| `tailscale serve` needs root / permission denied | Run once: `sudo tailscale set --operator=$USER`, then retry `serve`                                    |
| `serve status` empty after reboot                | Tailscale up? Re-run `tailscale serve --bg http://127.0.0.1:4319`                                     |

```bash
# Machine-side health
dshrc doctor
curl -sS http://127.0.0.1:4319/api/health
tailscale status
tailscale serve status
```

---

### Relay (outbound, no Tailscale)

When you run a small VPS and the daemon must dial **out** (no inbound ports, no Tailscale):

```bash
# on a VPS you control
dshrc relay --port 8080

# on the dev machine
dshrc up --relay wss://relay.example.com:8080
```

The daemon dials out. Frames are encrypted; the room key travels in the URL fragment (browsers do not send fragments to the server).
Pure transport with no JS from the relay: `dshrc relay --no-client` (install the PWA from the daemon origin first when you can).

---

## Push notifications

Self-hosted **Web Push** (VAPID). No third-party push cloud.

| Platform    | Notes                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **iOS**     | Safari **Add to Home Screen** only. Tab Safari and other iOS browsers do not support Web Push.                                                                  |
| **Android** | Chrome / Firefox / Edge / Samsung Internet; HTTPS required. **Not yet tested on a physical Android device** — use `dshrc doctor` and a real device to confirm. |
| **Desktop** | Works where Push API + service worker are available                                                                                                              |

The session list shows a notification row with status flags (`installed · pushAPI · sw · https · permission`) when something is missing.

Override VAPID subject if needed: `DSHRC_VAPID_SUBJECT=https://example.com` (must be a routable URL or `mailto:` for Apple).

---

## Run as a service

### Linux (systemd user unit)

```bash
# from a source checkout
./packaging/systemd/install.sh
systemctl --user enable --now dshrc
loginctl enable-linger $USER    # survive logout
```

### Windows (Scheduled Task)

See scripts under `packaging/windows/` (`install.ps1`, watchdog helpers). Run from an elevated PowerShell when installing the task.

### macOS

No service unit ships. Use `dshrc up` from a login item or your own launchd plist.

---

## Troubleshooting

| Symptom                       | Fix                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `doctor` / `up` says no agent | Install `deepseek-acp`: `npm install -g deepseek-acp`; ensure it is on `PATH`                                                              |
| Pairing "invalid" / expired   | Codes expire; only one redeem each; run `dshrc pair` again (don't issue many codes while typing one)                                       |
| No text box on old session    | Observed / finished sessions are read-only — **Resume** or start new                                                                        |
| Approvals never appear        | They should always appear on this backend — see [Required configuration](#approvals-need-no-configuration). If they still don't, `dshrc doctor` should confirm `deepseek-acp` and the ACP handshake are both healthy; open an issue if it reports fine and approvals still never surface. |
| Push never on iPhone          | Home Screen app + HTTPS; check notification row flags                                                                                       |
| Phone can't reach daemon      | Same LAN / Tailscale / relay; check bind (`--lan` vs loopback)                                                                              |
| Hand-back: no terminal opens  | Expected on this backend — there is no `deepseek-acp` equivalent of `grok -r`. Use the copy-paste `dshrc term --session <id>` command instead. |
| Stale UI after upgrade        | Force-close the PWA; hard refresh; check daemon is running the new build                                                                    |

```bash
dshrc doctor
dshrc devices
```

---

## FAQ

**Why not just put a terminal on my phone?**
DeepSeek Harness exposes a structured agent protocol via `deepseek-acp`. Approvals, tools, and plans are typed events — not ANSI guesswork.

**Does the TUI and phone share one session?**
Use `dshrc term` to open a terminal on the same session the phone drives. On this backend every session is its own `deepseek-acp` process, so a session started with plain `dsh` runs separately from the phone's live session.

**Is my code sent to a cloud?**
The agent runs on **your** machine, via `deepseek-acp`, using **your own** DeepSeek API key. Prompts and tool calls go to the DeepSeek API the same way they would from any other DeepSeek Harness client — dshrc adds no additional cloud in that path. The phone talks to your daemon (or your relay); the daemon and your credentials stay local.

**Can I use it on cellular?**
Yes with Tailscale or relay mode.

**Android push?**
Supported by the web platform in principle; **not validated on a physical Android device** yet.

---

## Uninstall

```bash
npm uninstall -g dshrc
# Linux service
systemctl --user disable --now dshrc 2>/dev/null
# Config and pairings (optional)
# rm -rf ~/.dshrc
```

---

## See also

- [Architecture](ARCHITECTURE.md)
- [Security](../SECURITY.md)
- [Changelog](../CHANGELOG.md)
