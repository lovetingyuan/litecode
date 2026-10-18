param([Parameter(Mandatory=$true)][string]$ApplicationPath)
$allProcesses = @(Get-CimInstance Win32_Process)
$rootProcesses = @($allProcesses | Where-Object { $_.ExecutablePath -eq $ApplicationPath })
$processIds = [Collections.Generic.HashSet[uint32]]::new()
foreach ($processItem in $rootProcesses) { [void]$processIds.Add($processItem.ProcessId) }
do {
    $previousCount = $processIds.Count
    foreach ($processItem in $allProcesses) {
        if ($processIds.Contains($processItem.ParentProcessId)) { [void]$processIds.Add($processItem.ProcessId) }
    }
} while ($processIds.Count -gt $previousCount)
$rows = @(foreach ($processItem in $allProcesses) {
    if ($processIds.Contains($processItem.ProcessId)) {
        $running = Get-Process -Id $processItem.ProcessId -ErrorAction SilentlyContinue
        if ($running) { [pscustomobject]@{ pid=$processItem.ProcessId; parent=$processItem.ParentProcessId; name=$processItem.Name; workingSetBytes=$running.WorkingSet64; privateBytes=$running.PrivateMemorySize64; cpuSeconds=$running.CPU } }
    }
})
[pscustomobject]@{ capturedAt=[DateTime]::UtcNow.ToString('o'); application=$ApplicationPath; roots=@($rootProcesses.ProcessId); processes=$rows; workingSetBytes=($rows | Measure-Object workingSetBytes -Sum).Sum; privateBytes=($rows | Measure-Object privateBytes -Sum).Sum; note='Sum of process working sets may double-count shared pages. Includes WebView2 and language-server descendants present at capture time; CPU is cumulative.' } | ConvertTo-Json -Depth 5 -Compress
