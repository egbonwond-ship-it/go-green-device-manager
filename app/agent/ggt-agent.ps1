<#
.SYNOPSIS
  Go-Green Device Manager agent for Windows 10, 11 and Windows Server 2016 or later.

.DESCRIPTION
  Install (PowerShell as administrator):
    .\ggt-agent.ps1 -Install -Server https://<your-site> -Token '<enrollment token>'
  Uninstall:
    .\ggt-agent.ps1 -Uninstall

  Every 5 minutes (scheduled task "\Go-Green\GGT Agent", running as SYSTEM) the agent:
    1. collects hardware, OS, network, security settings and installed programs,
    2. scans Windows Update for missing updates (every 6 hours, or when asked),
    3. checks in, then pulls its policy from the Device Manager,
    4. runs queued scripts and actions, fixes settings for baselines with remediation on,
       installs or removes deployed applications, installs approved updates and runs Windows
       upgrade task sequences (which carry on across restarts),
    5. reports each result back.
  Files: C:\ProgramData\GGT Agent (config.json holds the device key; only SYSTEM and Administrators can read it).
#>
[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
  [Parameter(ParameterSetName = 'Install', Mandatory = $true)][switch]$Install,
  [Parameter(ParameterSetName = 'Install', Mandatory = $true)][string]$Server,
  [Parameter(ParameterSetName = 'Install', Mandatory = $true)][string]$Token,
  [Parameter(ParameterSetName = 'Install')][switch]$NoSchedule,
  [Parameter(ParameterSetName = 'Uninstall', Mandatory = $true)][switch]$Uninstall,
  [Parameter(ParameterSetName = 'Run')][switch]$Run,
  [switch]$SkipUpdateScan,
  [string]$AgentDir = (Join-Path $env:ProgramData 'GGT Agent')
)

$AgentVersion = '2.6.1'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ConfigPath = Join-Path $AgentDir 'config.json'
$StatePath = Join-Path $AgentDir 'state.json'
$LogPath = Join-Path $AgentDir 'Logs\agent.log'
$TaskName = 'GGT Agent'
$TaskPath = '\Go-Green\'

function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function Iso($d) { if ($d) { ([datetime]$d).ToUniversalTime().ToString('o') } else { $null } }

function Write-Log([string]$Message, [string]$Level = 'info') {
  $line = '{0} [{1}] {2}' -f (Get-Date).ToString('s'), $Level, $Message
  Write-Host $line
  try {
    $dir = Split-Path $LogPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -gt 1MB) { Move-Item $LogPath "$LogPath.1" -Force }
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
  } catch { }
}

function Read-Json($Path) {
  if (Test-Path $Path) { try { return Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { } }
  return $null
}
function Write-Json($Path, $Object) { Set-Content -Path $Path -Value (ConvertTo-Json -InputObject $Object -Depth 10) -Encoding UTF8 }

# PSCustomObject (from JSON) to hashtable, so state can be changed freely.
function To-Hash($o) {
  $h = @{}
  if ($o) { foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = $p.Value } }
  return $h
}

# ---------------------------------------------------------------- server calls
function Invoke-Api([string]$Method, [string]$Path, $Body) {
  $headers = @{ 'x-ggt-enroll-token' = $script:Config.token }
  if ($script:Config.deviceKey) { $headers['x-ggt-device-key'] = $script:Config.deviceKey }
  $req = @{ Uri = ($script:Config.server + $Path); Method = $Method; Headers = $headers; UseBasicParsing = $true; TimeoutSec = 120 }
  if ($null -ne $Body) {
    $req.Body = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Body -Depth 10 -Compress))
    $req.ContentType = 'application/json; charset=utf-8'
  }
  try { return Invoke-RestMethod @req } catch {
    $code = 0
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    $detail = $_.ErrorDetails.Message
    if (-not $detail) { $detail = $_.Exception.Message }
    $err = New-Object Exception("$Method $Path failed ($code): $detail")
    $err.Data['status'] = $code
    throw $err
  }
}

# ---------------------------------------------------------------- inventory
function Get-Inventory {
  $cs = Get-CimInstance Win32_ComputerSystem
  $os = Get-CimInstance Win32_OperatingSystem
  $bios = Get-CimInstance Win32_BIOS
  $cpus = @(Get-CimInstance Win32_Processor)
  $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$env:SystemDrive'"
  $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  $release = if ($cv.DisplayVersion) { $cv.DisplayVersion } else { $cv.ReleaseId }
  $caption = ($os.Caption -replace '^Microsoft\s+', '').Trim()
  # Windows 11 still reports "Windows 10" in some places; the build number decides.
  if ($os.ProductType -eq 1 -and [int]$os.BuildNumber -ge 22000) { $caption = $caption -replace 'Windows 10', 'Windows 11' }
  $osName = if ($release -and $os.ProductType -eq 1) { "$caption $release" } else { $caption }
  $type = 'Desktop'
  if ("$($cs.Model) $($cs.Manufacturer)" -match 'Virtual|VMware|KVM|QEMU|HVM|Xen|innotek|Amazon EC2|Google Compute') { $type = 'VM' }
  elseif ($os.ProductType -ne 1) { $type = 'Server' }
  elseif ($cs.PCSystemType -eq 2) { $type = 'Laptop' }
  $nets = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True')
  $net = $nets | Where-Object { $_.DefaultIPGateway } | Select-Object -First 1
  if (-not $net) { $net = $nets | Select-Object -First 1 }
  $ip = if ($net) { @($net.IPAddress | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' })[0] } else { $null }
  # Every IPv4 address (LAN, Wi-Fi, VPN, Tailscale), primary first, so remote desktop can pick one that's reachable.
  $ips = @($nets | ForEach-Object { $_.IPAddress } | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -notmatch '^(127\.|169\.254\.)' } | Select-Object -Unique)
  if ($ip) { $ips = @($ip) + @($ips | Where-Object { $_ -ne $ip }) }
  $join = Get-JoinInfo $cs
  $rdpPort = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -Name PortNumber -ErrorAction SilentlyContinue).PortNumber
  $load = ($cpus | Measure-Object -Property LoadPercentage -Average).Average
  $freePct = if ($disk.Size) { [math]::Round($disk.FreeSpace / $disk.Size * 100) } else { $null }
  return [ordered]@{
    name = $env:COMPUTERNAME; platform = 'Windows'; os = $osName; build = "$($os.BuildNumber).$($cv.UBR)"; type = $type
    manufacturer = "$($cs.Manufacturer)".Trim(); model = "$($cs.Model)".Trim(); serial = "$($bios.SerialNumber)".Trim(); cpu = "$($cpus[0].Name)".Trim()
    ramGB = [math]::Round($cs.TotalPhysicalMemory / 1GB); diskGB = [math]::Round($disk.Size / 1GB); diskFreePct = $freePct
    ip = $ip; mac = if ($net) { $net.MACAddress } else { $null }; user = $cs.UserName; lastBoot = Iso $os.LastBootUpTime
    cpuPct = if ($null -ne $load) { [math]::Round($load) } else { $null }
    memPct = [math]::Round(100 - ($os.FreePhysicalMemory / $os.TotalVisibleMemorySize * 100))
    agentVersion = $AgentVersion
    joinType = $join.joinType; domain = $join.domain; netbiosDomain = $join.netbiosDomain; fqdn = $join.fqdn
    ips = $ips; rdpPort = if ($rdpPort) { [int]$rdpPort } else { $null }; tailscale = Get-Tailscale; fortiConnected = Get-FortiConnected; ggvpn = Get-GoGreenVpn
    osReady = Get-OsReadiness; encryption = Get-Encryption; wuServer = Get-WuServer; wsus = Get-WsusInfo
  }
}

# How the PC signs people in: joined to Active Directory, to Microsoft Entra ID, both, or neither (workgroup).
# Remote desktop uses this to suggest the right account format (DOMAIN\user, AzureAD\user or PC\user).
function Get-JoinInfo($cs) {
  $reg = @{}
  try { (& dsregcmd.exe /status 2>$null) | ForEach-Object { if ($_ -match '^\s*(\w+)\s*:\s*(.+?)\s*$') { $reg[$Matches[1]] = $Matches[2] } } } catch { }
  $entra = $reg['AzureAdJoined'] -eq 'YES'
  $dns = "$($cs.DNSHostName)"; if (-not $dns) { $dns = $env:COMPUTERNAME }
  if ($cs.PartOfDomain) {
    $nb = $null
    if ("$($cs.UserName)" -match '^([^\\]+)\\' -and $Matches[1] -ne $env:COMPUTERNAME -and $Matches[1] -ne 'AzureAD') { $nb = $Matches[1] }
    if (-not $nb) { try { $nb = @(Get-CimInstance Win32_NTDomain -ErrorAction Stop | Where-Object { $_.DnsForestName -and $_.DomainName })[0].DomainName } catch { } }
    return @{ joinType = $(if ($entra) { 'Hybrid' } else { 'Domain' }); domain = "$($cs.Domain)"; netbiosDomain = $nb; fqdn = "$dns.$($cs.Domain)".ToLower() }
  }
  $suffix = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters' -Name Domain -ErrorAction SilentlyContinue).Domain
  return @{
    joinType = $(if ($entra) { 'Entra' } else { 'Workgroup' })
    domain = $(if ($entra) { $reg['TenantName'] } else { "$($cs.Workgroup)" })
    netbiosDomain = $null
    fqdn = $(if ($suffix) { "$dns.$suffix".ToLower() } else { $null })
  }
}

