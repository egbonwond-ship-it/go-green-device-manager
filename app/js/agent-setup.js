// Setup files with this site's address and the enrollment token built in, made in the browser
// (the token never goes into a URL). Windows: double-click the .cmd. macOS/Linux: one sudo command.
const sq = v => `'${String(v).replace(/'/g, "''")}'`;          // PowerShell single-quoted string
const shq = v => `'${String(v).replace(/'/g, `'\\''`)}'`;      // POSIX shell single-quoted string
function utf16b64(str) {
  let bin = '';
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); bin += String.fromCharCode(c & 255, c >> 8); }
  return btoa(bin);
}
export function windowsSetup(origin, token) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12',
    "  $f = Join-Path $env:TEMP 'ggt-agent.ps1'",
    `  Invoke-WebRequest ${sq(origin + '/agent/ggt-agent.ps1')} -OutFile $f -UseBasicParsing`,
    `  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $f -Install -Server ${sq(origin)} -Token ${sq(token)}`,
    "  if ($LASTEXITCODE) { throw \"the agent installer exited with code $LASTEXITCODE\" }",
    "  Write-Host ''; Write-Host 'Done. This PC appears in GO-Green Device Manager within a minute.' -ForegroundColor Green",
    "} catch { Write-Host ''; Write-Host \"Setup failed: $_\" -ForegroundColor Red }",
    "Read-Host 'Press Enter to close' | Out-Null",
  ].join('\r\n');
  return [
    '@echo off',
    'title GO-Green Agent Setup',
    'echo Installing the GO-Green agent. Select Yes when Windows asks for administrator rights.',
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${utf16b64(ps)}'"`,
    'if errorlevel 1 (echo Setup was cancelled. & pause)',
    '',
  ].join('\r\n');
}
export function unixSetup(origin, token) {
  return `#!/bin/sh
# GO-Green agent setup for macOS and Linux. Run:  sudo sh go-green-agent-setup.sh
set -e
if [ "$(id -u)" != "0" ]; then echo "Run this with sudo:  sudo sh $0"; exit 1; fi
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
