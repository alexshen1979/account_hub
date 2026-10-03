param(
  [string]$Version = "0.3.2"
)

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseDirectory = Join-Path $projectRoot "releases"
New-Item -ItemType Directory -Force -Path $releaseDirectory | Out-Null
$archivePath = Join-Path $releaseDirectory "account-hub-v$Version.zip"

if (Test-Path -LiteralPath $archivePath) {
  Remove-Item -LiteralPath $archivePath -Force
}

Push-Location $projectRoot
try {
  & tar.exe -a -c -f $archivePath `
    --exclude=node_modules `
    --exclude='*/node_modules' `
    --exclude=data `
    --exclude='*/dist' `
    --exclude=releases `
    --exclude=.git `
    --exclude='.env' `
    --exclude='.env.local' `
    --exclude='.env.*.local' `
    --exclude='.env.production' `
    --exclude='.env.development' `
    --exclude='*.tsbuildinfo' `
    .
  if ($LASTEXITCODE -ne 0) { throw "Release archive creation failed." }
} finally {
  Pop-Location
}

Write-Output $archivePath
