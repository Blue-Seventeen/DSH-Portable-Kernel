param(
  [Parameter(Mandatory = $true)][string]$Key,
  [string]$Value = '',
  [switch]$NoNewline
)

# 批处理文件（.cmd）里不放中文：双击运行时控制台是 936 代码页，cmd 按字节解析 UTF-8 中文会错位，
# 曾导致一行注释被当成命令执行。所有给用户看的中文因此集中在这里输出。

$texts = @{
  'preflight-menu'      = '  选择启动方式：'
  'preflight-hint'      = '  [W=浏览器模式 / D=桌面窗口 / U=更新壳 / N=只看自检，30 秒后默认 N]'
  'store-mismatch'      = "  插件依赖环境和当前 pnpm 大版本不一致：市场里会装不上也卸不掉（pnpm 报 UNEXPECTED_STORE）。`n  先彻底退出 DeepSeek Harness，再运行：dsh-portable.cmd plugin-repair -Force"
  'shell-found'         = '  发现壳更新：{0}'
  'shell-updating'      = '  正在更新壳（只换壳，不动 app / desktop / 运行时和你的数据）……'
  'shell-updated'       = '  壳已更新到 {0}，重新启动后生效'
  'shell-update-failed' = '  壳更新没完成，已回滚到原来能用的版本；详见 logs\shell-update.err'
  'update-interrupted'  = '  检测到上次更新中断，正在自动修复……'
  'update-prompt'       = '  现在更新吗？'
  'update-hint'         = '  [Y=更新 / N=直接启动，15 秒后默认 N]'
  'update-failed'       = "  更新没完成，已经保留原来能用的版本；下面继续启动旧版本。`n  详细原因见 logs\ 目录，或手动运行 dsh-portable.cmd update-all -Force"
  'cmd-failed'          = '  命令失败（退出码 {0}）。'
  'reset-shell'         = '  已重置 {0} 个与本机绑定的登录缓存（换机器后无法解密，属正常）'
  'bootstrap-start'     = '  缺少官方 dsh（app / desktop / 运行时）。正在自动下载补齐：需要联网，约 700 MB，每一步都有进度条'
  'bootstrap-fail'      = '  自举没完成（已下载的部分会保留）。检查网络后重跑：dsh-portable.cmd bootstrap'
  'bootstrap-done'      = '  自举完成，可以正常启动'
}

$text = $texts[$Key]
if (-not $text) { exit 0 }
if ($Value) { $text = $text.Replace('{0}', $Value) }

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
if ($NoNewline) { [Console]::Out.Write($text) } else { [Console]::Out.Write($text + [Environment]::NewLine) }
exit 0