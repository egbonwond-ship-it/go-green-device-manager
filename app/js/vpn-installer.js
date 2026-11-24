// Go-Green VPN installers, made in the browser from a key the console creates once and never stores.
//   Windows: a .cmd that installs WireGuard (signed by WireGuard LLC) and starts an always-on tunnel.
//   macOS:   a .conf to import into the free WireGuard app from the Mac App Store.
const sq = v => `'${String(v).replace(/'/g, "''")}'`;
const cmdq = v => sq(v).replace(/%/g, '%%').replace(/"/g, '\\"');

export function vpnConf({ privateKey, address, server }) {
  return [
    '[Interface]',
    `PrivateKey = ${privateKey}`,
    `Address = ${address}/32`,
    ...(server.dns?.length ? [`DNS = ${server.dns.join(', ')}`] : []),
    '',
    '[Peer]',
    `PublicKey = ${server.publicKey}`,
    `AllowedIPs = ${server.routes.join(', ')}`,
    `Endpoint = ${server.endpoint}`,
    'PersistentKeepalive = 25',
    '',
  ].join('\n');
}

export function windowsVpnSetup(opts) {
  const conf = vpnConf(opts).trim().split('\n');
  const ps = [
    '[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072',
    "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'",
    "Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction SilentlyContinue",
    "$wgexe = Join-Path $env:ProgramFiles 'WireGuard\\wireguard.exe'",
    'if (-not (Test-Path $wgexe)) {',
    "  Write-Host 'Downloading WireGuard...'",
    "  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } elseif ($env:PROCESSOR_ARCHITECTURE -eq 'x86') { 'x86' } else { 'amd64' }",
    "  $base = 'https://download.wireguard.com/windows-client/'",
    '  $index = (Invoke-WebRequest $base -UseBasicParsing).Content',
    "  $ver = [regex]::Matches($index, ('wireguard-' + $arch + '-([0-9.]+)[.]msi')) | ForEach-Object { $_.Groups[1].Value } | Sort-Object { [version]$_ } | Select-Object -Last 1",
    "  if (-not $ver) { throw 'Could not find the WireGuard installer.' }",
    "  $msi = Join-Path $env:TEMP ('wireguard-' + $arch + '-' + $ver + '.msi')",
    "  Invoke-WebRequest ($base + 'wireguard-' + $arch + '-' + $ver + '.msi') -OutFile $msi -UseBasicParsing",
    '  $sig = Get-AuthenticodeSignature $msi',
    "  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'WireGuard') { throw 'The WireGuard installer is not signed by WireGuard. Stopping.' }",
    "  Write-Host 'Installing WireGuard...'",
    `  $p = Start-Process msiexec.exe -ArgumentList ('/i \\"' + $msi + '\\" /qn /norestart DO_NOT_LAUNCH=1') -Wait -PassThru`,
    "  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw ('WireGuard setup failed with exit code ' + $p.ExitCode) }",
    '}',
    "$dir = Join-Path $env:ProgramData 'GoGreenVPN'",
    'New-Item -ItemType Directory -Path $dir -Force | Out-Null',
    '$acl = New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true, $false)',
    "foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }",
    'Set-Acl -Path $dir -AclObject $acl',
    "$conf = Join-Path $dir 'GoGreenVPN.conf'",
    `Set-Content -Path $conf -Encoding ASCII -Value @(${conf.map(cmdq).join(', ')})`,
    "if (Get-Service 'WireGuardTunnel$GoGreenVPN' -ErrorAction SilentlyContinue) { & $wgexe /uninstalltunnelservice GoGreenVPN; Start-Sleep 3 }",
    '& $wgexe /installtunnelservice $conf',
    "for ($i = 0; $i -lt 15 -and (Get-Service 'WireGuardTunnel$GoGreenVPN' -ErrorAction SilentlyContinue).Status -ne 'Running'; $i++) { Start-Sleep 2 }",
    "if ((Get-Service 'WireGuardTunnel$GoGreenVPN' -ErrorAction SilentlyContinue).Status -ne 'Running') { throw 'The VPN tunnel did not start.' }",
  ].join('; ').replace(/\{; /g, '{ ').replace(/; \}/g, ' }');
  return [
    '@echo off',
    `title GO-Green VPN Setup (${opts.name})`,
    'net session >nul 2>&1',
    'if errorlevel 1 (',
    '  echo Asking for administrator rights. Select Yes to continue.',
    '  set "GGT_SETUP=%~f0"',
    '  powershell.exe -NoProfile -Command "Start-Process -FilePath $env:GGT_SETUP -Verb RunAs"',
    '  if errorlevel 1 (echo Setup needs administrator rights and was cancelled. & pause)',
    '  exit /b',
    ')',
    'echo Setting up the GO-Green VPN. This takes a minute or two.',
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
    `echo Connected. This PC is on the GO-Green VPN as ${opts.address}, and it stays on, even after a restart.`,
    'echo Delete this file now: it contains this PC\'s VPN key.',
    'echo.',
    'pause',
    'exit /b 0',
    '',
  ].join('\r\n');
}
