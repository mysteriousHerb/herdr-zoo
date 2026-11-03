# Azure DevOps pull requests for branches, for my-status (gh only knows GitHub).
# $args[0]: base64 of a JSON list [{key, host, user, org, project, repo, branch}].
# Prints a JSON list [{key, pr: {url, number, state, isDraft, title} | null, error?}].
# The token is git's own stored credential (Git Credential Manager), never printed.
$ErrorActionPreference = 'Continue'
$env:GCM_INTERACTIVE = 'never'
$items = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0])) | ConvertFrom-Json
$auth = @{}
$out = @()
foreach ($it in @($items)) {
  $res = @{ key = $it.key; pr = $null }
  try {
    $who = "$($it.host)|$($it.user)"
    if (-not $auth.ContainsKey($who)) {
      $in = "protocol=https`nhost=$($it.host)`n" + $(if ($it.user) { "username=$($it.user)`n" } else { '' }) + "`n"
      $pw = (($in | git credential fill 2>$null) | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
      $auth[$who] = if (-not $pw) { $null }
        elseif ($pw.StartsWith('ey')) { "Bearer $pw" }
        else { 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(":$pw")) }
    }
    if (-not $auth[$who]) { $res.error = "no stored git credential for $($it.host)" }
    else {
      $ref = [uri]::EscapeDataString("refs/heads/$($it.branch)")
      $base = "https://dev.azure.com/$($it.org)/$($it.project)/_apis/git/repositories/$($it.repo)"
      $r = Invoke-RestMethod -Uri "$base/pullrequests?searchCriteria.sourceRefName=$ref&searchCriteria.status=all&`$top=10&api-version=7.0" -Headers @{ Authorization = $auth[$who] } -TimeoutSec 15 -ErrorAction Stop
      $list = @($r.value)
      $p = @($list | Where-Object { $_.status -eq 'active' })[0]
      if (-not $p) { $p = $list[0] }
      if ($p) {
        $state = switch ($p.status) { 'active' { 'OPEN' } 'completed' { 'MERGED' } default { 'CLOSED' } }
        $res.pr = @{ url = "https://dev.azure.com/$($it.org)/$($it.project)/_git/$($it.repo)/pullrequest/$($p.pullRequestId)"
          number = $p.pullRequestId; state = $state; isDraft = [bool]$p.isDraft; title = $p.title
          head = $p.lastMergeSourceCommit.commitId }
      }
    }
  } catch { $res.error = $_.Exception.Message }
  $out += $res
}
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
