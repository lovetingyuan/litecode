param([Parameter(Mandatory=$true)][string]$SourceDirectory, [Parameter(Mandatory=$true)][string]$OutputPath)
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($SourceDirectory, $OutputPath, [IO.Compression.CompressionLevel]::Optimal, $true)
