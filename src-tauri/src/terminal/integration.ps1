if (-not (Test-Path Function:\__LiteCodeOriginalPrompt)) {
    if (Test-Path Function:\prompt) { Copy-Item Function:\prompt Function:\__LiteCodeOriginalPrompt }
    function global:prompt {
        $previousSuccess = $?
        $previousExitCode = $global:LASTEXITCODE
        if ($PWD.Provider.Name -eq 'FileSystem') {
            $escape = [char]27
            [Console]::Write("$escape]9;9;`"$($PWD.ProviderPath)`"$escape\")
        }
        $global:LASTEXITCODE = $previousExitCode
        if (Test-Path Function:\__LiteCodeOriginalPrompt) { & __LiteCodeOriginalPrompt } else { "PS $PWD> " }
    }
}
