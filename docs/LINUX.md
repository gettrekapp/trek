# Trek on Linux

The Trek desktop app runs on Ubuntu 22.04 and later and Debian 12 and later, on x64 and arm64.
It is built on Ubuntu 22.04 (glibc 2.35), so older distributions are not supported. It ships as a
`.deb` only. The Local server runs inside the app, as on the Mac, and the app connects to remote
servers the same way. The project bot does not run on Linux yet.

## Install

Download `Trek-<version>-linux-x64.deb` or `Trek-<version>-linux-arm64.deb` from the
[latest release](https://github.com/gettrekapp/trek/releases/latest), then:

```sh
sudo apt install ./Trek-<version>-linux-<arch>.deb
```

The Debian package is named `trek`. It installs to `/opt/Trek`, puts `trek` on PATH
(`/usr/bin/trek`) and adds Trek to the app grid. On Ubuntu 24.04 it also installs
electron-builder's AppArmor profile, which the kernel's unprivileged-user-namespace restriction
needs for Electron's sandbox.

`.trekproj` files open in Trek. There is one Trek per user: launching it while it runs brings its
window forward.

The agent CLIs you use (`claude`, `codex`, `gemini`, `grok`) must be installed and signed in as
your user, as on the Mac.

## Where things live

- `~/.config/Trek Dev`: Trek's user data (windows, settings, saved tokens).
- `~/.config/trek-server/local`: the Local server's profile.
- `/opt/Trek`: the app itself.

The Local server keeps running after Trek quits, so your sessions survive. Turn on "Stop local
server on quit" to stop it with the app.

## Saved tokens and the keyring

Trek encrypts the tokens for remote servers with GNOME Keyring or KWallet. Without one, it stores
them unencrypted in `~/.config/Trek Dev`, readable only by your user. Trek shows a one-time notice
when that happens, and Settings → General has a "Saved tokens" section while it is the case.

To encrypt them: install and unlock a keyring (`sudo apt install gnome-keyring`), restart Trek,
then save the tokens again by editing each server and entering its token.

## Updating

Updates are notify-only. Trek checks when it starts and once a day, as it does on the Mac, and
shows "Update available" in the title bar; File → Check for Updates… checks on demand. Its dialog
offers Open Release Page, Later and Skip This Version. Download the new `.deb` and install it over
the old one:

```sh
sudo apt install ./Trek-<version>-linux-<arch>.deb
```

The Local server keeps running through the upgrade, and Trek offers to restart it with the new
version.

## Uninstall

Stop the Local server first (File → Local Server → Stop Local Server), then:

```sh
sudo apt remove trek
```

`~/.config/Trek Dev` and `~/.config/trek-server` stay. Delete them by hand to remove everything.

## Not on Linux yet

- The project bot.
- AppImage, rpm, Flatpak and Snap packages.
- Installing updates from inside the app.

## Manual checklist (before the first Linux release)

Run on a real Ubuntu 24.04 desktop (x64), and once on arm64 if a machine is available, with the
draft release's `.deb`.

1. Install it. Trek appears in the app grid with its icon and starts. If it refuses to start with
   a sandbox error, report the console output.
2. The Local server starts. Create a project from a repository, add a worktree, and start a
   Claude session. The terminal works.
3. Quit Trek. The Local server keeps running ("Stop local server on quit" off). Start Trek again;
   it reconnects.
4. Launch Trek a second time from the app grid. The running Trek's window comes forward, and
   `ps -C trek -o args= | grep -v -e --type= -e trek-server.cjs | wc -l` prints 1 (Electron's
   helper processes carry `--type=` and the Local server runs `trek-server.cjs`; a second app
   would make it 2). Only one Trek shows in the dock, and `xprop WM_CLASS` (click the Trek window)
   prints the same class as `StartupWMClass` in `/usr/share/applications/trek.desktop` (`trek`).
5. Double-click a `.trekproj` in Files. The running Trek imports it.
6. Add a remote server with a token, on a desktop with GNOME Keyring. No notice appears, and
   Settings has no "Saved tokens" section. In a session without a keyring, the notice shows once
   and Settings shows the section.
7. With an older published version installed, File → Check for Updates… finds the newer one, and Open
   Release Page opens it in the browser.
8. Upgrade to the next `.deb` while the Local server runs. Trek offers to restart it.
9. Run `sudo apt remove trek`. The app is gone, and `~/.config/Trek Dev` and the Local profile
   remain.

Report anything that differs, with Trek's console output (`trek` from a terminal).
