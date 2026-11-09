$ErrorActionPreference = 'Stop'

# dsh-windows-notify 长驻 toast worker（Windows PowerShell 5.1 专用——WinRT 投影只在它里面存在）。
# 协议（全部 UTF-8 文本行）：
#   stdin : <id> <base64(UTF-8 JSON)>        JSON: {"op":"show","options":{...}} | {"op":"remove","target":{...}}
#   stdout: <id> <base64(UTF-8 JSON)>        JSON: {"ok":true} | {"ok":false,"error":"..."}
# stdin 关闭（宿主退出）时进程自动结束。脚本本体纯 ASCII，任务内容走 base64，
# 中文/emoji/引号不会被命令行或代码页二次解释。

[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
[void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]

function Send-Line([string]$Id, [hashtable]$Result) {
  $json = $Result | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  Write-Output ("$Id " + [Convert]::ToBase64String($bytes))
}

function Invoke-Show($Options) {
  $xmlText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$Options.xmlBase64))
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xmlText)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  if ($Options.tag) { $toast.Tag = [string]$Options.tag }
  if ($Options.group) { $toast.Group = [string]$Options.group }
  if ($Options.suppressPopup -eq $true) { $toast.SuppressPopup = $true }
  if ($Options.expiresInSeconds) {
    $toast.ExpirationTime = [DateTimeOffset]::Now.AddSeconds([int]$Options.expiresInSeconds)
  }
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier([string]$Options.aumid)
  $notifier.Show($toast)
  return @{ ok = $true }
}

function Invoke-Remove($Target) {
  $tag = [string]$Target.tag
  $group = if ($Target.group) { [string]$Target.group } else { 'dsh' }
  $aumid = if ($Target.aumid) { [string]$Target.aumid } else { 'com.deepseek.dsh' }
  [void][Windows.UI.Notifications.ToastNotificationManager]::History.Remove($tag, $group, $aumid)
  return @{ ok = $true }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  $sep = $line.IndexOf(' ')
  if ($sep -le 0) { continue }
  $id = $line.Substring(0, $sep)
  try {
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring($sep + 1)))
    $task = $payload | ConvertFrom-Json
    if ($task.op -eq 'show') {
      Send-Line $id (Invoke-Show $task.options)
    } elseif ($task.op -eq 'remove') {
      Send-Line $id (Invoke-Remove $task.target)
    } else {
      Send-Line $id @{ ok = $false; error = "unknown op: $($task.op)" }
    }
  } catch {
    Send-Line $id @{ ok = $false; error = $_.Exception.Message }
  }
}
