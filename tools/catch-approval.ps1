# Catch a real approval toast while it is still on screen: poll the Action Center,
# print the toast XML, and (when DSH_CATCH_CLICK=1) activate its "allow" button.
# ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param([int]$Seconds = 30, [string]$Aumid = 'com.deepseek.dsh')

[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]

$deadline = (Get-Date).AddSeconds($Seconds)
$caught = $false
while (-not $caught -and (Get-Date) -lt $deadline) {
  $items = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($Aumid)
  foreach ($item in $items) {
    $xml = $item.Content.GetXml()
    if ($xml -match 'dsh-notify:allow/([0-9a-f]{8,32})') {
      $token = $Matches[1]
      Write-Output ("CAUGHT tag=" + $item.Tag + " token=" + $token)
      Write-Output $xml
      if ($env:DSH_CATCH_CLICK -eq '1') {
        Start-Process ("dsh-notify:allow/" + $token)
        Write-Output ("CLICKED dsh-notify:allow/" + $token)
      }
      $caught = $true
      break
    }
  }
  if (-not $caught) { Start-Sleep -Milliseconds 120 }
}
if (-not $caught) { Write-Output 'NOT-CAUGHT' } else { Write-Output 'DONE' }
