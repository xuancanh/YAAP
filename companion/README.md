# yaam-companion

The desktop companion lets your YAAP agents act on **this** computer:
take screenshots, click and type, run shell commands, and read or write files
in folders you name. It is the one controlled hole in YAAP's "agents have
no host" isolation model, and it is shaped so that you stay in charge
(design: `docs/computer-control.md` in the main repository).

What makes it safe enough to run:

- **Outbound only.** The companion connects to your YAAP server and asks
  for work. Nothing listens on your computer; no port is opened.
- **Paired, once, to one server.** A 10-minute code from Settings → Computer
  binds this companion. The server stores only a hash of the token it hands
  back; the token itself lives in `~/.yaam-companion/config.json` (mode 0600).
- **Scopes you choose here, at the keyboard.** `screen`, `input`, `shell`,
  `files:<dir>`. The server can narrow them afterwards; it can never widen them.
  The companion checks every action against your scopes again, locally.
- **Every action is approved by you in the app first** — even in Auto mode.
  Shell commands and file writes can never be set to "always allow"; scheduled
  loops and Telegram turns cannot use the computer at all.
- **Every action is printed here and recorded on the server** (Settings →
  Computer, last 50).
- **Three kill switches:** Ctrl-C here; Pause / Disconnect in Settings →
  Computer (Disconnect revokes the token immediately); and
  `COMPUTER_CONTROL_ENABLED=false` on the server.

## Install

Node.js 20 or newer. No native modules.

```sh
npx yaam-companion --help
# or, from a checkout of yaam-chat:
cd companion && npm install && npm run build && node dist/src/cli.js --help
```

## Pair

1. In YAAP open **Settings → Computer** and click **Generate pairing
   code**. The code is valid for ten minutes and for one companion.
2. On the computer you want agents to use:

```sh
npx yaam-companion pair https://your-yaam-server 1a2b3c4d \
  --scopes screen,input,files:$HOME/Projects --name "work laptop"
```

Pairing over plain `http://` is allowed only for `localhost`.

3. Start it and leave it running:

```sh
npx yaam-companion run
```

`yaam-companion status` shows the pairing; `yaam-companion unpair` forgets it
locally (click **Disconnect** in the app as well to revoke the token).

## Scopes

| Scope | Tools it enables | What that means |
|---|---|---|
| `screen` | `computer_screenshot` | The agent sees your screen (the image is sent to the model and saved as a workspace file). |
| `input` | `computer_click`, `computer_move`, `computer_scroll`, `computer_type`, `computer_key` | Mouse and keyboard, in whatever app is in front. |
| `shell` | `computer_shell` | Commands run in **your** shell, as **you**, with your permissions. Each one is shown to you in full and approved before it runs; 64 KB of output, 300 s maximum. |
| `files:/abs/dir` | `computer_read_file`, `computer_write_file`, `computer_list_dir` | Only paths under the directories you list. Symlinks are resolved first: a link inside a granted folder that points outside is refused. Repeat the scope for several folders. |

Grant the least you need. `screen,input` is enough to drive a GUI;
`files:` is enough for "edit the files in this project"; `shell` is the big
one.

## What the agent can and cannot do

Can, after you approve each action in the app:

- look at your screen (`screen`), move/click/scroll/type/press keys
  (`input`), run a command (`shell`), read/write/list files under the folders
  you granted (`files:`).

Cannot, by construction:

- act without a fresh approval from you — the acting tools never remember an
  "always allow"; only screenshot, move, scroll, list and read can be
  remembered, per chat, and the independent action reviewer still looks at
  those;
- act from a scheduled loop or a channel (Telegram) turn — those are refused
  and land in the agent's inbox as a note;
- widen its own scopes, reach a folder you did not grant (realpath-checked),
  or run without the `shell` scope;
- open a port on your machine, or be reached by the server — the companion
  only ever asks;
- keep working after **Disconnect**: the next poll gets 401 and the companion
  exits.

What it still *can* do inside the scopes you gave: `shell` is your shell —
`rm -rf` is a command like any other, which is why you read every command
before it runs. Typed text goes to whatever window has focus. Treat `shell`
and `input` as "a careful person at my keyboard who asks before each step",
not as a sandbox.

## Platforms

Coordinates the agent sends are pixels of the **last screenshot**; the
companion converts to the OS pointer space (Retina 2×, downscaling).

| | Screenshot | Mouse | Keyboard |
|---|---|---|---|
| **macOS** (tested) | `screencapture -x` (built in), downscaled to 1600 px with `sips` | `cliclick` if installed (`brew install cliclick`) — needed for right/double click, pointer move and scroll; otherwise `osascript` System Events (left click only) | `osascript` System Events (`keystroke`, `key code`) |
| **Linux** | `grim` (Wayland), `scrot` or ImageMagick `import` (X11) | `xdotool` | `xdotool` |
| **Windows** (best effort, untested) | PowerShell + `System.Drawing` | PowerShell + `user32` (`SetCursorPos`, `mouse_event`) | PowerShell `SendKeys` (no Windows-key combos) |

macOS asks for **Screen Recording** (screenshots) and **Accessibility**
(clicks and typing) permission for the terminal that runs the companion the
first time; grant them in System Settings → Privacy & Security. Scrolling on
macOS is approximated with arrow keys after moving the pointer.

## Files

- `~/.yaam-companion/config.json` — server URL, token, scopes (0600). Set
  `YAAM_COMPANION_HOME` to move it.
- Screenshots are **not** kept on this machine; they go to the server's
  workspace file store under `computer/<chat>/<n>.png`.

## Development

```sh
npm run build   # tsc → dist/
npm test        # node:test over the scope/realpath/shell/key helpers
```
