param(
  [Parameter(Mandatory = $true)][string]$Key,
  [string]$Value = '',
  [switch]$NoNewline
)

# 批处理文件（.cmd）里不放中文：双击运行时控制台是 936 代码页，cmd 按字节解析 UTF-8 中文会错位，
# 曾导致一行注释被当成命令执行。所有给用户看的中文因此集中在这里输出。

$texts = @{
  # ---- update.cmd（永久升级入口）用到的文案 ----------------------------------
  'update-shell-header' = '  壳自身更新（只换壳文件：cmd / ps1 / tools\*.mjs；不动 app、desktop、运行时和你的配置）'
  'update-shell-checking' = '  正在检查更新…（网络慢时最多约 15 秒，别关窗口）'
  'update-shell-ask'    = '  现在就升级？（20 秒后自动开始；按 N 跳过，7 天内不再提醒）'
  'update-shell-close-first' = '  检测到 DeepSeek 还开着：请关掉窗口并右键托盘图标退出，关掉后会自动继续……'
  'update-shell-ok'     = '  升级完成。上面的版本号就是当前壳版本。'
  'update-shell-uptodate' = '  壳已经是最新版本，不需要升级。'
  'update-shell-blocked' = '  这次不能自动升级（被兼容性挡下，原因见上）。可以到 Release 页下载 harness-shell-*.zip 手工覆盖壳文件。'
  'update-shell-netfail' = '  检查更新失败：网络不通或被挡。稍后重试即可，不影响继续使用。'
  'update-shell-declined' = '  已跳过，7 天内不再提醒（想立刻升就再双击 update.cmd）。'
  'update-shell-gaveup' = '  等了 3 分钟 DeepSeek 还开着，先不升级了。关掉它之后重新双击 update.cmd 即可。'
  'preflight-menu'      = '  选择启动方式：'
  'preflight-hint'      = '  [W=浏览器模式 / D=桌面窗口 / U=更新壳 / N=只看自检，30 秒后默认 N]'
  'store-mismatch'      = "  插件依赖环境和当前 pnpm 大版本不一致：市场里会装不上也卸不掉（pnpm 报 UNEXPECTED_STORE）。`n  先彻底退出 DeepSeek Harness，再运行：dsh-portable.cmd plugin-repair -Force"
  'shell-found'         = '  发现壳更新：{0}'
  'shell-updating'      = '  正在更新壳（只换壳，不动 app / desktop / 运行时和你的数据）……'
  'shell-recheck'      = '  更新完成，重新自检：'
  'shell-updated'       = '  壳已更新到 {0}，重新启动后生效'
  'shell-update-failed' = '  壳更新没完成，已回滚到原来能用的版本；详见 logs\shell-update.err'
  'shell-update-prompt'   = '  发现壳更新。现在更新吗？（更新内容见上方；只换壳，不动 app / desktop / 运行时和你的数据）'
  'shell-update-hint'     = '  [Y=更新 / N=这次不更新，30 秒后默认 N；之后可在菜单里选 U]'
  'shell-update-declined' = '  已跳过这次壳更新（7 天内不再提示；随时可用 dsh-portable.cmd shell-update 手动更新）'
  'shell-update-done'     = '  壳已更新到 {0}，重启后生效'
  'shell-update-blocked'  = '  这次不能自动升级：{0}'
  'update-interrupted'  = '  检测到上次更新中断，正在自动修复……'
  'update-prompt'       = '  现在更新吗？'
  'update-hint'         = '  [Y=更新 / N=直接启动，15 秒后默认 N]'
  'shell-hold'          = "  壳自身有新版本（见上）：只替换壳文件，不动内核、运行时和你的数据。升级：双击本目录下的 update.cmd（关掉本窗口后双击即可）。5 秒后自动继续。"
  'kernel-hold'         = "  内核比本壳新（见上）：补丁对新内核不负责，5 秒后自动继续。升壳：双击本目录下的 update.cmd。"
  'update-failed'       = "  更新没完成，已经保留原来能用的版本；下面继续启动旧版本。`n  详细原因见 logs\ 目录，或手动运行 dsh-portable.cmd update-all -Force"
  'cmd-blocked'         = '  这个动作被拦下了（退出码 {0}）：壳更新被兼容性挡下或需要 --full；上面有具体原因和补救做法。'
  'cmd-failed'          = '  命令失败（退出码 {0}）。'
  'reset-shell'         = '  已重置 {0} 个与本机绑定的登录缓存（换机器后无法解密，属正常）'
  'bootstrap-start'     = '  缺少官方 dsh（app / desktop / 运行时）。正在自动下载补齐：需要联网，约 700 MB，每一步都有进度条'
  'bootstrap-fail'      = '  自举没完成（已下载的部分会保留）。检查网络后重跑：dsh-portable.cmd bootstrap'
  'bootstrap-done'      = '  自举完成，可以正常启动'
  'patch-needs-adapt'   = "  有补丁没打上（官方层可能刚升级过）：商城装卸插件、exFAT 上新建文件可能失败。`n  看详情：dsh-portable.cmd doctor（patches 三行）；修复：dsh-portable.cmd repair"
  'patch-failed'        = "  补丁写入失败（可能桌面程序占着 app.asar）：先退出 DeepSeek Harness，再运行 dsh-portable.cmd repair"
}

$text = $texts[$Key]
if (-not $text) { exit 0 }
if ($Value) { $text = $text.Replace('{0}', $Value) }

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
if ($NoNewline) { [Console]::Out.Write($text) } else { [Console]::Out.Write($text + [Environment]::NewLine) }
exit 0