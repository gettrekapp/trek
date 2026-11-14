// scripts/serverLaunchers.mjs — the Windows launchers of the trek-server zip (package-server.mjs
// writes them; serverLaunchers.test.mjs checks their text). Both use CRLF line endings.

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
