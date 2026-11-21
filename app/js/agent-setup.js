// Setup files with this site's address and the enrollment token built in, made in the browser
// (the token never goes into a URL). Windows: double-click the .cmd. macOS/Linux: one sudo command.
const sq = v => `'${String(v).replace(/'/g, "''")}'`;          // PowerShell single-quoted string
const shq = v => `'${String(v).replace(/'/g, `'\\''`)}'`;      // POSIX shell single-quoted string
// In a .cmd file "%" starts a variable, so it is doubled; inside the -Command "..." a double quote is escaped as \".
const cmdq = v => sq(v).replace(/%/g, '%%').replace(/"/g, '\\"');
// Plain, readable commands (no encoded PowerShell, which antivirus tends to block). The file
// re-launches itself with administrator rights, installs the agent, and waits for a key press.
export function windowsSetup(origin, token) {
  const ps = [
    '[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072',
    "$ErrorActionPreference = 'Stop'",
    "$f = Join-Path $env:TEMP 'ggt-agent.ps1'",
    `Invoke-WebRequest ${cmdq(origin + '/agent/ggt-agent.ps1')} -OutFile $f -UseBasicParsing`,
    `& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $f -Install -Server ${cmdq(origin)} -Token ${cmdq(token)}`,
    'exit $LASTEXITCODE',
  ].join('; ');
  return [
    '@echo off',
    'title GO-Green Agent Setup',
    'net session >nul 2>&1',
    'if errorlevel 1 (',
    '  echo Asking for administrator rights. Select Yes to continue.',
    '  set "GGT_SETUP=%~f0"',
    '  powershell.exe -NoProfile -Command "Start-Process -FilePath $env:GGT_SETUP -Verb RunAs"',
    '  if errorlevel 1 (echo Setup needs administrator rights and was cancelled. & pause)',
    '  exit /b',
    ')',
    'echo Installing the GO-Green agent. This takes a minute or two.',
    'echo.',
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`,
    'if errorlevel 1 (',
    '  echo.',
    '  echo Setup failed. The messages above say why.',
    '  echo.',
    '  pause',
    '  exit /b 1',
    ')',
    'echo.',
    'echo Done. This PC appears in GO-Green Device Manager within a minute.',
    'echo.',
    'pause',
    'exit /b 0',
    '',
  ].join('\r\n');
}
export function unixSetup(origin, token) {
  return `#!/bin/sh
# GO-Green agent setup for macOS and Linux. Run:  sudo sh go-green-agent-setup.sh
set -e
if [ "$(id -u)" != "0" ]; then echo "The agent installs for all users, so enter your password if asked."; exec sudo sh "$0" "$@"; fi
if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 6))' >/dev/null 2>&1; then
  echo "Python 3 is needed first."
  if [ "$(uname)" = "Darwin" ]; then echo "Install the Command Line Tools with:  xcode-select --install   then run this again."; else echo "Install the python3 package, then run this again."; fi
  exit 1
fi
f=$(mktemp /tmp/ggt-agent.XXXXXX)
curl -fsSL ${shq(origin + '/agent/ggt-agent.py')} -o "$f"
python3 "$f" install --server ${shq(origin)} --token ${shq(token)}
rm -f "$f"
echo "Done. This computer appears in GO-Green Device Manager within a minute."
`;
}
export function saveFile(name, text, type = 'application/octet-stream') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
