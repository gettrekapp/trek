// scripts/serverLaunchers.mjs — the launchers of the trek-server tarballs and zip (package-server.mjs
// writes them; serverLaunchers.test.mjs checks the Windows ones' text and runs the POSIX one).
// The Windows launchers use CRLF line endings.

// The Windows launcher: the same checks, as a batch file (CRLF). parseInt keeps the version
// check free of quotes, which for /f's command would trip on.
export const WIN_LAUNCHER = [
  '@echo off',
  'rem trek-server launcher: runs trek-server.cjs (beside this bin folder) with Node.js >= 22,',
  'rem the node on PATH unless TREK_NODE names one.',
  'setlocal',
  'set "node=%TREK_NODE%"',
  'if "%node%"=="" set "node=node"',
  'rem node itself checks its version (exit 42: too old). No FOR loop reads its output: cmd ends a',
  'rem FOR clause at the first parenthesis outside quotes, and the nested quotes it needs hide which are.',
  '"%node%" -e "process.exit(parseInt(process.versions.node)>=22?0:42)" 2>nul',
  'if errorlevel 43 goto missing',
  'if errorlevel 42 goto old',
  'if errorlevel 1 goto missing',
  '"%node%" "%~dp0..\\trek-server.cjs" %*',
  'exit /b %errorlevel%',
  ':missing',
  'echo trek-server: Node.js 22 or later is needed, and "%node%" was not found ^(set TREK_NODE to a node binary^) 1>&2',
  'exit /b 127',
  ':old',
  '"%node%" -e "console.error(\'trek-server: Node.js 22 or later is needed; \' + process.argv[1] + \' is version \' + parseInt(process.versions.node))" "%node%"',
  'exit /b 1',
  ''
].join('\r\n')

// The PowerShell launcher (Windows PowerShell 5.1 and pwsh 7): the same checks and wording as the
// batch file. Ctrl+C reaches node directly, with no "Terminate batch job (Y/N)?" prompt.
export const WIN_PS_LAUNCHER = [
  '# trek-server launcher: runs trek-server.cjs (beside this bin folder) with Node.js >= 22,',
  '# the node on PATH unless TREK_NODE names one.',
  "$node = if ($env:TREK_NODE) { $env:TREK_NODE } else { 'node' }",
  'if (-not (Get-Command $node -ErrorAction SilentlyContinue)) {',
  '  [Console]::Error.WriteLine("trek-server: Node.js 22 or later is needed, and `"$node`" was not found (set TREK_NODE to a node binary)")',
  '  exit 127',
  '}',
  '$major = 0',
  "try { $major = [int](\"$(& $node -p 'parseInt(process.versions.node)' 2>$null)\".Trim()) } catch { $major = 0 }",
  'if ($major -lt 22) {',
  '  [Console]::Error.WriteLine("trek-server: Node.js 22 or later is needed; `"$node`" is version $major")',
  '  exit 1',
  '}',
  "& $node (Join-Path $PSScriptRoot '..\\trek-server.cjs') @args",
  'exit $LASTEXITCODE',
  ''
].join('\r\n')

// The launcher. POSIX sh; resolves its own symlinks so a link in ~/.local/bin finds the folder.
export const POSIX_LAUNCHER = `#!/bin/sh
# trek-server launcher: runs trek-server.cjs (beside this bin/ folder) with Node.js >= 22,
# the \`node\` on PATH unless TREK_NODE names one.
set -e
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
here=$(cd "$(dirname "$self")/.." && pwd)
# An update that has not started yet (update-pending.json, from \`trek-server update\`). The first
# start marks it tried; the server removes both marks once it is listening. A start that still
# finds the tried mark means the new version never got that far, so the version before it
# (<this folder>.previous) is put back and started instead.
# Whether the command is \`start\`, which is also the default. The flags that take a value are
# skipped with their value (server/src/cli.ts, VALUE_FLAGS: keep the two lists in step).
is_start() {
  cmd=
  skip=0
  for a in "$@"; do
    if [ "$skip" = 1 ]; then skip=0; continue; fi
    case $a in
      -h|--help|-v|--version) return 1 ;;
      --id|--name|--config|--port|--host|--data-dir|--import-env-from|--local-profile) skip=1 ;;
      -*) ;;
      *) [ -n "$cmd" ] || cmd=$a ;;
    esac
  done
  [ -z "$cmd" ] || [ "$cmd" = start ]
}
if [ -f "$here/update-pending.json" ] && is_start "$@"; then
  if [ -f "$here/update-pending.tried" ]; then
    if [ -d "$here.previous" ]; then
      echo "trek-server: the updated version did not start; going back to the version before it" >&2
      rm -rf "$here.failed"
      mv "$here" "$here.failed"
      if ! mv "$here.previous" "$here"; then
        mv "$here.failed" "$here" || echo "trek-server: $here.failed could not be moved back to $here either" >&2
        echo "trek-server: could not put $here.previous back" >&2
        exit 1
      fi
      cp "$here.failed/update-pending.json" "$here/update-rolled-back.json" 2>/dev/null || true
      exec "$here/bin/trek-server" "$@"
    fi
    echo "trek-server: the updated version did not start last time, and $here.previous is gone; starting it again" >&2
  else
    touch "$here/update-pending.tried" 2>/dev/null || true
  fi
fi
node=\${TREK_NODE:-node}
if ! command -v "$node" >/dev/null 2>&1; then
  echo "trek-server: Node.js 22 or later is needed, and \\"$node\\" was not found (set TREK_NODE to a node binary)" >&2
  exit 127
fi
major=$("$node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
# Anything but digits (not a Node, a wrapper printing more) counts as too old: \`[ -lt ]\` would
# fail on it and let it through.
case $major in ''|*[!0-9]*) major=0 ;; esac
if [ "$major" -lt 22 ]; then
  echo "trek-server: Node.js 22 or later is needed; $("$node" --version 2>/dev/null) is $(command -v "$node")" >&2
  exit 1
fi
exec "$node" "$here/trek-server.cjs" "$@"
`
