[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$launcherDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $launcherDirectory '..\..'))
$entrypoint = Join-Path $repositoryRoot 'scripts\one-click-onboarding.mjs'
$toolRoot = Join-Path $repositoryRoot '.product-ops-tools'

function Test-UsableNode([string]$NodePath) {
  if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { return $false }
  try {
    $major = & $NodePath -p "Number(process.versions.node.split('.')[0])"
    return [int]$major -ge 20
  } catch {
    return $false
  }
}

function Find-Node {
  $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($systemNode -and (Test-UsableNode $systemNode.Source)) { return $systemNode.Source }
  if (Test-Path -LiteralPath $toolRoot) {
    $localNode = Get-ChildItem -LiteralPath $toolRoot -Directory -Filter 'node-v*-win-*' -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'node.exe' } |
      Where-Object { Test-UsableNode $_ } |
      Select-Object -First 1
    if ($localNode) { return $localNode }
  }
  return $null
}

function Install-PortableNode {
  $architecture = switch ($env:PROCESSOR_ARCHITECTURE) {
    'ARM64' { 'arm64' }
    'AMD64' { 'x64' }
    default { throw "Unsupported Windows architecture: $env:PROCESSOR_ARCHITECTURE" }
  }
  New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
  $temporary = Join-Path ([IO.Path]::GetTempPath()) ("open-product-ops-node-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temporary | Out-Null
  try {
    $baseUrl = 'https://nodejs.org/dist/latest-v22.x'
    $checksumFile = Join-Path $temporary 'SHASUMS256.txt'
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHASUMS256.txt" -OutFile $checksumFile
    $pattern = "^([a-f0-9]{64})  (node-v[^ ]+-win-$architecture\.zip)$"
    $match = Get-Content -LiteralPath $checksumFile | Select-String -Pattern $pattern | Select-Object -First 1
    if (-not $match) { throw 'Portable runtime archive was not listed by nodejs.org.' }
    $expected = $match.Matches[0].Groups[1].Value
    $archive = $match.Matches[0].Groups[2].Value
    $archivePath = Join-Path $temporary $archive
    Write-Host 'Downloading verified portable Node.js runtime...'
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$archive" -OutFile $archivePath
    $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw 'Portable runtime checksum verification failed.' }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $toolRoot
    $runtimeDirectory = $archive.Substring(0, $archive.Length - 4)
    $nodePath = Join-Path (Join-Path $toolRoot $runtimeDirectory) 'node.exe'
    if (-not (Test-UsableNode $nodePath)) { throw 'Portable runtime extraction failed.' }
    return $nodePath
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
  }
}

try {
  $nodePath = Find-Node
  if (-not $nodePath) { $nodePath = Install-PortableNode }
  $nodeDirectory = Split-Path -Parent $nodePath
  $env:Path = "$nodeDirectory;$env:Path"
  & $nodePath $entrypoint
  exit $LASTEXITCODE
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
