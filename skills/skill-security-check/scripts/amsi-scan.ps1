# Scans files through the Windows Antimalware Scan Interface (AMSI).
# AMSI forwards the bytes to the registered antivirus product (Defender, AVG,
# Avast, ESET and others), so it works when no command-line scanner exists.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File amsi-scan.ps1 [-Canary] [-Stdin] [<file> ...]
# -Stdin reads one file path per line from standard input (avoids command-line limits).
# Output: one JSON object per file: {"file": ..., "result": <int>, "detected": <bool>}
# -Canary first scans two harmless in-memory test samples (EICAR and the AMSI
# test sample). If the engine flags neither, a "clean" result proves nothing.
param([switch]$Canary, [switch]$Stdin, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Files)

$ErrorActionPreference = 'Stop'
if ($Stdin) { $Files = @($Files) + @([Console]::In.ReadToEnd() -split "`r?`n") }
$Files = @($Files | Where-Object { $_ })

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SkillAmsi {
    [DllImport("amsi.dll", CharSet = CharSet.Unicode)]
    public static extern int AmsiInitialize(string appName, out IntPtr context);
    [DllImport("amsi.dll")]
    public static extern void AmsiUninitialize(IntPtr context);
    [DllImport("amsi.dll")]
    public static extern int AmsiOpenSession(IntPtr context, out IntPtr session);
    [DllImport("amsi.dll")]
    public static extern void AmsiCloseSession(IntPtr context, IntPtr session);
    [DllImport("amsi.dll", CharSet = CharSet.Unicode)]
    public static extern int AmsiScanBuffer(IntPtr context, byte[] buffer, uint length, string contentName, IntPtr session, out int result);
}
'@

$context = [IntPtr]::Zero
$hr = [SkillAmsi]::AmsiInitialize('skill-security-check', [ref]$context)
if ($hr -ne 0) { Write-Error ("AmsiInitialize failed: 0x{0:X8}" -f $hr); exit 3 }
# Every buffer gets its own session: providers correlate buffers inside one
# session, so a canary hit would otherwise taint the real files.
function Invoke-AmsiScan([byte[]]$Bytes, [string]$Name) {
    $session = [IntPtr]::Zero
    [void][SkillAmsi]::AmsiOpenSession($context, [ref]$session)
    try {
        $result = 0
        $hr = [SkillAmsi]::AmsiScanBuffer($context, $Bytes, [uint32]$Bytes.Length, $Name, $session, [ref]$result)
        return @{ hr = $hr; result = $result }
    } finally {
        [SkillAmsi]::AmsiCloseSession($context, $session)
    }
}
try {
    if ($Canary) {
        # Split so that this file itself is not a test sample.
        $samples = @(
            ('X5O!P%@AP[4\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
            ('AMSI Test Sample: ' + '7e72c3ce-861b-4339-8740-0ac1484c1386')
        )
        $hit = $false
        foreach ($sample in $samples) {
            $scan = Invoke-AmsiScan ([System.Text.Encoding]::ASCII.GetBytes($sample)) 'canary'
            if ($scan.hr -eq 0 -and $scan.result -ge 32768) { $hit = $true }
        }
        # Name the products behind AMSI. Security Center exists on client
        # Windows only; bits 12-15 of productState are 1 when scanning is on.
        $products = @()
        try {
            $products = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop |
                Where-Object { (($_.productState -shr 12) -band 0xF) -eq 1 } |
                ForEach-Object { $_.displayName })
        } catch { }
        [pscustomobject]@{ canary = $true; detected = $hit; products = $products } | ConvertTo-Json -Compress
    }
    foreach ($file in $Files) {
        try { $bytes = [System.IO.File]::ReadAllBytes($file) } catch {
            [pscustomobject]@{ file = $file; result = -1; detected = $false; error = $_.Exception.GetType().Name } | ConvertTo-Json -Compress
            continue
        }
        $scan = Invoke-AmsiScan $bytes $file
        $result = $scan.result
        if ($scan.hr -ne 0) {
            [pscustomobject]@{ file = $file; result = -1; detected = $false; error = ("0x{0:X8}" -f $scan.hr) } | ConvertTo-Json -Compress
            continue
        }
        # AMSI_RESULT_DETECTED is 32768 and above; 16384-20479 means blocked by admin policy.
        [pscustomobject]@{ file = $file; result = $result; detected = ($result -ge 32768) } | ConvertTo-Json -Compress
    }
} finally {
    [SkillAmsi]::AmsiUninitialize($context)
}