# Tailscale (mesh VPN) address and MagicDNS name, so remote desktop works when the PC is outside the office.
function Find-Tailscale { @((Get-Command tailscale.exe -ErrorAction SilentlyContinue).Source, "$env:ProgramFiles\Tailscale\tailscale.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1 }
function Get-Tailscale {
  $exe = Find-Tailscale
  if (-not $exe) { return $null }
  try {
    $j = (& $exe status --json 2>$null | Out-String) | ConvertFrom-Json
    if (-not $j.Self) { return $null }
    return @{ ips = @($j.Self.TailscaleIPs | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' }); dnsName = "$($j.Self.DNSName)".TrimEnd('.'); online = [bool]($j.BackendState -eq 'Running') }
  } catch { return $null }
}

# FortiClient VPN is connected when its virtual adapter (Fortinet SSL VPN / PPPoP WAN Adapter) is up.
function Get-FortiConnected {
  try {
    $a = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop | Where-Object { $_.InterfaceDescription -match 'Fortinet|FortiClient' })
    if (-not $a.Count) { return $null }
    return [bool](@($a | Where-Object { $_.Status -eq 'Up' }).Count)
  } catch { return $null }
}

# Joins the company's Tailscale network with the auth key the console sends, installing Tailscale first if needed.
function Join-Tailscale([string]$AuthKey) {
  if (-not $AuthKey) { throw 'No Tailscale auth key was sent. Save one on the VPN page.' }
  $exe = Find-Tailscale
  if (-not $exe) {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
    $msi = Join-Path $env:TEMP "tailscale-setup-$arch.msi"
    try { Invoke-WebRequest -Uri "https://pkgs.tailscale.com/stable/tailscale-setup-latest-$arch.msi" -OutFile $msi -UseBasicParsing -TimeoutSec 900 } catch { throw "Couldn't download Tailscale: $($_.Exception.Message). Deploy it from the Software library (winget ID Tailscale.Tailscale), then try again." }
    $r = Invoke-Process 'msiexec.exe' @('/i', "`"$msi`"", '/qn', '/norestart', 'TS_UNATTENDEDMODE=always') 900
    Remove-Item $msi -Force -ErrorAction SilentlyContinue
    if ($r.exitCode -ne 0 -and $r.exitCode -ne 3010) { throw "Tailscale setup failed with exit code $($r.exitCode)." }
    for ($i = 0; $i -lt 30 -and -not ($exe = Find-Tailscale); $i++) { Start-Sleep 2 }
    if (-not $exe) { throw 'Tailscale was installed but tailscale.exe was not found.' }
  }
  $r = Invoke-Process $exe @('up', "--authkey=$AuthKey", '--unattended', "--hostname=$($env:COMPUTERNAME.ToLower())") 180
  if ($r.exitCode -ne 0) { throw "tailscale up failed: $($r.output -replace [regex]::Escape($AuthKey), 'tskey-…')" }
  $t = Get-Tailscale
  return "Joined Tailscale as $($t.dnsName) ($(@($t.ips) -join ', '))."
}
function Leave-Tailscale {
  $exe = Find-Tailscale
  if (-not $exe) { return 'Tailscale is not installed.' }
  $r = Invoke-Process $exe @('logout') 120
  if ($r.exitCode -ne 0) { throw "tailscale logout failed: $($r.output)" }
  return 'Left the Tailscale network. Tailscale is still installed; uninstall it from Deployments if you no longer need it.'
}

# ---------------------------------------------------------------- Go-Green VPN (WireGuard)
# The company's own VPN server in Azure. The PC makes its own WireGuard key, which never leaves it;
# only the public key is reported, and the VPN server picks it up from the console within a minute.
$GgVpnTunnel = 'GoGreenVPN'
$GgVpnDir = Join-Path $AgentDir 'vpn'
function Find-WireGuard { @("$env:ProgramFiles\WireGuard\wireguard.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1 }
function Find-Wg { @("$env:ProgramFiles\WireGuard\wg.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1 }
# Windows PowerShell's own security module (signatures, ACLs), loaded by path so a PSModulePath
# inherited from PowerShell 7 can't hide it.
function Import-SecurityModule { Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction SilentlyContinue }
function Install-WireGuard {
  if (Find-WireGuard) { return }
  Import-SecurityModule
  $arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'ARM64' { 'arm64' } 'x86' { 'x86' } default { 'amd64' } }
  $base = 'https://download.wireguard.com/windows-client/'
  try {
    $index = (Invoke-WebRequest -Uri $base -UseBasicParsing -TimeoutSec 120).Content
    $ver = [regex]::Matches($index, "wireguard-$arch-([0-9.]+)\.msi") | ForEach-Object { $_.Groups[1].Value } | Sort-Object { [version]$_ } | Select-Object -Last 1
    if (-not $ver) { throw 'no installer listed' }
    $msi = Join-Path $env:TEMP "wireguard-$arch-$ver.msi"
    Invoke-WebRequest -Uri "$base/wireguard-$arch-$ver.msi" -OutFile $msi -UseBasicParsing -TimeoutSec 900
  } catch { throw "Couldn't download WireGuard: $($_.Exception.Message)" }
  $sig = Get-AuthenticodeSignature $msi
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'WireGuard') { Remove-Item $msi -Force -ErrorAction SilentlyContinue; throw "The WireGuard installer isn't signed by WireGuard LLC ($($sig.Status)). Not installing it." }
  $r = Invoke-Process 'msiexec.exe' @('/i', "`"$msi`"", '/qn', '/norestart', 'DO_NOT_LAUNCH=1') 900
  Remove-Item $msi -Force -ErrorAction SilentlyContinue
  if ($r.exitCode -ne 0 -and $r.exitCode -ne 3010) { throw "WireGuard setup failed with exit code $($r.exitCode)." }
  for ($i = 0; $i -lt 30 -and -not (Find-WireGuard); $i++) { Start-Sleep 2 }
  if (-not (Find-WireGuard)) { throw 'WireGuard was installed but wireguard.exe was not found.' }
}
function Lock-Folder($Path) {
  # Only SYSTEM and Administrators can read the VPN key.
  Import-SecurityModule
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  }
  Set-Acl -Path $Path -AclObject $acl
}
function Get-GgVpnPublicKey {
  $pubFile = Join-Path $GgVpnDir 'public.key'
  if (Test-Path $pubFile) { $pub = (Get-Content $pubFile -Raw).Trim(); if ($pub -match '^[A-Za-z0-9+/]{43}=$') { return $pub } }
  return $null
}
function Get-GoGreenVpn {
  try {
    $conf = Join-Path $GgVpnDir "$GgVpnTunnel.conf"
    if (-not (Test-Path $conf)) { return $null }
    $pub = Get-GgVpnPublicKey
    if (-not $pub) { return $null }
    $addr = if ((Get-Content $conf -Raw) -match '(?m)^Address\s*=\s*([0-9.]+)') { $Matches[1] } else { $null }
    $svc = Get-Service "WireGuardTunnel`$$GgVpnTunnel" -ErrorAction SilentlyContinue
    $age = $null
    $wg = Find-Wg
    if ($svc -and $svc.Status -eq 'Running' -and $wg) {
      $hs = (& $wg show $GgVpnTunnel latest-handshakes 2>$null | Out-String).Trim()
      if ($hs -match '\s(\d+)$' -and [int64]$Matches[1] -gt 0) { $age = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [int64]$Matches[1]) }
    }
    return @{ publicKey = $pub; address = $addr; up = [bool]($svc -and $svc.Status -eq 'Running'); handshakeAgeSec = $age }
  } catch { Write-Log "Go-Green VPN status: $($_.Exception.Message)" 'warn'; return $null }
}
function Connect-GoGreenVpn($Vpn) {
  if (-not $Vpn -or -not $Vpn.address -or -not $Vpn.serverPublicKey -or -not $Vpn.endpoint) { throw 'The console did not send the VPN settings. Check the Go-Green VPN setup on the VPN page.' }
  Install-WireGuard
  $wg = Find-Wg; $exe = Find-WireGuard
  if (-not (Test-Path $GgVpnDir)) { New-Item -ItemType Directory -Path $GgVpnDir -Force | Out-Null }
  Lock-Folder $GgVpnDir
  $keyFile = Join-Path $GgVpnDir 'private.key'
  if (-not (Test-Path $keyFile)) { Set-Content -Path $keyFile -Value ((& $wg genkey | Out-String).Trim()) -Encoding ASCII -NoNewline }
  $priv = (Get-Content $keyFile -Raw).Trim()
  # Windows PowerShell adds a CRLF when piping to a program, which wg rejects, so feed the key file directly.
  $pubOut = Join-Path $GgVpnDir 'pubkey.tmp'
  Start-Process -FilePath $wg -ArgumentList 'pubkey' -RedirectStandardInput $keyFile -RedirectStandardOutput $pubOut -NoNewWindow -Wait
  $pub = (Get-Content $pubOut -Raw).Trim()
  Remove-Item $pubOut -Force -ErrorAction SilentlyContinue
  if ($pub -notmatch '^[A-Za-z0-9+/]{43}=$') { throw "Couldn't work out this PC's VPN public key." }
  Set-Content -Path (Join-Path $GgVpnDir 'public.key') -Value $pub -Encoding ASCII
  $lines = @('[Interface]', "PrivateKey = $priv", "Address = $($Vpn.address)/32")
  if (@($Vpn.dns).Count) { $lines += "DNS = $(@($Vpn.dns) -join ', ')" }
  $lines += @('', '[Peer]', "PublicKey = $($Vpn.serverPublicKey)", "AllowedIPs = $(@($Vpn.routes) -join ', ')", "Endpoint = $($Vpn.endpoint)", 'PersistentKeepalive = 25')
  $conf = Join-Path $GgVpnDir "$GgVpnTunnel.conf"
  Set-Content -Path $conf -Value ($lines -join "`r`n") -Encoding ASCII
  if (Get-Service "WireGuardTunnel`$$GgVpnTunnel" -ErrorAction SilentlyContinue) { $null = Invoke-Process $exe @('/uninstalltunnelservice', $GgVpnTunnel) 120; Start-Sleep 3 }
  $r = Invoke-Process $exe @('/installtunnelservice', "`"$conf`"") 180
  if ($r.exitCode -ne 0) { throw "Couldn't start the VPN tunnel: $($r.output)" }
  for ($i = 0; $i -lt 15 -and -not ((Get-Service "WireGuardTunnel`$$GgVpnTunnel" -ErrorAction SilentlyContinue).Status -eq 'Running'); $i++) { Start-Sleep 2 }
  return "Set up the Go-Green VPN as $($Vpn.address). It connects within about a minute, once the VPN server picks up this PC, and stays on all the time."
}
function Disconnect-GoGreenVpn {
  $exe = Find-WireGuard
  if ($exe -and (Get-Service "WireGuardTunnel`$$GgVpnTunnel" -ErrorAction SilentlyContinue)) {
    $r = Invoke-Process $exe @('/uninstalltunnelservice', $GgVpnTunnel) 120
    if ($r.exitCode -ne 0) { throw "Couldn't stop the VPN tunnel: $($r.output)" }
  }
  Remove-Item (Join-Path $GgVpnDir "$GgVpnTunnel.conf") -Force -ErrorAction SilentlyContinue
  return 'Disconnected from the Go-Green VPN and removed the tunnel. WireGuard is still installed.'
}

function Get-Security {
  $s = [ordered]@{ encrypted = $null; avOn = $null; fwOn = $null; defsAgeDays = $null; screenLockMin = $null; usbBlocked = $null; pendingReboot = $false; localAdmins = $null; remoteOn = $null }
  try {
    $v = Get-CimInstance -Namespace 'root\cimv2\Security\MicrosoftVolumeEncryption' -ClassName Win32_EncryptableVolume -Filter "DriveLetter='$env:SystemDrive'" -ErrorAction Stop
    $s.encrypted = [bool]($v -and [int]$v.ProtectionStatus -eq 1)
  } catch { }
  try {
    $mp = Get-MpComputerStatus -ErrorAction Stop
    $s.avOn = [bool]$mp.RealTimeProtectionEnabled
    $s.defsAgeDays = [int]$mp.AntivirusSignatureAge
  } catch {
    try {
      $av = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop)
      if ($av.Count) { $s.avOn = [bool](@($av | Where-Object { (([int]$_.productState -shr 12) -band 0xF) -eq 1 }).Count) }
    } catch { }
  }
  try { $s.fwOn = -not @(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction Stop | Where-Object { "$($_.Enabled)" -ne 'True' }).Count } catch { }
  $t = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name InactivityTimeoutSecs -ErrorAction SilentlyContinue).InactivityTimeoutSecs
  $s.screenLockMin = if ($t) { [math]::Ceiling($t / 60) } else { 0 }
  $usb = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\USBSTOR' -Name Start -ErrorAction SilentlyContinue).Start
  $s.usbBlocked = ($usb -eq 4)
  $s.pendingReboot = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired')
  try { $s.localAdmins = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | ForEach-Object { "$($_.Name)" }) } catch {
    try {
      $name = (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')).Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]
      $g = [ADSI]"WinNT://$env:COMPUTERNAME/$name,group"
      $s.localAdmins = @($g.psbase.Invoke('Members') | ForEach-Object { $_.GetType().InvokeMember('Name', 'GetProperty', $null, $_, $null) })
    } catch { }
  }
  $s.remoteOn = Get-RemoteOn
  return $s
}

# ---------------------------------------------------------------- disk encryption (BitLocker)
$BlNs = 'root\cimv2\Security\MicrosoftVolumeEncryption'
function Get-SystemVolume { Get-CimInstance -Namespace $BlNs -ClassName Win32_EncryptableVolume -Filter "DriveLetter='$env:SystemDrive'" -ErrorAction Stop }
$BlMethods = @{ 0 = 'None'; 1 = 'AES 128 + Diffuser'; 2 = 'AES 256 + Diffuser'; 3 = 'AES 128'; 4 = 'AES 256'; 5 = 'Hardware'; 6 = 'XTS-AES 128'; 7 = 'XTS-AES 256' }
$BlProtectors = @{ 1 = 'TPM'; 2 = 'Startup key'; 3 = 'Recovery password'; 4 = 'TPM and PIN'; 5 = 'TPM and startup key'; 6 = 'TPM, PIN and startup key'; 7 = 'Public key'; 8 = 'Passphrase'; 9 = 'TPM certificate'; 10 = 'Active Directory account' }
function Get-BlProtectors($Volume) {
  $ids = @((Invoke-CimMethod -InputObject $Volume -MethodName GetKeyProtectors -Arguments @{ KeyProtectorType = [uint32]0 }).VolumeKeyProtectorID)
  foreach ($id in $ids) { if ($id) { @{ id = $id; type = [int](Invoke-CimMethod -InputObject $Volume -MethodName GetKeyProtectorType -Arguments @{ VolumeKeyProtectorID = $id }).KeyProtectorType } } }
}
function Get-Encryption {
  $e = [ordered]@{ kind = 'BitLocker'; status = $null; percent = $null; method = $null; protectors = @(); available = $false; note = $null }
  try { $v = Get-SystemVolume } catch { $v = $null }
  if (-not $v) { $e.note = "BitLocker isn't available on this edition of Windows"; return $e }
  $e.available = $true
  try {
    $cs = Invoke-CimMethod -InputObject $v -MethodName GetConversionStatus
    $e.percent = [int]$cs.EncryptionPercentage
    $e.status = switch ([int]$cs.ConversionStatus) {
      0 { 'off' } 1 { if ([int]$v.ProtectionStatus -eq 1) { 'on' } else { 'suspended' } } 2 { 'encrypting' } 3 { 'decrypting' } default { 'paused' }
    }
    $m = [int](Invoke-CimMethod -InputObject $v -MethodName GetEncryptionMethod).EncryptionMethod
    if ($m) { $e.method = $BlMethods[$m] }
    $e.protectors = @(Get-BlProtectors $v | ForEach-Object { $BlProtectors[$_.type] } | Where-Object { $_ } | Select-Object -Unique)
  } catch { $e.note = $_.Exception.Message }
  return $e
}
# Sends the system drive's recovery password to the Device Manager. Only called when the agent turns
# BitLocker on, so an admin can unlock the PC if it ever asks for its recovery key.
function Send-RecoveryKeys {
  $v = Get-SystemVolume
  $keys = @(Get-BlProtectors $v | Where-Object { $_.type -eq 3 } | ForEach-Object {
    $pw = (Invoke-CimMethod -InputObject $v -MethodName GetKeyProtectorNumericalPassword -Arguments @{ VolumeKeyProtectorID = $_.id }).NumericalPassword
    if ($pw) { @{ kind = 'BitLocker'; keyId = "$($_.id)"; volume = $env:SystemDrive; password = "$pw" } } })
  if (-not $keys.Count) { return $false }
  try { Invoke-Api 'POST' '/api/agent/escrow' @{ deviceId = $script:Config.deviceId; keys = $keys } | Out-Null; return $true }
  catch { Write-Log "Couldn't save the recovery key: $($_.Exception.Message)" 'warn'; return $false }
}
function Test-BlResult($r, [string]$What) {
  if ([uint32]$r.ReturnValue -ne 0) { throw ("$What failed (0x{0:X8})" -f [uint32]$r.ReturnValue) }
}
function Enable-DiskEncryption {
  try { $v = Get-SystemVolume } catch { $v = $null }
  if (-not $v) { throw "BitLocker isn't available on this edition of Windows. Windows Home has Device Encryption instead, which Windows turns on itself when someone signs in with a Microsoft account." }
  $cs = Invoke-CimMethod -InputObject $v -MethodName GetConversionStatus
  if ([int]$cs.ConversionStatus -eq 1 -and [int]$v.ProtectionStatus -eq 1) { return "BitLocker is already on for $env:SystemDrive." }
  if ([int]$cs.ConversionStatus -eq 1) {
    Test-BlResult (Invoke-CimMethod -InputObject $v -MethodName EnableKeyProtectors) 'Resuming BitLocker'
    return "BitLocker protection resumed on $env:SystemDrive."
  }
  $tpm = Get-CimInstance -Namespace 'root\cimv2\Security\MicrosoftTpm' -ClassName Win32_Tpm -ErrorAction SilentlyContinue
  if (-not $tpm -or -not (Invoke-CimMethod -InputObject $tpm -MethodName IsReady).IsReady) { throw 'This PC has no TPM ready for BitLocker. Turn the TPM on in the firmware (BIOS/UEFI) settings, then try again.' }
  $prot = @(Get-BlProtectors $v)
  if (-not ($prot | Where-Object { @(1, 4, 5, 6) -contains $_.type })) { Test-BlResult (Invoke-CimMethod -InputObject $v -MethodName ProtectKeyWithTPM -Arguments @{ FriendlyName = 'Go-Green Device Manager' }) 'Adding the TPM protector' }
  if (-not ($prot | Where-Object { $_.type -eq 3 })) { Test-BlResult (Invoke-CimMethod -InputObject $v -MethodName ProtectKeyWithNumericalPassword -Arguments @{ FriendlyName = 'Go-Green Device Manager' }) 'Adding a recovery password' }
  # The recovery key must be safely saved before any data is encrypted.
  if (-not (Send-RecoveryKeys)) { throw "Couldn't save the recovery key to the Device Manager, so encryption wasn't started. Try again." }
  Test-BlResult (Invoke-CimMethod -InputObject $v -MethodName Encrypt -Arguments @{ EncryptionMethod = [uint32]7; EncryptionFlags = [uint32]1 }) 'Starting encryption'
  return "BitLocker is encrypting $env:SystemDrive (XTS-AES 256, used space only). The PC stays usable while it runs. The recovery key is saved in the Device Manager."
}
function Disable-DiskEncryption {
  try { $v = Get-SystemVolume } catch { $v = $null }
  if (-not $v) { return "BitLocker isn't available on this edition of Windows, so there's nothing to turn off." }
  $cs = Invoke-CimMethod -InputObject $v -MethodName GetConversionStatus
  if ([int]$cs.ConversionStatus -eq 0) { return "BitLocker is already off for $env:SystemDrive." }
  Test-BlResult (Invoke-CimMethod -InputObject $v -MethodName Decrypt) 'Starting decryption'
  return "BitLocker is decrypting $env:SystemDrive. The PC stays usable while it runs."
}

# ---------------------------------------------------------------- local update server (WSUS)
# On the Windows Server chosen in the Device Manager, the agent installs and configures WSUS, which
# synchronizes with Microsoft Update (its upstream), downloads approved updates and serves them to
# PCs on the network. PCs in the chosen collection get Windows Update pointed at it.
$WsusSetupKey = 'HKLM:\SOFTWARE\Microsoft\Update Services\Server\Setup'
$script:WsusFull = $false
function Get-WsusApi {
  Import-Module UpdateServices -ErrorAction Stop
  return Get-WsusServer -ErrorAction Stop
}
function Get-WsusInfo {
  if (-not (Get-Service WsusService -ErrorAction SilentlyContinue)) { return $null }
  $info = [ordered]@{ installed = $true; port = $null; lastSync = $null; lastSyncResult = $null; syncing = $null; nextSync = $null; freeGB = $null; contentDir = $null; computers = $null; error = $null }
  try {
    $setup = Get-ItemProperty $WsusSetupKey -ErrorAction SilentlyContinue
    $info.port = if ($setup.PortNumber) { [int]$setup.PortNumber } else { 8530 }
    $info.contentDir = "$($setup.ContentDir)"
    if ($setup.ContentDir) {
      $d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$(([IO.Path]::GetPathRoot($setup.ContentDir)).TrimEnd('\'))'"
      if ($d) { $info.freeGB = [math]::Round($d.FreeSpace / 1GB) }
    }
    $w = Get-WsusApi
    $sub = $w.GetSubscription()
    $last = $sub.GetLastSynchronizationInfo()
    if ($last) { $info.lastSync = Iso $last.EndTime.ToLocalTime(); $info.lastSyncResult = "$($last.Result)" }
    $info.syncing = ("$($sub.GetSynchronizationStatus())" -ne 'NotProcessing')
    if ($sub.SynchronizeAutomatically) { $info.nextSync = Iso $sub.GetNextSynchronizationTime().ToLocalTime() }
    # While a sync runs, WSUS can be too busy to answer these within the timeout; that isn't a fault.
    try {
      $info.computers = [int]$w.GetStatus().ComputerTargetCount
      if ($script:WsusFull) { $info.updates = @(Get-WsusNeeded $w) }
    } catch { if (-not $info.syncing) { throw } }
  } catch { $info.error = $_.Exception.Message }
  return $info
}
# The updates PCs reporting to this server still need, most-needed first.
function Get-WsusNeeded($W) {
  $us = New-Object Microsoft.UpdateServices.Administration.UpdateScope
  $cs = New-Object Microsoft.UpdateServices.Administration.ComputerTargetScope
  $sums = @($W.GetSummariesPerUpdate($us, $cs) | Where-Object { ($_.NotInstalledCount + $_.DownloadedCount + $_.FailedCount) -gt 0 } |
    Sort-Object { $_.NotInstalledCount + $_.DownloadedCount + $_.FailedCount } -Descending | Select-Object -First 150)
  foreach ($s in $sums) {
    try {
      $u = $W.GetUpdate((New-Object Microsoft.UpdateServices.Administration.UpdateRevisionId($s.UpdateId)))
      $kb = if ($u.KnowledgebaseArticles.Count) { 'KB' + $u.KnowledgebaseArticles[0] } else { $null }
      [ordered]@{ id = "$($s.UpdateId)"; kb = $kb; title = "$($u.Title)"; classification = "$($u.UpdateClassificationTitle)"; severity = $(if ("$($u.MsrcSeverity)" -in @('Critical', 'Important', 'Moderate', 'Low')) { "$($u.MsrcSeverity)" } else { $null })
        released = Iso $u.CreationDate; needed = [int]($s.NotInstalledCount + $s.DownloadedCount + $s.FailedCount); installed = [int]$s.InstalledCount; approved = [bool]$u.IsApproved; declined = [bool]$u.IsDeclined }
    } catch { }
  }
}
function Test-WsusPostInstall($Dir) {
  $cur = "$((Get-ItemProperty $WsusSetupKey -ErrorAction SilentlyContinue).ContentDir)".TrimEnd('\')
  try { $w = Get-WsusApi; [void]$w.GetConfiguration() } catch { Write-Log "WSUS not answering yet: $($_.Exception.Message)"; return $true }
  if ($cur -and $cur -ne $Dir.TrimEnd('\') -and -not $w.GetSubscription().GetLastSynchronizationInfo()) { return $true }
  return $false
}
function Wait-WsusSync($Sub, $Minutes) {
  $until = (Get-Date).AddMinutes($Minutes)
  while ("$($Sub.GetSynchronizationStatus())" -ne 'NotProcessing' -and (Get-Date) -lt $until) { Start-Sleep -Seconds 20 }
}
function Install-WsusServer($Cfg) {
  if (-not $Cfg) { throw 'No update server settings were sent. Save them on Software updates, Local update server tab, first.' }
  if ((Get-CimInstance Win32_OperatingSystem).ProductType -eq 1) { throw 'WSUS runs on Windows Server only.' }
  if (-not (Get-WindowsFeature UpdateServices).Installed) {
    Write-Log 'Installing the WSUS role'
    $r = Install-WindowsFeature -Name UpdateServices -IncludeManagementTools
    if (-not $r.Success) { throw "Installing the WSUS role failed: $($r.ExitCode)" }
  }
  $dir = "$($Cfg.contentDir)"
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  # Installing the role already writes a default ContentDir, so that value doesn't mean post-install ran.
  # Run it when the WSUS service doesn't answer yet, or when it has never synced and keeps updates elsewhere.
  if (Test-WsusPostInstall $dir) {
    Write-Log "Running WSUS post-install (updates kept in $dir)"
    $p = Invoke-Process "$env:ProgramFiles\Update Services\Tools\wsusutil.exe" @('postinstall', "CONTENT_DIR=`"$dir`"") 3600
    if ($p.exitCode -ne 0) { throw "WSUS post-install failed ($($p.exitCode)): $(("$($p.output)" -split "`n" | Select-Object -Last 3) -join ' ')" }
  }
  $w = Get-WsusApi
  Set-WsusServerSynchronization -UpdateServer $w -SyncFromMU | Out-Null
  $c = $w.GetConfiguration()
  $c.AllUpdateLanguagesEnabled = $false
  $c.SetEnabledUpdateLanguages([string[]]@($Cfg.languages))
  $c.Save()
  $sub = $w.GetSubscription()
  # Let a sync that is already running finish, then make sure Microsoft's product list is here before
  # choosing products (fetch it with a category-only sync, trying again once if it was cancelled).
  Wait-WsusSync $sub 45
  $tries = 0
  while ($tries -lt 2 -and -not @($w.GetUpdateCategories() | Where-Object { @($Cfg.products) -contains $_.Title }).Count) {
    $tries++
    Write-Log 'Getting the product list from Microsoft Update'
    $sub.StartSynchronizationForCategoryOnly()
    Start-Sleep -Seconds 20
    Wait-WsusSync $sub 45
  }
  $cats = New-Object Microsoft.UpdateServices.Administration.UpdateCategoryCollection
  $found = @()
  foreach ($p in $w.GetUpdateCategories()) { if (@($Cfg.products) -contains $p.Title) { [void]$cats.Add($p); $found += $p.Title } }
  if (-not $found.Count) {
    $last = $sub.GetLastSynchronizationInfo()
    throw "Microsoft Update hasn't sent its product list yet (last sync: $(if ($last) { "$($last.Result)" } else { 'none' })). Check the server can reach Microsoft Update, then select Apply settings again."
  }
  $sub.SetUpdateCategories($cats)
  $cls = New-Object Microsoft.UpdateServices.Administration.UpdateClassificationCollection
  foreach ($k in $w.GetUpdateClassifications()) { if (@($Cfg.classifications) -contains $k.Title) { [void]$cls.Add($k) } }
  $sub.SetUpdateClassifications($cls)
  # Sync once a day at the chosen local time (WSUS keeps the time in UTC).
  $t = [TimeSpan]::Parse("$($Cfg.syncTime)") - [TimeZoneInfo]::Local.GetUtcOffset((Get-Date))
  if ($t.TotalHours -lt 0) { $t = $t.Add([TimeSpan]::FromDays(1)) } elseif ($t.TotalHours -ge 24) { $t = $t.Subtract([TimeSpan]::FromDays(1)) }
  $sub.SynchronizeAutomatically = $true
  $sub.SynchronizeAutomaticallyTimeOfDay = $t
  $sub.NumberOfSynchronizationsPerDay = 1
  $sub.Save()
  $port = [int]$Cfg.port; if (-not $port) { $port = 8530 }
  if (-not (Get-NetFirewallRule -Name 'GGT-WSUS' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'GGT-WSUS' -DisplayName 'Go-Green update server (WSUS)' -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow | Out-Null
  }
  $sub.StartSynchronization()
  $script:State.wsusForce = $true
  $missing = @(@($Cfg.products) | Where-Object { $found -notcontains $_ })
  $note = if ($missing.Count) { " Microsoft Update has no product called: $($missing -join ', ')." } else { '' }
  return "WSUS is set up on $env:COMPUTERNAME (port $port, updates kept in $dir) and is synchronizing with Microsoft Update. The first sync takes 30-90 minutes; then it syncs daily at $($Cfg.syncTime).$note"
}
function Start-WsusSync {
  $sub = (Get-WsusApi).GetSubscription()
  if ("$($sub.GetSynchronizationStatus())" -ne 'NotProcessing') { return 'A synchronization is already running.' }
  $sub.StartSynchronization()
  $script:State.wsusForce = $true
  return 'Synchronizing with Microsoft Update. New updates show here when it finishes.'
}
# Approved updates are downloaded from Microsoft by the server, then installed by the PCs that need them.
function Set-WsusApproval($Ids, [bool]$Approve) {
  $w = Get-WsusApi
  $all = $w.GetComputerTargetGroups() | Where-Object { $_.Name -eq 'All Computers' } | Select-Object -First 1
  $n = 0; $errs = @()
  foreach ($id in @($Ids)) {
    try {
      $u = $w.GetUpdate((New-Object Microsoft.UpdateServices.Administration.UpdateRevisionId([guid]$id)))
      if ($Approve) {
        if ($u.RequiresLicenseAgreementAcceptance) { $u.AcceptLicenseAgreement() }
        [void]$u.Approve([Microsoft.UpdateServices.Administration.UpdateApprovalAction]::Install, $all)
      } else { $u.Decline() }
      $n++
    } catch { $errs += "${id}: $($_.Exception.Message)" }
  }
  $script:State.wsusForce = $true
  $msg = if ($Approve) { "Approved $n update(s). The server downloads them from Microsoft, then PCs install them at their next update check." } else { "Declined $n update(s)." }
  if ($errs.Count) { throw "$msg Failed: $($errs -join '; ')" }
  return $msg
}

# PCs: point Windows Update at the local server, or undo it when the Device Manager stops doing so.
$WuKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate'
function Get-WuServer {
  $p = Get-ItemProperty $WuKey -ErrorAction SilentlyContinue
  $use = (Get-ItemProperty "$WuKey\AU" -Name UseWUServer -ErrorAction SilentlyContinue).UseWUServer
  if ($p.WUServer -and $use -eq 1) { return "$($p.WUServer)" }
  return $null
}
function Set-WuClient([string]$Url, $State) {
  if ($Url) {
    if ((Get-WuServer) -eq $Url) { $State.wuSetByAgent = $true; return $null }
    if (-not (Test-Path "$WuKey\AU")) { New-Item -Path "$WuKey\AU" -Force | Out-Null }
    Set-ItemProperty $WuKey -Name WUServer -Value $Url
    Set-ItemProperty $WuKey -Name WUStatusServer -Value $Url
    New-ItemProperty "$WuKey\AU" -Name UseWUServer -Value 1 -PropertyType DWord -Force | Out-Null
    $State.wuSetByAgent = $true
    return "Windows Update now uses the local update server $Url"
  }
  if ($State.wuSetByAgent) {
    Remove-ItemProperty $WuKey -Name WUServer, WUStatusServer -ErrorAction SilentlyContinue
    Remove-ItemProperty "$WuKey\AU" -Name UseWUServer -ErrorAction SilentlyContinue
    $State.wuSetByAgent = $false
    return 'Windows Update uses Microsoft Update directly again'
  }
  return $null
}

# ---------------------------------------------------------------- remote desktop
$TsKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server'
function Get-RemoteOn {
  try { return ((Get-ItemProperty $TsKey -Name fDenyTSConnections -ErrorAction Stop).fDenyTSConnections -eq 0) } catch { return $null }
}
function Set-RemoteDesktop([bool]$On) {
  $os = Get-CimInstance Win32_OperatingSystem
  if ($On -and $os.ProductType -eq 1 -and $os.Caption -match 'Home') { throw "$(($os.Caption -replace '^Microsoft\s+', '').Trim()) can't accept Remote Desktop connections. It needs Windows Pro, Enterprise or Server." }
  Set-ItemProperty $TsKey -Name fDenyTSConnections -Value ([int](-not $On)) -Type DWord
  if ($On) { Set-ItemProperty "$TsKey\WinStations\RDP-Tcp" -Name UserAuthentication -Value 1 -Type DWord }
  $enable = if ($On) { 'yes' } else { 'no' }
  try {
    if ($On) { Enable-NetFirewallRule -Group '@FirewallAPI.dll,-28752' -ErrorAction Stop } else { Disable-NetFirewallRule -Group '@FirewallAPI.dll,-28752' -ErrorAction Stop }
  } catch { & netsh.exe advfirewall firewall set rule group="remote desktop" new enable=$enable | Out-Null }
  if ($On) { Set-Service TermService -StartupType Manual -ErrorAction SilentlyContinue; Start-Service TermService -ErrorAction SilentlyContinue }
  if ((Get-RemoteOn) -ne $On) { throw 'Windows did not accept the change. A Group Policy may control Remote Desktop on this PC.' }
  if (-not $On) { return 'Remote Desktop is off.' }
  $port = (Get-ItemProperty "$TsKey\WinStations\RDP-Tcp" -Name PortNumber -ErrorAction SilentlyContinue).PortNumber
  return "Remote Desktop is on (port $port, Network Level Authentication required). Sign in with a Windows account that is an administrator or in the Remote Desktop Users group."
}

function Get-Software {
  $paths = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'Registry::HKEY_USERS\*\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $seen = @{}
  foreach ($p in $paths) {
    foreach ($e in @(Get-ItemProperty $p -ErrorAction SilentlyContinue)) {
      if (-not $e.DisplayName -or $e.SystemComponent -eq 1 -or $e.ParentKeyName) { continue }
      $key = "$($e.DisplayName)|$($e.DisplayVersion)"
      if (-not $seen.ContainsKey($key)) {
        $seen[$key] = [ordered]@{ name = "$($e.DisplayName)".Trim(); version = "$($e.DisplayVersion)"; publisher = "$($e.Publisher)"; uninstall = "$($e.QuietUninstallString)"; uninstallString = "$($e.UninstallString)" }
      }
    }
  }
  return @($seen.Values | Sort-Object { $_.name })
}
function Test-Detected($DetectName, $Software) {
  if (-not $DetectName) { return $false }
  return [bool](@($Software | Where-Object { $_.name -like "*$DetectName*" }).Count)
}

# ---------------------------------------------------------------- Windows Update
function Convert-Update($u) {
  $kb = if ($u.KBArticleIDs.Count -gt 0) { 'KB' + $u.KBArticleIDs.Item(0) } else { $null }
  $class = $null; $product = $null
  foreach ($c in $u.Categories) { if ($c.Type -eq 'UpdateClassification' -and -not $class) { $class = $c.Name } elseif ($c.Type -eq 'Product' -and -not $product) { $product = $c.Name } }
  $sev = "$($u.MsrcSeverity)"
  if (-not $sev) { $sev = switch ($class) { 'Security Updates' { 'Important' } 'Critical Updates' { 'Important' } 'Definition Updates' { 'Moderate' } default { 'Low' } } }
  $id = if ($kb) { $kb } else { "$($u.Identity.UpdateID)" }
  return [ordered]@{
    id = $id; kb = if ($kb) { $kb } else { $id }; title = "$($u.Title)"; classification = $class; product = $product; severity = $sev
    sizeMB = [math]::Round($u.MaxDownloadSize / 1MB); reboot = ($u.InstallationBehavior.RebootBehavior -ne 0); released = Iso $u.LastDeploymentChangeTime
  }
}
function Get-UpdateScan {
  $session = New-Object -ComObject Microsoft.Update.Session
  $result = $session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
  $missing = @(); foreach ($u in $result.Updates) { $missing += Convert-Update $u }
  $installed = @(Get-HotFix -ErrorAction SilentlyContinue | Where-Object { $_.HotFixID -match '^KB\d+' } | ForEach-Object {
    $when = $null; try { $when = Iso $_.InstalledOn } catch { }
    [ordered]@{ id = $_.HotFixID; kb = $_.HotFixID; title = "$($_.Description) $($_.HotFixID)"; installedAt = $when } })
  return [ordered]@{ scannedAt = Iso (Get-Date); missing = $missing; installed = $installed }
}
function Install-Updates($Ids) {
  $session = New-Object -ComObject Microsoft.Update.Session
  $result = $session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
  $coll = New-Object -ComObject Microsoft.Update.UpdateColl
  foreach ($u in $result.Updates) {
    if ($Ids -contains (Convert-Update $u).id) { if (-not $u.EulaAccepted) { $u.AcceptEula() }; [void]$coll.Add($u) }
  }
  if ($coll.Count -eq 0) { return @{ ok = $true; reboot = $false; message = 'Already installed' } }
  $dl = $session.CreateUpdateDownloader(); $dl.Updates = $coll; [void]$dl.Download()
  $inst = $session.CreateUpdateInstaller(); $inst.Updates = $coll
  $r = $inst.Install()
  $ok = ($r.ResultCode -eq 2 -or $r.ResultCode -eq 3)
  return @{ ok = $ok; reboot = [bool]$r.RebootRequired; code = ('0x{0:X8}' -f $r.HResult); message = "Installed $($coll.Count) update(s), result code $($r.ResultCode)" }
}

# ---------------------------------------------------------------- running things
function Invoke-Process([string]$File, [string[]]$Arguments, [int]$TimeoutSec = 3600) {
  $out = Join-Path $env:TEMP ("ggt-" + [guid]::NewGuid() + '.out')
  $err = "$out.err"
  $sp = @{ FilePath = $File; PassThru = $true; NoNewWindow = $true; RedirectStandardOutput = $out; RedirectStandardError = $err }
  if ($Arguments -and $Arguments.Count) { $sp.ArgumentList = $Arguments }
  $p = Start-Process @sp
  $null = $p.Handle # keeps ExitCode available after the process ends
  $timedOut = -not $p.WaitForExit($TimeoutSec * 1000)
  if ($timedOut) { try { $p.Kill() } catch { } }
  $text = ''
  foreach ($f in @($out, $err)) { if (Test-Path $f) { $text += (Get-Content $f -Raw -ErrorAction SilentlyContinue); Remove-Item $f -Force -ErrorAction SilentlyContinue } }
  if ($text.Length -gt 60000) { $text = $text.Substring(0, 60000) + "`n…(output cut at 60 KB)" }
  return @{ exitCode = if ($timedOut) { -1 } else { $p.ExitCode }; output = "$text".TrimEnd(); timedOut = $timedOut }
}
function Invoke-PowerShellText([string]$Body, [int]$TimeoutSec = 600) {
  $file = Join-Path $env:TEMP ("ggt-" + [guid]::NewGuid() + '.ps1')
  Set-Content -Path $file -Value $Body -Encoding UTF8
  try { return Invoke-Process 'powershell.exe' @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$file`"") $TimeoutSec }
  finally { Remove-Item $file -Force -ErrorAction SilentlyContinue }
}
function Find-Winget {
  $w = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($w) { return $w.Source }
  $p = @(Resolve-Path "$env:ProgramFiles\WindowsApps\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe\winget.exe" -ErrorAction SilentlyContinue | Sort-Object { $_.Path })
  if ($p.Count) { return $p[-1].Path }
  return $null
}
$OkExit = @(0, 3010, 1641, -1978335189, -1978335135) # success, reboot needed, already installed (winget)

function Install-App($Dep, $Software) {
  $a = $Dep.app
  $uninstall = ($Dep.action -eq 'Uninstall')
  if ($uninstall) {
    if ($a.uninstall) { $r = Invoke-PowerShellText $a.uninstall 3600 }
    elseif ($a.wingetId) {
      $w = Find-Winget; if (-not $w) { return @{ ok = $false; code = 'WINGET'; message = 'winget not found' } }
      $r = Invoke-Process $w @('uninstall', '--id', $a.wingetId, '--exact', '--silent', '--accept-source-agreements', '--disable-interactivity')
    } else {
      $e = @($Software | Where-Object { $_.name -like "*$($a.detectName)*" })[0]
      if (-not $e) { return @{ ok = $true; message = 'Not installed' } }
      if ($e.uninstallString -match '\{[0-9A-Fa-f-]{36}\}' -and $e.uninstallString -match 'msiexec') { $r = Invoke-Process 'msiexec.exe' @('/x', $Matches[0], '/qn', '/norestart') }
      elseif ($e.uninstall) { $r = Invoke-Process 'cmd.exe' @('/c', $e.uninstall) }
      else { return @{ ok = $false; code = 'NO_METHOD'; message = 'No silent uninstall found. Add an uninstall command in the software library.' } }
    }
  } elseif ($a.wingetId) {
    $w = Find-Winget; if (-not $w) { return @{ ok = $false; code = 'WINGET'; message = 'winget not found on this device' } }
    $base = @('install', '--id', $a.wingetId, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
    $r = Invoke-Process $w ($base + @('--scope', 'machine'))
    if ($OkExit -notcontains $r.exitCode) { $r = Invoke-Process $w $base }
  } elseif ($a.url) {
    $cache = Join-Path $AgentDir 'Cache'
    if (-not (Test-Path $cache)) { New-Item -ItemType Directory -Path $cache -Force | Out-Null }
    $leaf = ([uri]$a.url).Segments[-1]; if (-not $leaf -or $leaf -eq '/') { $leaf = 'installer.exe' }
    $file = Join-Path $cache ([IO.Path]::GetFileName([uri]::UnescapeDataString($leaf)))
    try { Invoke-WebRequest -Uri $a.url -OutFile $file -UseBasicParsing -TimeoutSec 3600 } catch { return @{ ok = $false; code = 'DOWNLOAD'; message = $_.Exception.Message } }
    if ($a.sha256 -and (Get-FileHash $file -Algorithm SHA256).Hash -ne $a.sha256.ToUpper()) { Remove-Item $file -Force; return @{ ok = $false; code = 'HASH'; message = 'SHA-256 mismatch' } }
    if ($file -match '\.msi$') { $r = Invoke-Process 'msiexec.exe' (@('/i', "`"$file`"", '/qn', '/norestart') + @(if ($a.args) { $a.args })) }
    else { $r = Invoke-Process $file @(if ($a.args) { $a.args }) }
    Remove-Item $file -Force -ErrorAction SilentlyContinue
  } elseif ($a.command) {
    $r = Invoke-PowerShellText $a.command 3600
  } else { return @{ ok = $false; code = 'NO_METHOD'; message = 'No Windows install method' } }
  if ($r.timedOut) { return @{ ok = $false; code = 'TIMEOUT'; message = 'Timed out' } }
  $ok = $OkExit -contains $r.exitCode
  $msg = if ($ok) { "Exit code $($r.exitCode)" } else { "Exit code $($r.exitCode). " + ("$($r.output)" -split "`n" | Select-Object -Last 3) -join ' ' }
  return @{ ok = $ok; code = if ($ok) { $null } else { "$($r.exitCode)" }; reboot = ($r.exitCode -eq 3010 -or $r.exitCode -eq 1641); message = $msg }
}

function Invoke-Remediation($Ids, $Settings, $Sec) {
  $done = @()
  $try = { param($label, $sb) try { & $sb; $script:remediated += $label } catch { $script:remediateErrors += "${label}: $($_.Exception.Message)" } }
  $script:remediated = @(); $script:remediateErrors = @()
  if ($Ids -contains 'fw' -and $Sec.fwOn -eq $false) { & $try 'Turned the firewall on' { Set-NetFirewallProfile -Profile Domain, Public, Private -Enabled True } }
  if ($Ids -contains 'av' -and $Sec.avOn -eq $false) { & $try 'Turned antivirus real-time protection on' { Set-MpPreference -DisableRealtimeMonitoring $false } }
  if ($Ids -contains 'defs' -and $Sec.defsAgeDays -ge 3) { & $try 'Updated antivirus definitions' { Update-MpSignature } }
  $lock = if ($Settings.screenLockMin) { [int]$Settings.screenLockMin } else { 10 }
  if ($Ids -contains 'lock' -and ($Sec.screenLockMin -eq 0 -or $Sec.screenLockMin -gt $lock)) {
    & $try "Set screen lock to $lock minutes" { New-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name InactivityTimeoutSecs -Value ($lock * 60) -PropertyType DWord -Force | Out-Null }
  }
  if ($Ids -contains 'usb' -and $Sec.usbBlocked -eq $false) { & $try 'Blocked USB storage' { Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\USBSTOR' -Name Start -Value 4 } }
  return @{ done = $script:remediated; errors = $script:remediateErrors }
}

function Request-Restart([string]$Why = 'to finish installing updates') {
  if ($script:restartRequested) { return }
  $script:restartRequested = $true
  Write-Log "Restarting in 5 minutes $Why"
  & shutdown.exe /r /t 300 /c "Go-Green IT: this computer restarts in 5 minutes $Why. Save your work." /d p:2:17 | Out-Null
}

# ---------------------------------------------------------------- Windows OS deployment
# Windows 11 hardware requirements the agent can check (the processor list isn't checked here;
# Windows setup checks it and the deployment shows its error code).
function Get-OsReadiness {
  $r = [ordered]@{ tpm = $null; secureBoot = $null; uefi = $null; arch = $null; diskFreeGB = $null }
  try {
    $t = Get-CimInstance -Namespace 'root\cimv2\Security\MicrosoftTpm' -ClassName Win32_Tpm -ErrorAction Stop
    $r.tpm = if ($t) { (("$(@($t)[0].SpecVersion)" -split ',')[0]).Trim() } else { '0' }
    if (-not $r.tpm) { $r.tpm = '0' }
  } catch { }
  $sb = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State' -ErrorAction SilentlyContinue
  if ($sb) { $r.uefi = $true; $r.secureBoot = ($sb.UEFISecureBootEnabled -eq 1) }
  else { try { $r.secureBoot = [bool](Confirm-SecureBootUEFI -ErrorAction Stop); $r.uefi = $true } catch [System.PlatformNotSupportedException] { $r.uefi = $false; $r.secureBoot = $false } catch { } }
  $a = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $r.arch = switch ($a) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } 'x86' { 'x86' } default { $null } }
  $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$env:SystemDrive'"
  if ($disk) { $r.diskFreeGB = [math]::Round($disk.FreeSpace / 1GB) }
  return $r
}
function Get-WindowsBuild { [int](Get-CimInstance Win32_OperatingSystem).BuildNumber }
function Get-BootMs { ([DateTimeOffset](Get-CimInstance Win32_OperatingSystem).LastBootUpTime).ToUnixTimeMilliseconds() }
function New-StepError([string]$Code, [string]$Message) { $e = New-Object Exception($Message); $e.Data['code'] = $Code; return $e }

# Problems that stop this PC running the task sequence, as text; none means ready.
function Test-OsReadiness($Step) {
  $p = @()
  $rd = Get-OsReadiness
  if ($Step.minFreeGB -and $null -ne $rd.diskFreeGB -and $rd.diskFreeGB -lt $Step.minFreeGB) { $p += "only $($rd.diskFreeGB) GB free on $env:SystemDrive (needs $($Step.minFreeGB) GB)" }
  if ($Step.win11) {
    $cs = Get-CimInstance Win32_ComputerSystem
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$env:SystemDrive'"
    if ($null -ne $rd.tpm -and [double]$rd.tpm -lt 2) { $p += $(if ($rd.tpm -eq '0') { 'no TPM (Windows 11 needs TPM 2.0; turn it on in the firmware settings if the PC has one)' } else { "TPM $($rd.tpm) (Windows 11 needs TPM 2.0)" }) }
    if ($rd.uefi -eq $false) { $p += 'starts in legacy BIOS mode (Windows 11 needs UEFI with Secure Boot)' }
    if ($cs.TotalPhysicalMemory -lt 3.8GB) { $p += "$([math]::Round($cs.TotalPhysicalMemory / 1GB, 1)) GB of memory (needs 4 GB)" }
    if ($disk -and $disk.Size -lt 60GB) { $p += "a $([math]::Round($disk.Size / 1GB)) GB system drive (needs 64 GB)" }
    if ($rd.arch -eq 'x86') { $p += '32-bit Windows (Windows 11 is 64-bit only)' }
  }
  return $p
}

function Suspend-OsBitLocker {
  $v = Get-CimInstance -Namespace 'root\cimv2\Security\MicrosoftVolumeEncryption' -ClassName Win32_EncryptableVolume -Filter "DriveLetter='$env:SystemDrive'" -ErrorAction SilentlyContinue
  if (-not $v -or $v.ProtectionStatus -ne 1) { return "BitLocker isn't protecting the system drive; nothing to suspend" }
  # Suspended for 3 restarts: an upgrade restarts the PC two or three times.
  $r = Invoke-CimMethod -InputObject $v -MethodName DisableKeyProtectors -Arguments @{ DisableCount = [uint32]3 }
  if ($r.ReturnValue -ne 0) { throw (New-StepError 'BITLOCKER' ("Couldn't suspend BitLocker (0x{0:X8})" -f $r.ReturnValue)) }
  return 'BitLocker suspended for 3 restarts'
}

# Gets the image onto this PC: an ISO from https or a network share (checked against its SHA-256),
# or Microsoft's Windows 11 Installation Assistant (checked by its Microsoft signature).
function Get-OsMedia($Image) {
  $dir = Join-Path $AgentDir 'Cache\OS'
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  if ($Image.source -eq 'assistant') {
    $file = Join-Path $dir 'Windows11InstallationAssistant.exe'
    try { Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/?linkid=2171764' -OutFile $file -UseBasicParsing -TimeoutSec 1800 } catch { throw (New-StepError 'DOWNLOAD' $_.Exception.Message) }
    Import-SecurityModule
    $sig = Get-AuthenticodeSignature $file
    if ($sig.Status -ne 'Valid' -or "$($sig.SignerCertificate.Subject)" -notmatch 'O=Microsoft Corporation') { Remove-Item $file -Force; throw (New-StepError 'HASH' "The Installation Assistant isn't signed by Microsoft") }
    return $file
  }
  $file = Join-Path $dir "$($Image.id).iso"
  $hashOk = { param($f) -not $Image.sha256 -or (Get-FileHash $f -Algorithm SHA256).Hash -eq "$($Image.sha256)".ToUpper() }
  if ((Test-Path $file) -and (& $hashOk $file)) { Write-Log 'Using the cached Windows image'; return $file }
  Remove-Item $file -Force -ErrorAction SilentlyContinue
  $free = (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$env:SystemDrive'").FreeSpace
  if ($free -lt 20GB) { throw (New-StepError '0x80070070' "Only $([math]::Round($free / 1GB)) GB free: the image and the upgrade need about 20 GB") }
  Write-Log "Downloading the Windows image from $($Image.url)"
  try {
    if ("$($Image.url)".StartsWith('\\')) { Copy-Item -LiteralPath $Image.url -Destination $file -Force }
    else { Invoke-WebRequest -Uri $Image.url -OutFile $file -UseBasicParsing -TimeoutSec 7200 }
  } catch { Remove-Item $file -Force -ErrorAction SilentlyContinue; throw (New-StepError 'DOWNLOAD' $_.Exception.Message) }
  if (-not (& $hashOk $file)) { Remove-Item $file -Force; throw (New-StepError 'HASH' "The Windows image didn't match its SHA-256") }
  return $file
}

# Runs Windows setup from the image as an in-place upgrade (apps, files and settings stay).
# Setup prepares everything while Windows runs, then finishes during the next restart.
function Invoke-OsUpgrade($Step) {
  $img = $Step.image
  $logs = Join-Path $AgentDir 'Logs\OSUpgrade'
  if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs -Force | Out-Null }
  $arch = (Get-OsReadiness).arch
  if ($img.architecture -and $arch -and $arch -ne $img.architecture) { throw (New-StepError 'ARCH' "This is an $arch PC and the image is $($img.architecture)") }
  $media = Get-OsMedia $img
  if ($img.source -eq 'assistant') {
    $r = Invoke-Process $media @('/QuietInstall', '/SkipEULA', '/auto', 'upgrade', '/NoRestartUI', '/copylogs', "`"$logs`"") 9000
    if ($r.timedOut) { throw (New-StepError 'TIMEOUT' "The Installation Assistant didn't finish within 2.5 hours") }
    if ($r.exitCode -ne 0) { throw (New-StepError ('0x{0:X8}' -f $r.exitCode) "The Installation Assistant stopped with exit code $('0x{0:X8}' -f $r.exitCode)") }
    return "The Windows 11 Installation Assistant is upgrading this PC and restarts it when it's ready"
  }
  $mount = Mount-DiskImage -ImagePath $media -PassThru
  try {
    $letter = ($mount | Get-Volume).DriveLetter
    $setup = if ($letter) { "$($letter):\setup.exe" } else { $null }
    if (-not $setup -or -not (Test-Path $setup)) { throw (New-StepError 'MEDIA' 'No setup.exe on the image. Use Windows installation media (an ISO from Microsoft or your volume licensing site).') }
    $sargs = @('/auto', 'upgrade', '/quiet', '/eula', 'accept', '/noreboot', '/dynamicupdate', $(if ($Step.dynamicUpdate) { 'enable' } else { 'disable' }), '/showoobe', 'none', '/telemetry', 'disable', '/bitlocker', 'alwayssuspend', '/copylogs', "`"$logs`"")
    if ($Step.ignoreCompat) { $sargs += @('/compat', 'ignorewarning') }
    Write-Log "Running Windows setup: $setup $($sargs -join ' ')"
    $r = Invoke-Process $setup $sargs 9000
  } finally { Dismount-DiskImage -ImagePath $media -ErrorAction SilentlyContinue | Out-Null }
  if ($r.timedOut) { throw (New-StepError 'TIMEOUT' "Windows setup didn't finish within 2.5 hours") }
  if (@(0, 3, 3010) -notcontains $r.exitCode) {
    $code = '0x{0:X8}' -f $r.exitCode
    throw (New-StepError $code "Windows setup stopped with $code. Its logs are in $logs. $(Get-SetupError)")
  }
  return 'Windows setup has prepared the upgrade. It finishes during the next restart (30-90 minutes).'
}
# The last lines of Windows setup's error log, to explain a failed or rolled-back upgrade.
function Get-SetupError {
  foreach ($f in @("$env:SystemDrive\`$WINDOWS.~BT\Sources\Panther\setuperr.log", "$env:SystemDrive\`$WINDOWS.~BT\Sources\Rollback\setuperr.log", "$env:WINDIR\Panther\setuperr.log")) {
    if (Test-Path -LiteralPath $f) { return ((Get-Content -LiteralPath $f -Tail 3 -ErrorAction SilentlyContinue) -join ' ') -replace '\s+', ' ' }
  }
  return ''
}

# Runs a task sequence one step at a time. Progress is kept in the agent's state, so a sequence
# carries on after the restarts its upgrade or restart steps need. Returns the deployment's new state.
function Invoke-TaskSequence($Dep, $Prev, $Software) {
  $ts = $Dep.taskSequence
  $steps = @($ts.steps)
  $n = $steps.Count
  $now = Now-Ms
  $build = Get-WindowsBuild
  $st = @{ state = 'inprogress'; step = [int]$Prev.step; at = $now; stagedAt = $Prev.stagedAt; targetBuild = $Prev.targetBuild }
  if ($ts.broken) { return @{ state = 'error'; code = 'TS_BROKEN'; message = "$($ts.broken). Edit the task sequence."; at = $now } }

  # Waiting for a restart that an upgrade or a restart step asked for.
  if ($Prev.state -eq 'staged' -or $Prev.state -eq 'restarting') {
    if ((Get-BootMs) -le [int64]$Prev.stagedAt) {
      # The deployment was changed to allow restarts after setup had prepared the upgrade.
      if ($Prev.state -eq 'staged' -and $Dep.restart -eq 'Allow' -and -not $Prev.restartAsked) { Request-Restart 'to finish upgrading Windows'; $Prev.restartAsked = $true; $Prev.quiet = $true; return $Prev }
      return $null # still waiting; nothing new to report
    }
    if ($Prev.state -eq 'staged' -and $Prev.targetBuild -and $build -lt [int]$Prev.targetBuild) {
      # The assistant restarts more than once; give it a day before calling it a failure.
      $busy = Get-Process -Name 'Windows10UpgraderApp', 'SetupHost' -ErrorAction SilentlyContinue
      if ($busy -and ($now - [int64]$Prev.stagedAt) -lt 86400000) { return $null }
      return @{ state = 'error'; code = 'ROLLBACK'; message = "Windows is still on build $build after restarting, so setup rolled the upgrade back. $(Get-SetupError)"; at = $now }
    }
    $st.step = [int]$Prev.step + 1
  } elseif ($Prev.state -ne 'inprogress') { $st.step = 0 }

  # Already on the version this sequence upgrades to.
  if ($st.step -eq 0 -and $Dep.targetBuild -and $build -ge [int]$Dep.targetBuild) { return @{ state = 'success'; message = "Already on Windows build $build"; at = $now } }

  for ($i = $st.step; $i -lt $n; $i++) {
    $s = $steps[$i]
    $label = "Step $($i + 1) of ${n}"
    Send-Status $Dep.id 'inprogress' $null "${label}: $($s.type)"
    Write-Log "Task sequence $($ts.name): $label ($($s.type))"
    try {
      switch ($s.type) {
        'readiness' {
          $p = @(Test-OsReadiness $s)
          if ($p.Count) { return @{ state = 'reqnotmet'; code = 'NOT_READY'; message = "Not ready: $($p -join '; ')"; at = $now } }
        }
        'bitlocker' { Write-Log (Suspend-OsBitLocker) }
        'script' {
          $p = Invoke-PowerShellText $s.body 3600
          if ($p.timedOut -or $p.exitCode -ne 0) { throw (New-StepError 'SCRIPT' "'$($s.name)' exited with $($p.exitCode). $(("$($p.output)" -split "`n" | Select-Object -Last 2) -join ' ')") }
        }
        'app' {
          if (-not (Test-Detected $s.app.detectName $Software)) {
            $r = Install-App @{ app = $s.app; action = 'Install' } $Software
            $Software = Get-Software
            if (-not $r.ok) { throw (New-StepError "$($r.code)" "$($s.app.name): $($r.message)") }
            if (-not (Test-Detected $s.app.detectName $Software)) { throw (New-StepError 'NOT_DETECTED' "$($s.app.name) installed but wasn't detected") }
          }
        }
        'restart' {
          Request-Restart 'to continue setting up Windows'
          return @{ state = 'restarting'; step = $i; stagedAt = Now-Ms; at = $now; message = "${label}: restarting" }
        }
        'upgrade' {
          if ($build -ge [int]$s.image.build) { Write-Log "Already on build $build; skipping the upgrade"; break }
          $msg = Invoke-OsUpgrade $s
          if ($Dep.restart -eq 'Allow' -and $s.image.source -ne 'assistant') { Request-Restart 'to finish upgrading Windows' }
          $wait = if ($Dep.restart -eq 'Allow' -or $s.image.source -eq 'assistant') { $msg } else { "$msg Waiting for the user to restart." }
          return @{ state = 'staged'; step = $i; stagedAt = Now-Ms; targetBuild = [int]$s.image.build; restartAsked = ($Dep.restart -eq 'Allow'); at = $now; message = "${label}: $wait" }
        }
      }
    } catch {
      $code = if ($_.Exception.Data['code']) { $_.Exception.Data['code'] } else { 'ERROR' }
      return @{ state = 'error'; code = $code; message = "${label} ($($s.type)): $($_.Exception.Message)"; at = $now }
    }
  }
  $done = Get-WindowsBuild
  return @{ state = 'success'; message = "Task sequence finished. Windows build $done."; at = $now }
}

# ---------------------------------------------------------------- one cycle
function Send-Status($DeploymentId, $State, $Code, $Message) {
  try { Invoke-Api 'POST' '/api/agent/status' @{ deviceId = $script:Config.deviceId; deploymentId = $DeploymentId; state = $State; errorCode = $Code; message = $Message } | Out-Null }
  catch { Write-Log $_.Exception.Message 'warn' }
}

function Invoke-Checkin($Inventory, $Security, $Software, $Updates, $Events, $Errors) {
  $body = [ordered]@{}
  foreach ($k in $Inventory.Keys) { $body[$k] = $Inventory[$k] }
  $body.security = $Security
  if ($script:Config.deviceId) { $body.deviceId = $script:Config.deviceId }
  if ($null -ne $Software) { $body.software = @($Software | ForEach-Object { [ordered]@{ name = $_.name; version = $_.version; publisher = $_.publisher } }) }
  if ($null -ne $Updates) { $body.updates = $Updates }
  $body.events = @($Events | ForEach-Object { @{ level = 'info'; message = $_ } })
  $body.errors = @($Errors)
  try { $r = Invoke-Api 'POST' '/api/agent/checkin' $body } catch {
    if ($_.Exception.Data['status'] -eq 404 -and $script:Config.deviceId) {
      Write-Log 'The server no longer knows this device. Enrolling again.' 'warn'
      $script:Config.deviceId = $null; $script:Config.deviceKey = $null
      $body.Remove('deviceId')
      $r = Invoke-Api 'POST' '/api/agent/checkin' $body
    } else { throw }
  }
  if ($r.deviceKey) {
    $script:Config.deviceId = $r.deviceId; $script:Config.deviceKey = $r.deviceKey
    Write-Json $ConfigPath $script:Config
    Write-Log "Enrolled as device $($r.deviceId)"
  }
  return $r
}

function Invoke-Cycle {
  $script:Config = To-Hash (Read-Json $ConfigPath)
  if (-not $script:Config.server -or -not $script:Config.token) { throw "Not installed. Run: ggt-agent.ps1 -Install -Server https://<site> -Token <token>" }
  $state = To-Hash (Read-Json $StatePath)
  $script:State = $state
  # The update server reports the updates PCs need about once an hour, or right after a change.
  $script:WsusFull = [bool]$state.wsusForce -or -not $state.wsusAt -or ((Now-Ms) - [int64]$state.wsusAt) -gt 3600000
  $deps = To-Hash $state.deps
  $now = Now-Ms
  $errors = @(); $events = @($state.pendingEvents | Where-Object { $_ })

  $inv = Get-Inventory
  $sec = Get-Security
  $sw = Get-Software
  $swHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes((($sw | ForEach-Object { "$($_.name)|$($_.version)" }) -join "`n")))).Replace('-', '')
  $sendSw = $state.forceInventory -or $swHash -ne $state.softwareHash -or -not $state.softwareAt -or ($now - [int64]$state.softwareAt) -gt 86400000
  $upd = $null
  # A new device checks in before its first (slow) update scan, so it shows in the console at once.
  if (-not $script:Config.deviceId) { Invoke-Checkin $inv $sec $sw $null $events $errors | Out-Null; $events = @() }
  if (-not $SkipUpdateScan -and ($state.forceScan -or -not $state.lastScan -or ($now - [int64]$state.lastScan) -gt 6 * 3600000)) {
    try { Write-Log 'Scanning Windows Update'; $upd = Get-UpdateScan; $state.lastScan = $now; $state.forceScan = $false; Write-Log "$(@($upd.missing).Count) updates missing" }
    catch { $errors += "Windows Update scan failed: $($_.Exception.Message)" }
  }
  $r = Invoke-Checkin $inv $sec $(if ($sendSw) { $sw } else { $null }) $upd $events $errors
  if ($script:WsusFull -and $inv.wsus) { $state.wsusAt = $now; $state.wsusForce = $false }
  $script:WsusFull = $false
  if ($sendSw) { $state.softwareHash = $swHash; $state.softwareAt = $now; $state.forceInventory = $false }
  $state.pendingEvents = @()
  $newEvents = @()

  $policy = Invoke-Api 'GET' "/api/agent/policy?deviceId=$([uri]::EscapeDataString($script:Config.deviceId))" $null
  $changed = $false

  foreach ($c in @($policy.commands)) {
    if (-not $c) { continue }
    Write-Log "Running command $($c.type) $($c.name)"
    $res = @{ status = 'succeeded'; exitCode = 0; output = '' }
    try {
      switch ($c.type) {
        'script' {
          if ($c.lang -ne 'PowerShell') { $res = @{ status = 'failed'; exitCode = $null; output = "$($c.lang) scripts don't run on Windows" }; break }
          $p = Invoke-PowerShellText $c.body 600
          $res = @{ status = if ($p.exitCode -eq 0) { 'succeeded' } else { 'failed' }; exitCode = $p.exitCode; output = if ($p.timedOut) { "$($p.output)`nStopped after 10 minutes." } else { $p.output } }
        }
        'restart' { Request-Restart; $res.output = 'Restart scheduled in 5 minutes' }
        'inventory' { $state.forceInventory = $true; $changed = $true; $res.output = 'Inventory sent' }
        'updscan' { $state.forceScan = $true; $changed = $true; $res.output = 'Update scan started' }
        'remoteon' { $res.output = Set-RemoteDesktop $true; $changed = $true }
        'remoteoff' { $res.output = Set-RemoteDesktop $false; $changed = $true }
        'vpnjoin' { $res.output = Join-Tailscale "$($c.authKey)"; $state.forceInventory = $true; $changed = $true }
        'vpnleave' { $res.output = Leave-Tailscale; $state.forceInventory = $true; $changed = $true }
        'ggvpnon' { $res.output = Connect-GoGreenVpn $c.vpn; $changed = $true }
        'ggvpnoff' { $res.output = Disconnect-GoGreenVpn; $changed = $true }
        'encon' { $res.output = Enable-DiskEncryption; $changed = $true }
        'encoff' { $res.output = Disable-DiskEncryption; $changed = $true }
        'wsussetup' { $res.output = Install-WsusServer $c.wsus; $changed = $true }
        'wsussync' { $res.output = Start-WsusSync; $changed = $true }
        'wsusapprove' { $res.output = Set-WsusApproval $c.updates $true; $changed = $true }
        'wsusdecline' { $res.output = Set-WsusApproval $c.updates $false; $changed = $true }
        default { $res = @{ status = 'failed'; exitCode = $null; output = "Unknown command $($c.type)" } }
      }
    } catch { $res = @{ status = 'failed'; exitCode = $null; output = $_.Exception.Message } }
    try { Invoke-Api 'POST' '/api/agent/result' @{ deviceId = $script:Config.deviceId; commandId = $c.id; status = $res.status; exitCode = $res.exitCode; output = "$($res.output)" } | Out-Null } catch { Write-Log $_.Exception.Message 'warn' }
  }

  try { $wu = Set-WuClient "$($policy.wsusClient)" $state; if ($wu) { $newEvents += $wu; $changed = $true } } catch { $newEvents += "Couldn't set the update server: $($_.Exception.Message)" }

  if (@($policy.remediate).Count) {
    $rem = Invoke-Remediation @($policy.remediate) $policy.settings $sec
    if ($rem.done.Count) { $newEvents += $rem.done; $changed = $true }
    foreach ($e in $rem.errors) { $newEvents += "Remediation failed: $e" }
  }

  foreach ($d in @($policy.deployments)) {
    if (-not $d) { continue }
    $prev = To-Hash $deps[$d.id]
    if ($d.kind -eq 'os') {
      if ($prev.state -eq 'success' -or ($prev.state -eq 'reqnotmet' -and [int64]$prev.at -gt [int64]$d.retryAt -and ($now - [int64]$prev.at) -lt 86400000)) { continue }
      $waiting = $prev.state -eq 'staged' -or $prev.state -eq 'restarting'
      if (-not $waiting -and -not $d.allowedNow) { continue }
      if ($prev.state -eq 'error' -and [int64]$prev.at -gt [int64]$d.retryAt -and ($now - [int64]$prev.at) -lt 86400000) { continue }
      $res = Invoke-TaskSequence $d $prev $sw
      if (-not $res) { continue }
      if ($res.quiet) { $res.Remove('quiet'); $deps[$d.id] = $res; continue }
      $deps[$d.id] = $res
      $changed = $true
      $sendState = if ($res.state -eq 'staged' -or $res.state -eq 'restarting') { 'inprogress' } else { $res.state }
      Send-Status $d.id $sendState $(if ($res.state -eq 'error' -or $res.state -eq 'reqnotmet') { $res.code } else { $null }) $res.message
      Write-Log "Task sequence $($d.name): $($res.state) $($res.message)"
      $sw = Get-Software
      continue
    }
    if ($d.kind -eq 'app') {
      $want = $d.action -ne 'Uninstall'
      if ((Test-Detected $d.app.detectName $sw) -eq $want) {
        if ($prev.state -ne 'success') { Send-Status $d.id 'success' $null 'Detected'; $deps[$d.id] = @{ state = 'success'; at = $now } }
        continue
      }
    }
    if (-not $d.allowedNow) { continue }
    if ($prev.state -eq 'error' -and [int64]$prev.at -gt [int64]$d.retryAt -and ($now - [int64]$prev.at) -lt 86400000) { continue }
    Send-Status $d.id 'inprogress' $null $null
    Write-Log "Deployment $($d.name): starting"
    try {
      if ($d.kind -eq 'app') {
        $res = Install-App $d $sw
        $sw = Get-Software
        if ($res.ok -and (Test-Detected $d.app.detectName $sw) -ne ($d.action -ne 'Uninstall')) { $res = @{ ok = $false; code = 'NOT_DETECTED'; message = $res.message } }
      } else {
        $res = Install-Updates @($d.updateIds)
        $state.forceScan = $true
      }
    } catch { $res = @{ ok = $false; code = 'ERROR'; message = $_.Exception.Message } }
    $changed = $true
    if ($res.ok) { Send-Status $d.id 'success' $null $res.message; $deps[$d.id] = @{ state = 'success'; at = (Now-Ms) } }
    else { Send-Status $d.id 'error' $res.code $res.message; $deps[$d.id] = @{ state = 'error'; at = (Now-Ms) } }
    Write-Log "Deployment $($d.name): $(if ($res.ok) { 'succeeded' } else { "failed $($res.code) $($res.message)" })"
    if ($res.reboot -and $d.restart -eq 'Allow') { Request-Restart }
  }

  # Report what changed right away instead of waiting 5 minutes.
  if ($changed) {
    $upd2 = $null
    if ($state.forceScan -and -not $SkipUpdateScan) { try { $upd2 = Get-UpdateScan; $state.lastScan = Now-Ms; $state.forceScan = $false } catch { $errors += "Windows Update scan failed: $($_.Exception.Message)" } }
    $sw = Get-Software
    try { Invoke-Checkin (Get-Inventory) (Get-Security) $sw $upd2 $newEvents $errors | Out-Null; $newEvents = @(); $state.softwareAt = Now-Ms; $state.forceInventory = $false } catch { Write-Log $_.Exception.Message 'warn' }
  }
  $state.pendingEvents = @($newEvents)
  $state.deps = $deps
  Write-Json $StatePath $state
}

# ---------------------------------------------------------------- install / uninstall
function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run PowerShell as administrator.' }
}

# One agent run at a time: a scheduled run that starts while another (for example the first
# check-in during install) is still going would otherwise enrol again and replace its device key.
function Invoke-CycleLocked([int]$WaitSeconds = 0) {
  $mutex = New-Object System.Threading.Mutex($false, 'Global\GGTAgentRun')
  try {
    try { $got = $mutex.WaitOne([TimeSpan]::FromSeconds($WaitSeconds)) } catch [System.Threading.AbandonedMutexException] { $got = $true }
    if (-not $got) { Write-Log 'Another agent run is still in progress; skipping this one.'; return }
    try { Invoke-Cycle } finally { $mutex.ReleaseMutex() }
  } finally { $mutex.Dispose() }
}

if ($Install) {
  Assert-Admin
  $Server = $Server.TrimEnd('/')
  if ($Server -notmatch '^https://' -and $Server -notmatch '^http://(localhost|127\.0\.0\.1)(:\d+)?$') { throw 'Server must be an https:// address.' }
  if (-not (Test-Path $AgentDir)) { New-Item -ItemType Directory -Path $AgentDir -Force | Out-Null }
  $target = Join-Path $AgentDir 'ggt-agent.ps1'
  if ($PSCommandPath -ne $target) { Copy-Item -Path $PSCommandPath -Destination $target -Force }
  & icacls.exe $AgentDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  $old = To-Hash (Read-Json $ConfigPath)
  $cfg = @{ server = $Server; token = $Token; deviceId = $null; deviceKey = $null }
  if ($old.server -eq $Server -and $old.deviceId) { $cfg.deviceId = $old.deviceId; $cfg.deviceKey = $old.deviceKey }
  Write-Json $ConfigPath $cfg
  if (-not $NoSchedule) {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$target`" -Run"
    $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)))
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3)
    Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
    Write-Log "Scheduled task $TaskPath$TaskName registered (every 5 minutes, as SYSTEM)"
  }
  Write-Log "Installed agent $AgentVersion in $AgentDir. Checking in now."
  Invoke-CycleLocked 600
  Write-Log 'First check-in done. The device now shows in the Device Manager.'
  exit 0
}

if ($Uninstall) {
  Assert-Admin
  Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false -ErrorAction SilentlyContinue
  try { $null = Disconnect-GoGreenVpn } catch { }
  Remove-Item -Path $AgentDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'GGT Agent removed. Retire the device in the Device Manager to remove its record.'
  exit 0
}

try { Invoke-CycleLocked; exit 0 } catch { Write-Log $_.Exception.Message 'error'; exit 1 }
