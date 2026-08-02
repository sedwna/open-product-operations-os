[CmdletBinding()]
param(
  [string]$Output
)

$ErrorActionPreference = 'Stop'
if (-not $Output) { $Output = Join-Path $PSScriptRoot 'OpenProductOS.exe' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
  throw 'The Windows C# compiler was not found.'
}
& $compiler /nologo /target:winexe /optimize+ /debug- /reference:System.Windows.Forms.dll "/out:$Output" (Join-Path $PSScriptRoot 'OpenProductOS.cs')
if ($LASTEXITCODE -ne 0) { throw 'Windows launcher compilation failed.' }
Get-FileHash -LiteralPath $Output -Algorithm SHA256
