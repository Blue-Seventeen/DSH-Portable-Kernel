[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('doctor', 'verify', 'tidy', 'clean-ship', 'sync-home', 'update-app', 'update-desktop', 'update-all', 'check-updates', 'check-quiet', 'repair', 'unblock', 'fix-state', 'reset-shell', 'fix-office', 'fix-market', 'focus-desktop', 'show-desktop', 'close-desktop', 'launch-desktop', 'auto-prepare', 'plugin-list', 'plugin-add', 'plugin-remove', 'plugin-adopt', 'plugin-sync', 'plugin-allow', 'plugin-revoke', 'plugin-repair', 'plugin-stage', 'plugin-stage-remove', 'plugin-stage-list', 'plugin-stage-discard', 'plugin-activate', 'market-history', 'fix-attachment', 'bootstrap', 'shell-update', 'fs-profile', 'migrate-store')]
  [string]$Action = 'doctor',
  [Parameter(Position = 1)]
  [string]$From,
  [Parameter(Position = 2)]
  [string]$Arg2,
  [switch]$Force,
  [switch]$PurgeHostStore
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = Join-Path $Root 'runtime\node\bin\node.exe'
# 所有可变状态都留在便携目录内（外置 store / staging 已废弃）：环境变量由 env.cmd 提供。
# 单独用 powershell -File 跑本脚本（没经过 env.cmd）时，先把探测片段读进环境，
# 否则 $ImportMethod 会退回 auto，在 exFAT 上又会去试硬链接。
$fragPath = Join-Path $Root 'tmp\fs-profile.cmd'
$rootDrive = ''
try { $q = [System.IO.Path]::GetPathRoot($Root); if ($q -match '^([A-Za-z]):') { $rootDrive = $Matches[1].ToUpperInvariant() } } catch { }
$loadFrag = {
  if (-not (Test-Path -LiteralPath $fragPath)) { return }
  foreach ($ln in @(Get-Content -LiteralPath $fragPath)) {
    if ($ln -match '^\s*set\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?\s*$') { Set-Item -Path ('env:' + $Matches[1]) -Value $Matches[2] }
  }
}
if (-not $env:DSH_FS_PROFILE) { & $loadFrag }
# 片段缺失或盘符对不上（换机器/换盘）时先现场探测一次，别让 $ImportMethod 退回 auto
if ((-not $env:DSH_FS_PROFILE) -or ($rootDrive -and $env:DSH_FS_DRIVE -ne $rootDrive)) {
  $fsScript = Join-Path $Root 'tools\fs-profile.ps1'
  if (Test-Path -LiteralPath $fsScript) {
    & powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $fsScript -Root $Root -Quiet | Out-Null
    & $loadFrag
  }
}
$StoreRoot = if ($env:DSH_PNPM_STORE) { $env:DSH_PNPM_STORE } else { Join-Path $Root 'cache\pnpm-store' }
$StageRoot = if ($env:DSH_STAGE) { $env:DSH_STAGE } else { Join-Path $Root 'tmp\build' }
$ImportMethod = if ($env:DSH_PNPM_IMPORT_METHOD) { $env:DSH_PNPM_IMPORT_METHOD } else { 'auto' }
$SevenZip = Join-Path $Root 'tools\7z\7z.exe'
$Journal = Join-Path $Root 'tmp\update-journal.json'
$Journal2 = Join-Path $Root 'tmp\shell-update-journal.json'
$UpdateCache = Join-Path $Root 'cache\update'
function Say([string]$m) { Write-Host $m }
function Warn2([string]$m) { Write-Host $m -ForegroundColor Yellow }
function Json([string]$p) { if (Test-Path -LiteralPath $p) { Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null } }
function PathOf([string]$p) { return [System.IO.Path]::GetFullPath($p) }
function Size([string]$p) {
  if (-not (Test-Path -LiteralPath $p)) { return 0 }
  $f = Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue
  return [math]::Round(($f | Measure-Object Length -Sum).Sum / 1MB, 1)
}
function FreeMB([string]$p) {
  try { return [math]::Round(([System.IO.DriveInfo]::new((Split-Path -Qualifier (PathOf $p)))).AvailableFreeSpace / 1MB) } catch { return -1 }
}
function Robo([string]$src, [string]$dst, [string[]]$extra = @()) {
  if (-not (Test-Path -LiteralPath $dst)) { New-Item -ItemType Directory -Force -Path $dst | Out-Null }
  $rcArgs = @($src, $dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1') + $extra
  $rcExe = Resolve-Robocopy
  if (-not $rcExe) { throw '找不到 robocopy.exe（Windows 自带组件被裁剪？）' }
  & $rcExe @rcArgs | Out-Null
  if ($LASTEXITCODE -ge 16) { throw "robocopy fatal ($LASTEXITCODE): $src -> $dst" }
  return $LASTEXITCODE
}
function AppVersion {
  # app\package.json 是 pnpm 生成的（只有 dependencies，没有 version），
  # 所以再看一眼真正装进来的官方包，否则自举完成后版本号会显示成空白。
  $a = Json (Join-Path $Root 'app\package.json')
  if ($a -and $a.version) { return $a.version }
  $b = Json (Join-Path $Root 'app\node_modules\@deepseek-ai\dsh\package.json')
  if ($b -and $b.version) { return $b.version }
  return $null
}
function DesktopVersion {
  $exe = Join-Path $Root 'desktop\DeepSeek Harness.exe'
  if (-not (Test-Path -LiteralPath $exe)) { return $null }
  return (Get-Item -LiteralPath $exe).VersionInfo.FileVersion
}
function DesktopRunning {
  # 用 StartsWith 而不是 -like：路径里有 [ ] 这类字符时通配符会失效（审计 F.12）
  $prefix = (Join-Path $Root 'desktop')
  $p = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) }
  return (@($p).Count -gt 0)
}
function Get-SevenZipState {
  # 只有 7z.exe 没有 7z.dll 时，插件包/更新包两层解包全部失效 —— 原来只 Test-Path exe。
  if (-not (Test-Path -LiteralPath $SevenZip)) { return 'MISSING exe' }
  $dll = Join-Path $Root 'tools\7z\7z.dll'
  if (-not (Test-Path -LiteralPath $dll)) { return 'MISSING 7z.dll' }
  try {
    $raw = (Get-Item -LiteralPath $SevenZip).VersionInfo.FileVersion
    $num = ($raw -replace '[^0-9.].*$', '').Trim('.')
    if (-not $num) { return 'ok (版本未知)' }
    if ([version]$num -lt [version]'24.0') { return ('too old ' + $raw) }
    return ('ok ' + $raw)
  } catch { return 'ok (版本未知)' }
}
function Get-OfficePatchState {
  # 只报告"有没有贴"，不判断该不该贴（新系统上本来就不该贴，见 Fix-OfficeRuntime）
  $dirs = @(
    (Join-Path $Root 'app\node_modules\@deepseek-ai\libreoffice-kit-win32-x64\bin'),
    (Join-Path $Root 'desktop\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\libreoffice-kit-win32-x64\bin')
  )
  $n = 0
  foreach ($d in $dirs) {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    $n += @(Get-ChildItem -LiteralPath $d -Filter '*.dll' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'msvcp140*' -or $_.Name -like 'vcruntime140*' -or $_.Name -like 'concrt140*' }).Count
  }
  return ($(if ($n -gt 0) { 'patched (' + $n + ' dll)' } else { 'clean' }))
}
function Get-LeftoverCount {
  # 只扫根目录 + tmp/cache/logs（不递归 app/desktop，避免 doctor 变慢）
  $n = 0
  if (Test-Path -LiteralPath $Journal) { $n++ }
  foreach ($pat in @('app.next', 'desktop.next')) { if (Test-Path -LiteralPath (Join-Path $Root $pat)) { $n++ } }
  foreach ($d in @('tmp', 'cache', 'logs')) {
    $p = Join-Path $Root $d
    if (-not (Test-Path -LiteralPath $p)) { continue }
    $n += @(Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*.part' -or $_.Name -like '*.bak-*' -or $_.Name -like '*.tmpdir' -or $_.Name -like '*.next' -or $_.Name -like '*.tmp' }).Count
  }
  return $n
}
function Get-LoginBackupCount {
  return @(Get-ChildItem -LiteralPath (Join-Path $Root 'cache') -Directory -Filter 'shell-login-bak-*' -Force -ErrorAction SilentlyContinue).Count
}
function TreeLooksValid([string]$dir) {
  # 只做结构下限，**不比对 version.json 的具体字节**。
  # 原因：更新流程（Install-Desktop / Swap-Tree / 中断恢复）拿这个函数校验的是"刚下载解包出来的
  # 新版本目录"，它的 app.asar 本来就和当前快照不同 —— 一旦按快照卡 ±1%，每次官方升级都会被判
  # "不完整"然后连人带包回滚。精确字节比对属于"出厂快照自检"，放在 `dsh-portable.cmd verify`
  # 和 doctor 里做（那份代码只跑在交付/自检时，不会被更新流程调用）。
  $exe = Join-Path $dir 'DeepSeek Harness.exe'
  $asar = Join-Path $dir 'resources\app.asar'
  if (-not (Test-Path -LiteralPath $exe)) { return 'executable missing' }
  if (-not (Test-Path -LiteralPath $asar)) { return 'resources\app.asar missing' }
  # 原来只卡 "≥50 MB"，而实际是 182.8 MB（丢了 73% 也能过关）；现在卡 150 MB 留出版本差异余量。
  $asarLen = (Get-Item -LiteralPath $asar).Length
  if ($asarLen -lt 150MB) { return ("resources\app.asar truncated (" + $asarLen + ")") }
  $unpacked = Join-Path $dir 'resources\app.asar.unpacked'
  if (Test-Path -LiteralPath $unpacked) {
    $u = @(Get-ChildItem -LiteralPath $unpacked -Recurse -File -Force -ErrorAction SilentlyContinue).Count
    if ($u -lt 1400) { return ("app.asar.unpacked too few files (" + $u + ")") }
  } else { return 'resources\app.asar.unpacked missing' }
  $n = @(Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue).Count
  if ($n -lt 3000) { return "too few files ($n)" }
  return $null
}
function RemoveOldBackups([string]$prefix, [int]$keep = 2, [string]$Dir = '') {
  # 审计 F.1：原来只扫 $Root，而 shell-login-bak-* 建在 cache\ 下 → "只留 2 份"是死代码，实际无限增长。
  if (-not $Dir) { $Dir = $Root }
  $items = @(Get-ChildItem -LiteralPath $Dir -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$prefix*" } | Sort-Object LastWriteTime -Descending)
  if ($items.Count -le $keep) { return }
  foreach ($old in $items[$keep..($items.Count - 1)]) {
    Say ("removing old backup: " + $old.Name)
    Remove-Item -LiteralPath $old.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
}
function Fix-Bom {
  $dir = Join-Path $Root 'home\storages'
  if (-not (Test-Path -LiteralPath $dir)) { return }
  foreach ($f in @(Get-ChildItem -LiteralPath $dir -Recurse -File -Filter '*.json' -ErrorAction SilentlyContinue)) {
    $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    if ($bytes.Length -lt 3) { continue }
    if (-not ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)) { continue }
    $text = [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
    try { $null = ($text | ConvertFrom-Json) } catch { Warn2 ('跳过（内容不是合法 JSON）：' + $f.Name); continue }
    [System.IO.File]::WriteAllText($f.FullName, $text, (New-Object System.Text.UTF8Encoding($false)))
    Say ('已去掉 BOM（否则 DSH 会拒绝加载）：' + $f.Name)
  }
}
function Fix-OfficeRuntime {
  # LibreOffice 引擎是预编译的 C++ 程序，要求 VS2022 运行库（14.4x）。
  # 老系统（如 Win10 1703）自带的 MSVCP140*.dll 太旧，而 Windows 的 DLL 搜索顺序是
  # “exe 同目录 > System32 > PATH”，把运行库放 PATH 里永远不会生效（实测会 0xC0000005 崩溃）。
  # 因此把运行库整组复制到引擎 exe 同目录：优先级最高，且与系统已装版本无关。
  # 注意要复制整组（含 msvcp140_1/2、concrt140）：只补 3 个时引擎仍会用到 System32 的旧副本。
  $src = Join-Path $Root 'runtime\vcredist'
  if (-not (Test-Path -LiteralPath $src)) { return }
  # 只在老系统上自动落盘：Win10 1809(17763) 及以后自带 14.2x+ 运行库，不需要我们贴 7 个 DLL。
  # 少贴这 7 个文件 = 与官方 app\desktop-runtime.json 清单的偏差从 9 项降到 2 项（cli.js 补丁 + .orig），
  # 便于"跟着官方升级"时对账。真需要时：dsh-portable.cmd fix-office 无条件重贴。
  if (-not $Force -and $env:DSH_PORTABLE_OFFICE_ALWAYS -ne '1' -and [Environment]::OSVersion.Version.Build -ge 17763) {
    Say ('  office : 系统 build ' + [Environment]::OSVersion.Version.Build + ' 自带运行库，跳过 vcredist 拷贝（fix-office 可强制）')
    return
  }
  $dlls = @(Get-ChildItem -LiteralPath $src -Filter '*.dll' -File -ErrorAction SilentlyContinue)
  if ($dlls.Count -eq 0) { return }
  $bins = @(
    (Join-Path $Root 'app\node_modules\@deepseek-ai\libreoffice-kit-win32-x64\bin'),
    (Join-Path $Root 'desktop\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\libreoffice-kit-win32-x64\bin')
  )
  $copied = 0
  foreach ($bin in $bins) {
    if (-not (Test-Path -LiteralPath $bin)) { continue }
    foreach ($dll in $dlls) {
      $to = Join-Path $bin $dll.Name
      $need = $true
      if (Test-Path -LiteralPath $to) {
        try {
          $a = $dll.VersionInfo.FileVersionRaw
          $b = (Get-Item -LiteralPath $to).VersionInfo.FileVersionRaw
          if ($a -and $b -and $a -le $b) { $need = $false }
        } catch { }
      }
      if ($need) {
        try { Copy-Item -LiteralPath $dll.FullName -Destination $to -Force -ErrorAction Stop; $copied++ } catch { }
      }
    }
  }
  if ($copied -gt 0) { Say ("  已把 " + $copied + " 个运行库文件放到 Office 引擎目录（老系统上避免崩溃）") }
}
function Fix-OfficeCli {
  # 上游缺陷（libreoffice-kit 0.1.5，cli.js 里清理临时目录那段）：
  #   rm(scratch, { recursive: true, force: true })
  # LibreOffice 生成的 profile\Documents 目录带 ReadOnly 属性，Node 在部分 Windows/Node
  # 组合上会抛 EPERM，清理错误被聚合成 AggregateError，在“转换已成功”之后把整条命令判为失败，
  # 于是产物正常但退出码为 1、每次都留残留目录。
  # Node 的 rm 只有在给出 maxRetries 时才会走 fixWinEPERM（清只读后重试），所以补一个即可。
  # 两处都要补：浏览器模式在 app\，桌面模式在 desktop\resources\app.asar.unpacked\（该文件是解包的实体文件）。
  $targets = @(
    (Join-Path $Root 'app\node_modules\@deepseek-ai\libreoffice-kit\lib\cli.js'),
    (Join-Path $Root 'desktop\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\libreoffice-kit\lib\cli.js')
  )
  $done = 0
  foreach ($cli in $targets) {
    if (-not (Test-Path -LiteralPath $cli)) { continue }
    try {
      $text = [System.IO.File]::ReadAllText($cli)
      if ($text.Contains('maxRetries: 3')) { continue }
      $patched = [regex]::Replace($text, 'rm\(scratch,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)', 'rm(scratch, { recursive: true, force: true, maxRetries: 3 })')
      if ($patched -eq $text) { continue }   # 上游改过写法，跳过，不冒险
      $orig = $cli + '.orig'
      if (-not (Test-Path -LiteralPath $orig)) { [System.IO.File]::WriteAllText($orig, $text, (New-Object System.Text.UTF8Encoding($false))) }
      [System.IO.File]::WriteAllText($cli, $patched, (New-Object System.Text.UTF8Encoding($false)))
      $done++
    } catch { }
  }
  if ($done -gt 0) { Say ("  已给 " + $done + " 份 Office 引擎补上只读目录清理重试（修上游退出码 1 的问题）") }
}
function Plugin-Tool {
  # 共享插件的唯一入口：解析规则、清单登记和 pnpm 调用都在 tools\plugin-shared.mjs 里，
  # 这里只负责转发参数并把退出码带回来。
  param([string[]]$ToolArgs)
  $script = Join-Path $Root 'tools\plugin-shared.mjs'
  if (-not (Test-Path -LiteralPath $script)) { Warn2 '缺少 tools\plugin-shared.mjs，无法管理共享插件'; return 1 }
  # 必须 Out-Host：否则 node 的输出会被当成函数返回值，被调用处的 exit 吞掉，屏幕上什么都看不到
  & $Node $script @ToolArgs | Out-Host
  return $LASTEXITCODE
}
function Fix-MarketPatch {
  # 插件市场（dshmarket）判断“装成功没有”用的是固定路径 <profile>\node_modules\<包名>。
  # 便携版为了两个模式共用一份插件，用 modulesDir 把包装到了 home\profiles\node_modules，
  # 市场就判定“缺构件”并把刚装好的包删掉（报 MUTATION_FAILED）。
  # tools\patch-market.mjs 给它加一级向上查找；幂等，已打过就秒退。
  # 市场自己升级会覆盖 lib\*.js，所以每次启动都补一次（不联网、不改用户数据）。
  param([switch]$Quiet)
  $script = Join-Path $Root 'tools\patch-market.mjs'
  if (-not (Test-Path -LiteralPath $script)) { return }
  $toolArgs = @()
  if ($Quiet) { $toolArgs += '--quiet' }
  & $Node $script @toolArgs | Out-Host
}
function Repair-OfficialPatches {
  # 三族补丁的统一入口：market（商城路径 + drain 语义）/ fs（exFAT 硬链接回退）/ pnpm（store 项目注册）。
  # 官方 update-app / update-desktop / bootstrap / 商城自更新会**整份替换**这些文件，补丁随之消失，
  # 所以每次启动和每次升级收尾都要补一次。退出码：0 全好 / 2 本次有改动 / 4 有没打上（WARN，不阻断）/ 1 硬失败。
  param([switch]$Quiet)
  $tool = Join-Path $Root 'tools\patch-all.mjs'
  if (-not (Test-Path -LiteralPath $tool)) { return 0 }
  $toolArgs = @('--apply')
  if ($Quiet) { $toolArgs += '--quiet' }
  & $Node $tool @toolArgs | Out-Host
  return $LASTEXITCODE
}
function Clean-TempJunk([switch]$Force) {
  # tmp\ 里会堆运行时垃圾，都在便携目录内，不清会无限变大（审计 #2：原来只认 3 个前缀，
  # dsh-subprocess-* / dsh-workspace-changes-* / *.tmp / logs\desktop-console.log* 全漏）：
  #   1) libreoffice-kit-*   Office 转换的临时目录（上游清理有缺陷时会残留，带只读属性）
  #   2) dsh-*               技能副本、溢出暂存、子进程、工作区变更快照
  #   3) *.tmp               dsh 自己的临时文件（活跃会话正在写）
  #   4) logs\desktop-console.log*  脱敏后的桌面控制台日志
  # 只删“超过 2 小时没动过”的；桌面窗口正在运行时默认整段跳过（-Force 可强来），
  # 避免删掉活跃会话正在用的目录（审计 F.4）。
  if (-not $Force -and (DesktopRunning)) { return }
  $cut = (Get-Date).AddHours(-2)
  $n = 0
  $tmpDir = Join-Path $Root 'tmp'
  if (Test-Path -LiteralPath $tmpDir) {
    foreach ($pattern in @('libreoffice-kit-*', 'dsh-*')) {
      Get-ChildItem -LiteralPath $tmpDir -Directory -Filter $pattern -Force -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.LastWriteTime -gt $cut) { return }
        try {
          Get-ChildItem -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
            try { $_.Attributes = $_.Attributes -band (-bnot [System.IO.FileAttributes]::ReadOnly) } catch { }
          }
          Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
          $n++
        } catch { }
      }
    }
    Get-ChildItem -LiteralPath $tmpDir -File -Filter '*.tmp' -Force -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.LastWriteTime -gt $cut) { return }
      try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop; $n++ } catch { }
    }
  }
  $logDir = Join-Path $Root 'logs'
  if (Test-Path -LiteralPath $logDir) {
    Get-ChildItem -LiteralPath $logDir -File -Filter 'desktop-console.log*' -Force -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.LastWriteTime -gt $cut) { return }
      try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop; $n++ } catch { }
    }
  }
  # 5) tmp\stage\*  插件暂存的影子 home（下载/校验用；正常结束会自己删，崩了才会留）
  #    正在跑暂存时有一个 .lock 在 home\plugin-stage\，此时整段跳过，别删到一半
  $shadowDir = Join-Path $Root 'tmp\stage'
  $stageLock = Join-Path $Root 'home\plugin-stage\.lock'
  if ((Test-Path -LiteralPath $shadowDir) -and -not (Test-Path -LiteralPath $stageLock)) {
    Get-ChildItem -LiteralPath $shadowDir -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.LastWriteTime -gt $cut) { return }
      try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop; $n++ } catch { }
    }
  }
  if ($n -gt 0) { Say ("  已清理 " + $n + " 项临时残留") }
}
function Repair-State {
  if (Test-Path -LiteralPath $Journal) {
    $j = $null; try { $j = Get-Content -LiteralPath $Journal -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    if ($j) {
      $target = PathOf (Join-Path $Root $j.target)
      $next = PathOf (Join-Path $Root $j.next)
      $backup = if ($j.backup) { PathOf $j.backup } else { $null }
      Warn2 ("检测到上次更新在切换中途中断（" + $j.target + "）")
      if (-not (Test-Path -LiteralPath $target)) {
        if ((Test-Path -LiteralPath $next) -and -not (Test-TreeFor $j.target $next)) {
          Rename-Item -LiteralPath $next -NewName $j.target
          Say ("  已补完切换：" + $j.next + " -> " + $j.target)
        }
        elseif ($backup -and (Test-Path -LiteralPath $backup)) {
          Rename-Item -LiteralPath $backup -NewName $j.target
          Say ("  已从备份恢复：" + $j.backup + " -> " + $j.target)
        }
        else { Warn2 '  目标目录缺失且无可用备份，请手动检查' }
      }
      else { Say '  目标目录完好，无需修复' }
    }
    Remove-Item -LiteralPath $Journal -Force -ErrorAction SilentlyContinue
  }
  # 壳换装 journal：tools\shell-update.mjs apply 先写 tmp\shell-update-journal.json，
  # 它还在就说明上次换装走到一半（断电 / 被杀）。交给 shell-update recover 按备份整体还原。
  if (Test-Path -LiteralPath $Journal2) {
    if (Test-Path -LiteralPath $Node) {
      Warn2 '检测到上次壳换装中断，正在自动恢复……'
      & $Node (Join-Path $Root 'tools\shell-update.mjs') recover 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { Warn2 '  自动恢复失败：请运行 dsh-portable.cmd shell-update recover' }
      else { Say '  已恢复到换装前的壳' }
    } else { Warn2 '检测到壳换装中断，但 runtime\node 不在：先 dsh-portable.cmd bootstrap' }
  }
  if (Test-Path -LiteralPath $UpdateCache) {
    Get-ChildItem -LiteralPath $UpdateCache -Filter '*.part' -Force -ErrorAction SilentlyContinue | ForEach-Object {
      Say ("removing partial download: " + $_.Name); Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    }
  }
  foreach ($d in @('desktop.next', 'app.next')) {
    $p = Join-Path $Root $d
    if (Test-Path -LiteralPath $p) { Say "removing leftover staging dir: $d"; Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
function Reset-ShellCrypto {
  # Electron/Chromium 的登录缓存用“当前 Windows 用户 + 这台机器”的密钥加密；
  # 整个目录被复制到别的机器后解密必然失败（os_crypt 记 0x8009000B），表现为一堆解密报错。
  # 只清与登录/加密有关、且本来就不可能跨机迁移的文件；界面偏好、主题、历史都保留。
  $prof = Join-Path $Root 'shell-profile'
  if (-not (Test-Path -LiteralPath $prof)) { return }
  $targets = @(
    'Local State'
    'Network\Cookies'
    'Network\Cookies-journal'
    'Network\Network Persistent State'
    'Network\Trust Tokens'
    'Network\Trust Tokens-journal'
  )
  $removed = 0
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $bak = Join-Path $Root ('cache\shell-login-bak-' + $stamp)
  foreach ($rel in $targets) {
    $p = Join-Path $prof $rel
    if (Test-Path -LiteralPath $p) {
      try {
        # 先挪到 cache 留底：同一台机器上误清了能拷回去；换机器则本来也解不开，必须重新登录一次
        $dest = Join-Path $bak $rel
        $parent = Split-Path -Parent $dest
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Move-Item -LiteralPath $p -Destination $dest -Force -ErrorAction Stop
        $removed++
      } catch { }
    }
  }
  if ($removed -gt 0) {
    Say ('  已把 ' + $removed + ' 个与本机绑定的登录缓存挪到 cache\shell-login-bak-' + $stamp)
    Say '  （同一台机器上误清了可以拷回去；换机器则必须重新登录一次）'
    # 保留上限：每换一台机器就留一份，且每份都含 Network\Cookies —— 不设上限会无限堆在包里
    RemoveOldBackups 'shell-login-bak-' 2 -Dir (Join-Path $Root 'cache')
  }
}

function Marker-Path([string]$kind) {
  # 标记文件按“机器名 + 盘符”区分：整棵树被复制到别的机器/别的盘时，标记自然失效，
  # 于是会重新做一次检查——否则跟着目录一起被复制过去的旧标记会让新机器漏掉处理。
  return (Join-Path $Root ('tmp\' + $kind + '-' + $env:COMPUTERNAME + '_' + $Root.Substring(0, 1) + '.flag'))
}
function Set-Marker([string]$kind) {
  try { [System.IO.File]::WriteAllText((Marker-Path $kind), ((Get-Date).ToString('s')), (New-Object System.Text.UTF8Encoding($false))) } catch { }
}
function Save-Stamp([string]$path, [int64]$at, [int]$scanned, [int]$blocked) {
  try {
    $obj = [pscustomobject]@{ at = $at; scanned = $scanned; blocked = $blocked }
    [System.IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}
function Fix-Motw([switch]$IfNeeded, [switch]$Full) {
  # 每次双击 .cmd 都弹蓝色 SmartScreen，是因为文件带“来自其他计算机”标记。
  # 只扫能直接运行的文件类型；删掉标记即可，一次生效。
  $stampFile = Join-Path $Root 'tmp\motw.json'
  $now = [int64]((Get-Date).ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds
  if ($IfNeeded -and -not $Full -and (Test-Path -LiteralPath $stampFile)) {
    try {
      $s = Get-Content -LiteralPath $stampFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($s.blocked -eq 0 -and ($now - $s.at) -lt 604800000) { return }
    } catch { }
  }
  $fmt = ''
  try { $fmt = ([System.IO.DriveInfo]::new((Split-Path -Qualifier $Root))).DriveFormat } catch { }
  if ($fmt -ne 'NTFS') {
    Save-Stamp $stampFile $now 0 0
    if (-not $IfNeeded) { Say ('当前盘是 ' + $fmt + '，不支持“来自其他计算机”标记，无需处理') }
    return
  }
  $exts = @('.exe', '.dll', '.node', '.cmd', '.bat', '.ps1')
  $scanned = 0
  $blocked = @()
  foreach ($f in @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction SilentlyContinue)) {
    if ($exts -notcontains $f.Extension.ToLower()) { continue }
    $scanned++
    try {
      if (Get-Item -LiteralPath $f.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue) { $blocked += $f.FullName }
    } catch { }
  }
  $fixed = 0
  if ($blocked.Count -gt 0) {
    if ($IfNeeded) {
      foreach ($p in $blocked) {
        try { Remove-Item -LiteralPath $p -Stream Zone.Identifier -ErrorAction SilentlyContinue; $fixed++ } catch { }
      }
    }
    else {
      Say ('发现 ' + $blocked.Count + ' 个文件带“来自其他计算机”标记（共检查 ' + $scanned + ' 个）：')
      foreach ($p in ($blocked | Select-Object -First 8)) { Say ('  ' + $p.Substring($Root.Length + 1)) }
      if ($blocked.Count -gt 8) { Say ('  …还有 ' + ($blocked.Count - 8) + ' 个') }
      Say '运行  dsh-portable.cmd unblock  清除（只需一次）。'
    }
  }
  Save-Stamp $stampFile $now $scanned ($blocked.Count - $fixed)
  if ($IfNeeded -and $fixed -gt 0) { Say ('已清除 ' + $fixed + ' 个文件的“来自其他计算机”标记（Windows 不会再弹 SmartScreen）') }
}
function Fix-PnpmState([switch]$Quiet) {
  # 换机器后 home\profiles\*\node_modules 里记着旧机器的绝对路径，pnpm 会拒绝装卸。
  $tool = Join-Path $Root 'tools\fix-pnpm-state.mjs'
  if (-not (Test-Path -LiteralPath $tool)) { return }
  if (-not (Test-Path -LiteralPath $Node)) { return }
  $toolArgs = @($tool)
  if ($Quiet) { $toolArgs += '--quiet' }
  & $Node @toolArgs
}
function DesktopWindows {
  $list = @()
  foreach ($p in @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
    try {
      if (-not $p.Path) { continue }
      if (-not $p.Path.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    } catch { continue }
    $list += $p
  }
  return $list
}
$script:DshWin32Api = $null
function Get-Win32Api {
  if ($script:DshWin32Api) { return $script:DshWin32Api }
  if (-not ('DshPortable.Win32' -as [type])) {
    Add-Type -Namespace DshPortable -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
public delegate bool EnumProc(IntPtr h, IntPtr p);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
public struct RECT { public int L, T, R, B; }
// 官方点 X 的行为是 hide()（窗口还在、visible=false），部分机器上还会变成「最小化 + 移到 -32000」。
// 所以这里判断三种"看不见"的情形：最小化 / 被隐藏 / 被挪出屏幕外；可见的窗口只做前置。
// 返回值：-1 = 一个主窗口都没找到（进程在、但还没建出可识别的窗口）；0 = 本来就在屏幕上（已尝试前置）；>0 = 还原了几个。
public static int VisibleCount(uint[] pids) {
  // close-desktop 用：数一数还有几个主窗口是"真的看得见"。
  // 官方点 X/关闭只是 hide()，但有时会弹"后台运行"确认窗（也是可见的 Chrome_WidgetWin_1），
  // 所以不能只靠"进程还在"或单次 CloseMainWindow 的返回值判断。
  int visible = 0;
  EnumWindows(delegate(IntPtr h, IntPtr p) {
    uint wpid;
    GetWindowThreadProcessId(h, out wpid);
    if (System.Array.IndexOf(pids, wpid) < 0) return true;
    var cls = new System.Text.StringBuilder(256);
    GetClassName(h, cls, 256);
    if (cls.ToString() != "Chrome_WidgetWin_1") return true;
    var title = new System.Text.StringBuilder(512);
    GetWindowText(h, title, 512);
    if (title.Length == 0) return true;
    if (IsWindowVisible(h) && !IsIconic(h)) visible++;
    return true;
  }, IntPtr.Zero);
  return visible;
}
public static int Activate(uint[] pids) {
  var hits = new System.Collections.Generic.List<IntPtr>();
  EnumWindows(delegate(IntPtr h, IntPtr p) {
    uint wpid;
    GetWindowThreadProcessId(h, out wpid);
    if (System.Array.IndexOf(pids, wpid) < 0) return true;
    var cls = new System.Text.StringBuilder(256);
    GetClassName(h, cls, 256);
    if (cls.ToString() != "Chrome_WidgetWin_1") return true;
    var title = new System.Text.StringBuilder(512);
    GetWindowText(h, title, 512);
    if (title.Length == 0) return true;
    hits.Add(h);
    return true;
  }, IntPtr.Zero);
  if (hits.Count == 0) return -1;
  const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040;
  int restored = 0;
  foreach (var h in hits) {
    RECT r;
    GetWindowRect(h, out r);
    bool hidden = !IsWindowVisible(h);
    bool need = IsIconic(h) || hidden || r.L <= -20000;
    if (need) {
      ShowWindow(h, 9);   // SW_RESTORE：最小化/隐藏都能救
      ShowWindow(h, 5);   // SW_SHOW：双保险
      restored++;
    }
    // 前置经常被系统拒绝（后台进程没有前台权限），TOPMOST→NOTOPMOST 是最通用的绕过手法
    if (!SetForegroundWindow(h)) {
      SetWindowPos(h, (IntPtr)(-1), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
      SetWindowPos(h, (IntPtr)(-2), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
      SetForegroundWindow(h);
    }
  }
  return restored;
}
'@
  }
  $script:DshWin32Api = [DshPortable.Win32]
  return $script:DshWin32Api
}
function Start-DesktopDetached {
  # 统一的「脱离控制台启动桌面程序」实现。两个调用点：正常启动、以及窗口没出现时的"第二实例聚焦"。
  # 为什么不用 Start-Process：① 它会新开/继承控制台；② 本机 -RedirectStandardOutput 会抛
  # "Item has already been added. Key: 'NO_PROXY'"（环境变量重复导致的已知坑），只能走 ProcessStartInfo。
  # 输出经 tools\mask-log.mjs 脱敏后落到 logs\desktop-console.log（令牌变 <redacted>）。
  $exe = Join-Path $Root 'desktop\DeepSeek Harness.exe'
  if (-not (Test-Path -LiteralPath $exe)) { Warn2 ('找不到桌面程序：' + $exe); return $false }
  $logDir = Join-Path $Root 'logs'
  if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  $ud = Join-Path $Root 'shell-profile'
  $crash = Join-Path $Root 'logs\crash'
  $masker = Join-Path $Root 'tools\mask-log.mjs'
  $comspec = if ($env:ComSpec) { $env:ComSpec } else { Join-Path $env:SystemRoot 'System32\cmd.exe' }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $comspec
  if ((Test-Path -LiteralPath $masker) -and (Test-Path -LiteralPath $Node)) {
    $psi.Arguments = '/c ""' + $exe + '" "--user-data-dir=' + $ud + '" "--crash-dumps-dir=' + $crash + '" 2>&1 | "' + $Node + '" "' + $masker + '" "' + $Root.TrimEnd('\') + '""'
  } else {
    Warn2 '脱敏器不可用（tools\mask-log.mjs 或 node 缺失），日志会含明文 token'
    $psi.Arguments = '/c ""' + $exe + '" "--user-data-dir=' + $ud + '" "--crash-dumps-dir=' + $crash + '" > "' + (Join-Path $logDir 'desktop-console.log') + '" 2>&1"'
  }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WorkingDirectory = $Root
  try { [void][System.Diagnostics.Process]::Start($psi); return $true }
  catch {
    Warn2 ('自动启动失败（' + $_.Exception.Message + '），改用普通方式启动')
    try { Start-Process -FilePath $exe -ArgumentList ('--user-data-dir="' + $ud + '" --crash-dumps-dir="' + $crash + '"') | Out-Null; return $true } catch { return $false }
  }
}
function Invoke-DesktopWindow {
  # 四态（审计 F.3：原来把"进程在但还没有窗口"当成"没运行"，调用方会再起一个被单实例锁杀掉的实例）：
  #   2 = 桌面程序没在运行
  #   3 = 进程在，但没有可识别的 Chrome_WidgetWin_1 主窗口（刚启动 / 只有托盘 / API 失败）
  #   1 = 从托盘/隐藏态还原了
  #   0 = 本来就在屏幕上（已尝试切到前台）
  $procs = @(DesktopWindows)
  if (-not $procs.Count) { return 2 }
  try {
    $api = Get-Win32Api
    $ids = [uint32[]]@($procs | ForEach-Object { [uint32]$_.Id })
    $r = $api::Activate($ids)
    if ($r -lt 0) { return 3 }
    if ($r -gt 0) { return 1 }
    return 0
  } catch {
    # 绝不假装成功：Add-Type/P-Invoke 失败时如果返回 0，启动器会以为"窗口在屏幕上"然后什么都不做。
    Warn2 ('窗口控制失败：' + $_.Exception.Message)
    return 3
  }
}
function Restore-DesktopWindow {
  # 兼容旧调用：只要"还原过"就算成功（窗口本来可见时返回 false，避免谎报）
  return ((Invoke-DesktopWindow) -eq 1)
}
function Get-CompatState {
  # 豁免 pin 与当前 dsh 版本不一致时，官方会静默跳过那个插件（不报错）——升级后最容易踩的坑。
  $tool = Join-Path $Root 'tools\plugin-shared.mjs'
  if (-not (Test-Path -LiteralPath $tool)) { return 'MISSING tools\plugin-shared.mjs' }
  try {
    $out = ((& $Node $tool compat 2>&1) -join ' ').Trim()
    if ($LASTEXITCODE -eq 0) { return $out }
    return ('需要处理：' + $out)
  } catch { return '检查失败' }
}
function Get-MarketPatchState {
  # 补丁没打上 = 市场装插件必失败；而启动器是 --quiet 静默调用的，黑框一闪没人看见。
  # 所以让 doctor 直接把状态亮出来，出问题也有 logs\patch-market.err 可查。
  $tool = Join-Path $Root 'tools\patch-market.mjs'
  if (-not (Test-Path -LiteralPath $tool)) { return 'MISSING tools\patch-market.mjs' }
  try {
    $out = ((& $Node $tool --check 2>&1) -join ' ').Trim()
    if ($LASTEXITCODE -eq 0) { return $out }
    return ($out + '  → 跑 dsh-portable.cmd fix-market')
  } catch { return '检查失败（见 logs\patch-market.err）' }
}
function Stop-DesktopGracefully([int]$WaitSeconds = 20) {
  # 正常关闭窗口（发关闭请求，让 Chromium 自己把状态落盘）。
  # 直接杀进程会让 cookie/localStorage 停在写一半的状态，下次可能就要求重新登录。
  # 审计 #4：原来 20 秒后**无条件**报"已收进托盘"、永远 exit 0；实测窗口仍然可见。
  # 现在按"所有主窗口 IsWindowVisible=false 且非最小化"判定，判不出来就如实返回 1。
  $procs = @(DesktopWindows)
  if (-not $procs.Count) { Say '桌面窗口没有在运行'; return 0 }
  $asked = 0
  foreach ($p in $procs) {
    try { if ($p.MainWindowHandle -ne 0 -and $p.CloseMainWindow()) { $asked++ } } catch { }
  }
  if ($asked -gt 0) { Say ('已请求关闭 ' + $asked + ' 个窗口…') }
  else { Say '没有可关闭的主窗口（可能只剩托盘图标）'; }
  $ids = [uint32[]]@($procs | ForEach-Object { [uint32]$_.Id })
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if (@(DesktopWindows).Count -eq 0) { Say '桌面窗口已正常退出'; return 0 }
    $visible = -1
    try { $visible = (Get-Win32Api)::VisibleCount($ids) } catch { $visible = -1 }
    if ($visible -eq 0) {
      Say '窗口已收进托盘（官方行为，进程还在）。要完全退出：右下角托盘图标右键 → 退出。'
      return 0
    }
  }
  if ($asked -eq 0) { Warn2 '没有发到关闭请求（只剩托盘图标）；请在托盘图标上右键 → 退出'; return 1 }
  Warn2 '窗口仍然可见（官方可能弹了"后台运行"提示窗，需要手动确认）；请在托盘图标上右键 → 退出'
  return 1
}

function Focus-Desktop([int]$WaitSeconds = 30) {
  # 有的机器上桌面程序启动后只留一个托盘图标，窗口不自动出现。
  # 用同一个 --user-data-dir 再启动一次，官方逻辑会聚焦已有窗口（second-instance）。
  if ($env:DSH_PORTABLE_NO_FOCUS -eq '1') { return 0 }
  $exe = Join-Path $Root 'desktop\DeepSeek Harness.exe'
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 1500
    $procs = @(DesktopWindows)
    if (@($procs | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0) { Set-Marker 'focus-ok'; return 0 }
  }
  # 托盘里的窗口（最小化 / 被 hide() / 挪到屏幕外）不会产生 MainWindowHandle，上面那圈等不到，
  # 但它其实还在：先直接还原+前置，省掉"再启动一个实例"的折腾。
  $st = Invoke-DesktopWindow
  if ($st -eq 1) { Say '窗口原来在托盘里，已还原'; Set-Marker 'focus-ok'; return 0 }
  if ($st -eq 0) { Say '窗口已经在前台'; Set-Marker 'focus-ok'; return 0 }
  if (@(DesktopWindows).Count -eq 0) {
    Warn2 '桌面程序还没有运行起来（未找到进程）；若一直如此，请把 shell-profile\logs 发我'
    return 2
  }
  if (-not (Test-Path -LiteralPath $exe)) { Warn2 '找不到桌面程序，无法聚焦窗口'; return 2 }
  Warn2 '窗口没有自动出现，正在把它调到前台…'
  # 这个第二实例也只用来把已有窗口叫到前台，同样走"隐藏 cmd + 脱敏日志"的 helper：
  # 不再用 Start-Process -Redirect*（本机会抛 NO_PROXY 那个坑，回退分支又会挂住黑框）。
  [void](Start-DesktopDetached)
  $deadline2 = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline2) {
    Start-Sleep -Milliseconds 1200
    $procs = @(DesktopWindows)
    if (@($procs | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0) { Say '窗口已打开'; Set-Marker 'focus-ok'; return 0 }
  }
  Warn2 '窗口仍在托盘里：点一下任务栏右下角的小图标即可打开。'
  Warn2 '如果一直打不开，请把 shell-profile\logs 目录发我，我按日志继续查。'
  return 1
}
function Get-Manifest {
  $yml = (& $Node -e "fetch('https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml').then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.text()}).then(t=>process.stdout.write(t)).catch(e=>{console.error(e.message);process.exit(1)})") -join [Environment]::NewLine
  if ($LASTEXITCODE -ne 0 -or -not $yml) { throw '无法获取更新清单（可能没联网）' }
  $version = ([regex]::Match($yml, '(?m)^version:\s*(\S+)')).Groups[1].Value
  $url = ([regex]::Match($yml, '(?ms)^path:\s*>-\s*\r?\n\s*(\S+)')).Groups[1].Value
  $sha = ([regex]::Match($yml, '(?ms)^\s*sha512:\s*>-\s*\r?\n\s*(\S+)')).Groups[1].Value
  $size = [int64](([regex]::Match($yml, '(?m)^\s*size:\s*(\d+)')).Groups[1].Value)
  if (-not $version -or -not $url) { throw '更新清单格式异常' }
  return [pscustomobject]@{ version = $version; url = $url; sha512 = $sha; size = $size }
}
function Test-Sha512([string]$file, [string]$expected, [int64]$size) {
  $len = (Get-Item -LiteralPath $file).Length
  if ($size -gt 0 -and $len -ne $size) { return ("大小不符（$len / 期望 $size）") }
  if (-not $expected) { return $null }
  $sha = [System.Security.Cryptography.SHA512]::Create()
  $fs = [System.IO.File]::OpenRead($file)
  try { $hash = $sha.ComputeHash($fs) } finally { $fs.Close(); $sha.Dispose() }
  if ([Convert]::ToBase64String($hash) -ne $expected) { return 'sha512 校验失败' }
  return $null
}
function Get-Installer([pscustomobject]$manifest) {
  New-Item -ItemType Directory -Force -Path $UpdateCache | Out-Null
  $dest = Join-Path $UpdateCache ("deepseek-harness-$($manifest.version)-win-x64.exe")
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    if (Test-Path -LiteralPath $dest) {
      $err = Test-Sha512 $dest $manifest.sha512 $manifest.size
      if (-not $err) { Say "使用已校验的缓存安装包"; return $dest }
      Warn2 "缓存安装包不可用（$err），删除后重新下载"
      Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
    }
    $need = [math]::Round($manifest.size / 1MB) + 200
    if ((FreeMB $Root) -lt ($need + 1200)) { throw "磁盘空间不足：需要约 $($need + 1200) MB" }
    Say ("下载安装包（第 $attempt/2 次）：" + $manifest.url)
    & $Node (Join-Path $Root 'tools\download.mjs') $manifest.url $dest | Out-Host
    if ($LASTEXITCODE -ne 0) {
      if ($attempt -eq 2) { throw '下载失败（已清理半成品文件，旧的程序目录未受影响）' }
      Warn2 '下载中断，正在重试…'
      continue
    }
    $err = Test-Sha512 $dest $manifest.sha512 $manifest.size
    if (-not $err) { return $dest }
    Warn2 "校验失败（$err），丢弃该文件"
    Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
  }
  throw '无法获得可用的安装包'
}
function Test-AppTree([string]$dir) {
  # app 是 npm 包树，不是 desktop 结构：别拿 TreeLooksValid 去校验它（否则 update-app 必然回滚）
  if (-not (Test-Path -LiteralPath $dir)) { return '目录不存在' }
  if (-not (Test-Path -LiteralPath (Join-Path $dir 'node_modules\@deepseek-ai\dsh\lib\bin.js'))) { return '缺少 node_modules\@deepseek-ai\dsh\lib\bin.js' }
  if (-not (Test-Path -LiteralPath (Join-Path $dir 'package.json'))) { return '缺少 package.json' }
  return $null
}
function Test-TreeFor([string]$name, [string]$dir) {
  if ($name -eq 'desktop') { return TreeLooksValid $dir }
  if ($name -eq 'app') { return Test-AppTree $dir }
  return $null
}
function Swap-Tree([string]$name, [string]$nextName) {
  $target = Join-Path $Root $name
  $next = Join-Path $Root $nextName
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = Join-Path $Root ("$name.bak-" + $stamp)
  $suffix = 0
  while (Test-Path -LiteralPath $backup) { $suffix++; $backup = Join-Path $Root ("$name.bak-" + $stamp + '-' + $suffix) }
  $payload = [ordered]@{ target = $name; next = $nextName; backup = $backup; at = (Get-Date).ToString('o') }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Journal) | Out-Null
  [System.IO.File]::WriteAllText($Journal, ($payload | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  try {
    Rename-Item -LiteralPath $target -NewName (Split-Path -Leaf $backup)
    Rename-Item -LiteralPath $next -NewName $name
  }
  catch {
    Warn2 "切换失败，正在回滚：$($_.Exception.Message)"
    if (-not (Test-Path -LiteralPath $target)) {
      if (Test-Path -LiteralPath $backup) {
        Rename-Item -LiteralPath $backup -NewName $name
        Say '  已回滚到旧版本'
      }
      elseif ((Test-Path -LiteralPath $next) -and -not (Test-TreeFor $name $next)) {
        Rename-Item -LiteralPath $next -NewName $name
        Say '  已用新版本顶上（旧目录已不可恢复）'
      }
      else { Warn2 '  目标目录缺失且无可用备份，请运行：powershell -File dsh-portable.ps1 repair' }
    }
    Remove-Item -LiteralPath $Journal -Force -ErrorAction SilentlyContinue
    throw '切换失败（已回滚，原版本完好）'
  }
  $err = Test-TreeFor $name $target
  if ($err) {
    Warn2 "新目录自检失败（$err），正在回滚"
    Rename-Item -LiteralPath $target -NewName "$name.failed"
    Rename-Item -LiteralPath $backup -NewName $name
    Remove-Item -LiteralPath $Journal -Force -ErrorAction SilentlyContinue
    throw "新版本不可用，已回滚（坏目录留在 $name.failed）"
  }
  Remove-Item -LiteralPath $Journal -Force -ErrorAction SilentlyContinue
  Say ("切换完成；旧目录保留为 " + (Split-Path -Leaf $backup))
}
function Install-Desktop([string]$sourceDir, [pscustomobject]$manifest) {
  if (DesktopRunning) { throw '桌面窗口正在运行，请先关闭再更新' }
  Repair-State
  $next = Join-Path $Root 'desktop.next'
  if (Test-Path -LiteralPath $next) { Remove-Item -LiteralPath $next -Recurse -Force }
  if ($sourceDir) {
    Say "从本地目录复制：$sourceDir"
    Robo $sourceDir $next | Out-Null
  }
  else {
    if (-not (Test-Path -LiteralPath $SevenZip)) { throw "缺少解包工具：$SevenZip" }
    $installer = Get-Installer $manifest
    $stage = Join-Path $UpdateCache 'stage'
    RemoveTree $stage
    New-Item -ItemType Directory -Force -Path $stage, $next | Out-Null
    Say '解包进度（第 1/2 层：安装包容器）'
    & $SevenZip x $installer "-o$stage" -bsp1 -y | Out-Host
    if ($LASTEXITCODE -ge 2) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue; throw '第 1 层解包失败' }
    $inner = Join-Path $stage '$PLUGINSDIR\app-64.7z'
    if (-not (Test-Path -LiteralPath $inner)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue; throw "安装包结构异常：缺少 $inner" }
    Say '解包进度（第 2/2 层：程序本体）'
    & $SevenZip x $inner "-o$next" -bsp1 -y | Out-Host
    if ($LASTEXITCODE -ge 2) { Remove-Item -LiteralPath $next -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue; throw '第 2 层解包失败' }
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
  $err = TreeLooksValid $next
  if ($err) { Remove-Item -LiteralPath $next -Recurse -Force -ErrorAction SilentlyContinue; throw "解出的目录不完整（$err），已中止；旧版本未受影响" }
  $upd = Join-Path $next 'resources\app-update.yml'
  if (Test-Path -LiteralPath $upd) { Move-Item -LiteralPath $upd -Destination "$upd.disabled" -Force }
  Swap-Tree 'desktop' 'desktop.next'
  Fix-OfficeRuntime
  Say ("desktop 现在版本：" + (DesktopVersion))
  RemoveOldBackups 'desktop.bak-' 1
  Remove-Item -LiteralPath (Join-Path $Root 'tmp\update-check.json') -Force -ErrorAction SilentlyContinue
}
function Install-App {
  Repair-State
  $pnpm = Join-Path $Root 'runtime\pnpm\dist\pnpm.mjs'
  $cur = AppVersion
  # 离线时 node 只往 stderr 写、stdout 是空的；先收集原始输出再判空，
  # 否则 $null.Trim() 会先抛"不能对 Null 值表达式调用方法"，"可能没联网"这条提示永远走不到。
  $rawVersion = & $Node -e "fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest').then(r=>r.json()).then(j=>console.log(j.version)).catch(e=>{console.error(e.message);process.exit(1)})" 2>&1
  $versionExit = $LASTEXITCODE
  $latest = (@($rawVersion) -join ' ').Trim()
  if ($versionExit -ne 0 -or -not $latest) { throw ('无法查询 npm 上的官方版本（可能没联网）：' + $latest) }
  Say "app：当前 $cur / 最新 $latest"
  if ($cur -eq $latest) { Say 'app 已是最新'; return }
  $next = Join-Path $Root 'app.next'
  RemoveTree $next
  # 和 bootstrap 一样先装到盘内短路径（tmp\build）再搬回来：U 盘目录本来就深，
  # 直接 pnpm --dir app.next 会撞 MAX_PATH（"Could not find a part of the path ...js.map"）。
  $build = Join-Path $StageRoot 'app'
  RemoveTree $build
  New-Item -ItemType Directory -Path $build -Force | Out-Null
  $store = $StoreRoot
  & $Node $pnpm --dir $build add ("@deepseek-ai/dsh@" + $latest) --store-dir $store --config.package-import-method=$ImportMethod --config.node-linker=hoisted --config.strict-dep-builds=false --reporter append-only
  if ($LASTEXITCODE -ne 0) { RemoveTree $build; throw 'app 安装失败，旧版本未受影响' }
  Say '  搬到便携目录（robocopy，长路径安全）'
  $null = RoboCopyTree $build $next 'app'
  RemoveTree $build
  $bin = Join-Path $next 'node_modules\@deepseek-ai\dsh\lib\bin.js'
  if (-not (Test-Path -LiteralPath $bin)) { Remove-Item -LiteralPath $next -Recurse -Force -ErrorAction SilentlyContinue; throw 'app 安装结果不完整，已中止' }
  Swap-Tree 'app' 'app.next'
  Fix-OfficeRuntime
  Fix-OfficeCli
  Say ("app 现在版本：" + (AppVersion))
  RemoveOldBackups 'app.bak-' 1
  Remove-Item -LiteralPath (Join-Path $Root 'tmp\update-check.json') -Force -ErrorAction SilentlyContinue
}

# ---- 依赖探测：外部工具优先用系统自带的，缺失或不可用就退回随包 7z -------------------
# 真实事故：Windows 10 1703 不自带 tar.exe（1803 才随系统提供）。旧实现里 Bootstrap-Pnpm
# 硬断言"必须有系统 tar"，新机器上 node 装完就卡死在 pnpm，连带 app / 插件全失败，
# 最后只报一句"缺少 pnpm，无法下载插件"。
# 现在的规则（02-invariants 第 13 条）：任何外部工具都只做"探测 + 回退"，绝不硬依赖。
$script:DepCache = @{}

function Invoke-Native {
  # 直接起进程，**不经过 cmd**：cmd 会重新解析引号和重定向，实测 "cmd /c ""7z.exe" i" 会
  # 返回 exit 7（命令行错误），把"工具可用"误判成"不可用"。
  # 返回 code / out / err（stdout 与 stderr 分开收，绝不 2>&1 —— 见 02-invariants 第 9 条）。
  param([string]$Exe, [string[]]$ToolArgs = @(), [int]$TimeoutMs = 60000)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $quoted = @()
  foreach ($a in $ToolArgs) {
    $s = [string]$a
    # .NET Framework 只有 Arguments（整串），带空格的参数要自己加引号
    if ($s -match '[\s"]') { $quoted += ('"' + ($s -replace '"', '\"') + '"') } else { $quoted += $s }
  }
  $psi.Arguments = ($quoted -join ' ')
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  try {
    if (-not $p.Start()) { return [pscustomobject]@{ code = -1; out = ''; err = 'start failed' } }
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutMs)) {
      try { $p.Kill() } catch { }
      return [pscustomobject]@{ code = -1; out = ''; err = ('超时 ' + $TimeoutMs + ' ms') }
    }
    $out = ''
    $err = ''
    try { $out = $outTask.Result } catch { }
    try { $err = $errTask.Result } catch { }
    return [pscustomobject]@{ code = $p.ExitCode; out = $out; err = $err }
  }
  catch { return [pscustomobject]@{ code = -1; out = ''; err = $_.Exception.Message } }
  finally { try { $p.Dispose() } catch { } }
}
function Test-NativeTool {
  # 探测一个外部工具是否真的能用：能起来、退出码为 0、输出还能匹配期望特征才算 ok。
  param([string]$Exe, [string[]]$ToolArgs = @(), [string]$Expect = '', [int]$TimeoutMs = 20000)
  if (-not (Test-Path -LiteralPath $Exe)) { return [pscustomobject]@{ ok = $false; out = ''; code = -1 } }
  $r = Invoke-Native -Exe $Exe -ToolArgs $ToolArgs -TimeoutMs $TimeoutMs
  $text = ([string]$r.out + [string]$r.err)
  $ok = ($r.code -eq 0)
  if ($Expect -and $text -notmatch $Expect) { $ok = $false }
  return [pscustomobject]@{ ok = $ok; out = $text; code = $r.code }
}

function Resolve-Tar {
  # 只认系统自带那一个：PATH 上可能有 git-bash / WSL 的 GNU tar，行为不同，不能混用。
  # DSH_PORTABLE_NO_SYSTEM_TAR=1 只是测试开关（模拟 1703 这种没有 tar 的机器）。
  if ($script:DepCache.ContainsKey('tar')) { return $script:DepCache['tar'] }
  $path = $null
  $sys = Join-Path $env:SystemRoot 'System32\tar.exe'
  if ($env:DSH_PORTABLE_NO_SYSTEM_TAR -ne '1' -and (Test-Path -LiteralPath $sys)) {
    if ((Test-NativeTool $sys @('--version') 'tar').ok) { $path = $sys }
  }
  $script:DepCache['tar'] = $path
  return $path
}

function Resolve-SevenZip {
  # 随包 7z：exe 与 7z.dll 缺一不可，而且要真跑一次（杀软拦截 exe 时这里就会暴露）。
  if ($script:DepCache.ContainsKey('7z')) { return $script:DepCache['7z'] }
  $path = $null
  if ((Test-Path -LiteralPath $SevenZip) -and (Test-Path -LiteralPath (Join-Path $Root 'tools\7z\7z.dll'))) {
    if ((Test-NativeTool $SevenZip @('i') '7-Zip').ok) { $path = $SevenZip }
  }
  $script:DepCache['7z'] = $path
  return $path
}

function Resolve-Robocopy {
  if ($script:DepCache.ContainsKey('robocopy')) { return $script:DepCache['robocopy'] }
  $path = $null
  $sys = Join-Path $env:SystemRoot 'System32\robocopy.exe'
  if (Test-Path -LiteralPath $sys) { $path = $sys }
  else {
    $found = @(Get-Command 'robocopy.exe' -ErrorAction SilentlyContinue)
    if ($found.Count -gt 0) { $path = $found[0].Source }
  }
  $script:DepCache['robocopy'] = $path
  return $path
}

function Resolve-Curl {
  # 系统自带 curl（Win10 1803+）可以当"下载兜底"：本机有就用，没有也不去下载安装。
  if ($script:DepCache.ContainsKey('curl')) { return $script:DepCache['curl'] }
  $path = $null
  $sys = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (Test-Path -LiteralPath $sys) { $path = $sys }
  else {
    $found = @(Get-Command 'curl.exe' -ErrorAction SilentlyContinue)
    if ($found.Count -gt 0) { $path = $found[0].Source }
  }
  $script:DepCache['curl'] = $path
  return $path
}

function Set-TlsPolicy {
  # 老系统的 .NET 默认可能不协商 TLS 1.2，CDN 会直接断连；显式抬一档，失败就算了。
  try {
    $proto = [System.Net.SecurityProtocolType]::Tls12
    if ([enum]::GetNames([System.Net.SecurityProtocolType]) -contains 'Tls13') {
      $proto = $proto -bor [System.Net.SecurityProtocolType]'Tls13'
    }
    [System.Net.ServicePointManager]::SecurityProtocol = $proto
  }
  catch { }
}

function Test-Network {
  # 只用来决定"给不给友好提示"，绝不阻断流程；连不上就当离线。
  param([int]$TimeoutMs = 3000)
  foreach ($target in @('registry.npmjs.org', 'nodejs.org')) {
    try {
      $client = New-Object System.Net.Sockets.TcpClient
      try {
        $task = $client.ConnectAsync($target, 443)
        if ($task.Wait($TimeoutMs) -and $client.Connected) { return $true }
      }
      finally { try { $client.Close() } catch { } }
    }
    catch { }
  }
  return $false
}

function Get-UnpackerChain {
  # 解包候选顺序：系统 tar（有就用）→ 随包 7z（始终在）→ Expand-Archive（仅 zip，最后手段）
  param([switch]$TarGz)
  $chain = @()
  if (Resolve-Tar) { $chain += 'tar' }
  if (Resolve-SevenZip) { $chain += '7z' }
  if (-not $TarGz) { $chain += 'ps' }
  return $chain
}

function Expand-WithTar {
  # exFAT 上 bsdtar 还原不了时间戳：每个文件一行 "Can't restore time"，退出码 1，文件其实是好的。
  # 所以按行过滤这两类噪声，只看真正的错误；目录为空也算失败（换下一个解包档）。
  param([string]$Archive, [string]$Dest, [switch]$TarGz)
  $tar = Resolve-Tar
  if (-not $tar) { throw '系统 tar 不可用' }
  $flags = if ($TarGz) { '-xzf' } else { '-xf' }
  $r = Invoke-Native -Exe $tar -ToolArgs @($flags, $Archive, '-C', $Dest) -TimeoutMs 900000
  $all = @((([string]$r.out) + "`n" + ([string]$r.err)) -split "`r?`n" | Where-Object { $_ })
  $noise = @($all | Where-Object { ($_ -notmatch 'restore time') -and ($_ -notmatch 'Error exit delayed') })
  if ($noise.Count -gt 0) { throw ('tar 报错：' + (@($noise | Select-Object -First 3) -join '; ')) }
  if (-not (Get-ChildItem -LiteralPath $Dest -Force -ErrorAction SilentlyContinue)) { throw 'tar 解包后目录为空' }
  if ($all.Count -gt 0) { Say ('  已解包（忽略 ' + $all.Count + ' 条 exFAT 时间戳警告）') }
}

function Expand-WithSevenZip {
  # 7z 自带 gzip 解码：tar.gz 要走两趟（gz -> tar -> 文件）。7z 不产生时间戳噪声。
  param([string]$Archive, [string]$Dest, [switch]$TarGz)
  $seven = Resolve-SevenZip
  if (-not $seven) { throw '随包 7z 不可用（tools\7z 缺失或被拦截）' }
  if (-not (Test-Path -LiteralPath $UpdateCache)) { New-Item -ItemType Directory -Force -Path $UpdateCache | Out-Null }
  if ($TarGz) {
    $mid = Join-Path $UpdateCache ('7z-mid-' + [guid]::NewGuid().ToString('N'))
    try {
      New-Item -ItemType Directory -Path $mid -Force | Out-Null
      $r1 = Invoke-Native -Exe $seven -ToolArgs @('x', $Archive, ('-o' + $mid), '-y', '-bso0', '-bsp0') -TimeoutMs 900000
      if ($r1.code -ge 2) { throw ('7z 解 gzip 失败（exit ' + $r1.code + '）：' + ([string]$r1.err).Trim()) }
      $inner = @(Get-ChildItem -LiteralPath $mid -File -Filter '*.tar' -ErrorAction SilentlyContinue)
      if ($inner.Count -eq 0) { throw '7z 解 gzip 后没有 .tar 文件' }
      $r2 = Invoke-Native -Exe $seven -ToolArgs @('x', $inner[0].FullName, ('-o' + $Dest), '-y', '-bso0', '-bsp0') -TimeoutMs 900000
      if ($r2.code -ge 2) { throw ('7z 解 tar 失败（exit ' + $r2.code + '）：' + ([string]$r2.err).Trim()) }
    }
    finally { RemoveTree $mid }
    return
  }
  $r = Invoke-Native -Exe $seven -ToolArgs @('x', $Archive, ('-o' + $Dest), '-y', '-bso0', '-bsp0') -TimeoutMs 900000
  if ($r.code -ge 2) { throw ('7z 解包失败（exit ' + $r.code + '）：' + ([string]$r.err).Trim()) }
}

function Expand-ArchiveLike {
  # 统一解包入口：按候选链逐档尝试，每档解完都做结构校验，全失败才抛错。
  # -Expect 传"解出来必须存在的相对路径"，用来识别"工具说成功但产物不对"。
  param(
    [string]$Archive,
    [string]$Dest,
    [string[]]$Expect = @(),
    [switch]$TarGz
  )
  if (-not (Test-Path -LiteralPath $Archive)) { throw ('找不到压缩包：' + $Archive) }
  $chain = @(Get-UnpackerChain -TarGz:$TarGz)
  if ($chain.Count -eq 0) { throw '没有可用的解包工具（系统 tar 与随包 7z 都不可用）' }
  $failed = @()
  foreach ($kind in $chain) {
    if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Path $Dest -Force | Out-Null
    $err = $null
    try {
      if ($kind -eq 'tar') { Expand-WithTar $Archive $Dest -TarGz:$TarGz }
      elseif ($kind -eq '7z') { Expand-WithSevenZip $Archive $Dest -TarGz:$TarGz }
      else { Expand-Archive -LiteralPath $Archive -DestinationPath $Dest -Force }
      if ($Expect.Count -gt 0) {
        $missing = @($Expect | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Dest $_)) })
        if ($missing.Count -gt 0) { $err = ('解出来缺少 ' + ($missing -join ', ')) }
      }
    }
    catch { $err = $_.Exception.Message }
    if (-not $err) {
      if ($failed.Count -gt 0) {
        $names = (@($failed) | ForEach-Object { ($_ -split ':')[0] }) -join '/'
        Say ('  解包工具：' + $kind + '（' + $names + ' 不可用，已自动换用）')
      }
      return $kind
    }
    $failed += ($kind + ': ' + $err)
  }
  throw ('解包失败，候选都试过了 → ' + ($failed -join '；') + '。运行 dsh-portable.cmd doctor 可查看依赖状态。')
}

function Get-DepsText {
  # doctor 与 bootstrap 共用的一行"这台机器上到底有哪些工具"。
  $bits = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
  $tarTxt = if (Resolve-Tar) { 'ok' } else { 'missing(用随包7z)' }
  $sevenTxt = if (Resolve-SevenZip) { 'ok' } else { 'MISSING' }
  $roboTxt = if (Resolve-Robocopy) { 'ok' } else { 'MISSING' }
  $curlTxt = if (Resolve-Curl) { 'ok' } else { 'none' }
  return ('tar=' + $tarTxt + ' 7z=' + $sevenTxt + ' robocopy=' + $roboTxt + ' curl=' + $curlTxt +
          ' ps=' + $PSVersionTable.PSVersion + ' os=' + [Environment]::OSVersion.Version.ToString() + ' ' + $bits)
}

function Say-Deps {
  # bootstrap 开头把依赖状态亮出来：哪一步会因为缺工具而失败，一眼就能看到。
  Say ('  依赖：' + (Get-DepsText))
}

function Assert-HostReady {
  # 自举前的硬门槛：不满足就说清楚并退出，别先下 700 MB 才失败。
  $errs = @()
  if ($PSVersionTable.PSVersion.Major -lt 5) {
    $errs += ('PowerShell 版本过低（' + $PSVersionTable.PSVersion + '）：本壳需要 5.0+，Windows 10 自带 5.1')
  }
  if (-not [Environment]::Is64BitOperatingSystem) {
    $errs += '这台机器是 32 位 Windows：官方 dsh 与随包 7z 都只有 x64 版本'
  }
  if (@(Get-UnpackerChain).Count -eq 0) {
    $errs += '没有可用的解包工具：系统 tar 与 tools\7z 都不可用（系统被裁剪？杀软拦截？）'
  }
  foreach ($e in $errs) { Warn2 ('  x ' + $e) }
  if ($errs.Count -gt 0) {
    Say '自举没有开始（避免白下 700 MB）。先解决上面的问题，或用"整包复制"把已装好的目录搬过来。'
    return $false
  }
  return $true
}
# ---- 自举：只拿到"壳"的新机器，把官方那层补齐 ---------------------------------
# 场景：git 仓库里只有便携壳（根目录脚本 + tools\ + home\profiles\*.json）。
# 目标：跑一次 preflight.cmd（或 dsh-portable.cmd bootstrap）就自动下载官方 dsh
# （node 运行时 / pnpm / app / desktop / 插件依赖），全程带进度条；
# 已经存在的部分一律跳过，所以可以反复跑、断了重跑。
$NodeWanted = 'v24.21.0'
$PnpmWanted = '11.28.5'

function Have-RuntimeNode { return (Test-Path -LiteralPath $Node) }
function Have-Pnpm { return (Test-Path -LiteralPath (Join-Path $Root 'runtime\pnpm\dist\pnpm.mjs')) }
function Have-App { return (Test-Path -LiteralPath (Join-Path $Root 'app\node_modules\@deepseek-ai\dsh\lib\bin.js')) }
function Have-Desktop { return (Test-Path -LiteralPath (Join-Path $Root 'desktop\resources\app.asar')) }

function Get-MissingParts {
  # 自举还缺哪几块：只用来决定"要不要联网"、给用户看进度，不参与安装逻辑本身。
  $need = @()
  if (-not (Have-RuntimeNode)) { $need += 'node' }
  if (-not (Have-Pnpm)) { $need += 'pnpm' }
  if (-not (Have-App)) { $need += 'app' }
  if (-not (Have-Desktop)) { $need += 'desktop' }
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'home\profiles\node_modules\dshmarket\package.json'))) { $need += 'plugins' }
  return $need
}

function Download-File([string]$Url, [string]$Dest, [string]$Label, [switch]$Reuse) {
  # 自己读流 + Write-Progress：比 Invoke-WebRequest 快得多，也比 WebClient 事件好控。
  # 先写 .part，长度对上才改名 —— 中途断掉不会留下"看起来完整"的坏文件。
  # -Reuse：cache\update 里已有同名文件就直接用（断网重跑、或自举多次时不重复下 700 MB）。
  if ($Reuse -and (Test-Path -LiteralPath $Dest)) {
    $size = (Get-Item -LiteralPath $Dest).Length
    $sidecar = "$Dest.size"
    $want = 0
    if (Test-Path -LiteralPath $sidecar) { $want = [int64](Get-Content -LiteralPath $sidecar -ErrorAction SilentlyContinue | Select-Object -First 1) }
    # 有 .size 就按长度核对（缓存被写坏/截断时不会"看似完整"地继续用）；没有就退回 1 MB 下限
    if (($want -gt 0 -and $size -eq $want) -or ($want -eq 0 -and $size -ge 1MB)) {
      Say ('  复用已下载的缓存：' + (Split-Path -Leaf $Dest) + '（' + [math]::Round($size / 1MB, 1) + ' MB，长度已核对）')
      return
    }
    Say ('  缓存长度对不上（' + $size + ' 字节），重新下载：' + (Split-Path -Leaf $Dest))
    RemoveTree $Dest
    Remove-Item -LiteralPath $sidecar -Force -ErrorAction SilentlyContinue
  }
  if ($env:DSH_PORTABLE_OFFLINE -eq '1') {
    throw ('已设 DSH_PORTABLE_OFFLINE=1（离线模式），不会下载：' + (Split-Path -Leaf $Dest))
  }
  $dir = Split-Path -Parent $Dest
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $part = "$Dest.part"
  Say ("  下载：" + $Url)
  $total = [int64]0
  $got = [int64]0
  $done = $false
  Set-TlsPolicy
  try {
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Timeout = 60000
    $req.ReadWriteTimeout = 300000
    $req.UserAgent = 'Hack3rX-Harness-bootstrap'
    $resp = $req.GetResponse()
    $total = [int64]$resp.ContentLength
    $in = $resp.GetResponseStream()
    $out = [System.IO.File]::Create($part)
    $buf = New-Object byte[] 262144
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $lastMs = 0
    try {
      while (($read = $in.Read($buf, 0, $buf.Length)) -gt 0) {
        $out.Write($buf, 0, $read)
        $got += $read
        if (($sw.ElapsedMilliseconds - $lastMs) -ge 400) {
          $lastMs = $sw.ElapsedMilliseconds
          $pct = 0
          if ($total -gt 0) { $pct = [int][math]::Min(100, [math]::Round(100 * $got / $total)) }
          $speed = $got / [math]::Max($sw.Elapsed.TotalSeconds, 0.001) / 1MB
          Write-Progress -Activity $Label -Status ("{0:N1} / {1:N1} MB   {2:N1} MB/s" -f ($got / 1MB), ($total / 1MB), $speed) -PercentComplete $pct
        }
      }
    }
    finally {
      $out.Close(); $in.Close(); $resp.Close()
      Write-Progress -Activity $Label -Completed
    }
    $done = $true
  }
  catch {
    Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
    Warn2 ('  .NET 下载失败：' + $_.Exception.Message)
  }
  if (-not $done) {
    # 兜底：系统自带 curl（Win10 1803+ 有；没有就直接报错，绝不临时下载任何工具）
    $curl = Resolve-Curl
    if (-not $curl) { throw ('下载失败，且这台机器没有 curl 可兜底（多为网络/代理问题）：' + $Url) }
    Say '  改用系统 curl 重试'
    $curlLine = '/c ""' + $curl + '" -L --fail --retry 2 --retry-delay 1 -o "' + $part + '" "' + $Url + '" >nul 2>&1"'
    & $env:ComSpec $curlLine | Out-Null
    $curlCode = $LASTEXITCODE
    if ($curlCode -ne 0 -or -not (Test-Path -LiteralPath $part)) {
      Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
      throw ('下载失败（curl exit ' + $curlCode + '）：' + $Url)
    }
    $got = (Get-Item -LiteralPath $part).Length
  }
  if ($total -gt 0 -and $got -ne $total) {
    Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
    throw ("下载不完整：" + $got + " / " + $total + " 字节（已删半成品）")
  }
  Move-Item -LiteralPath $part -Destination $Dest -Force
  # 记下长度，下次 -Reuse 时用它核对（缓存损坏时能自己发现）
  Set-Content -LiteralPath "$Dest.size" -Value $got -Encoding ASCII
  Say ("  完成：" + [math]::Round($got / 1MB, 1) + " MB")
}

function Expand-ZipFile([string]$Zip, [string]$Dest) {
  # 兼容旧调用点：统一走"探测 + 回退"的解包链（系统 tar → 随包 7z → Expand-Archive）。
  $null = Expand-ArchiveLike -Archive $Zip -Dest $Dest
}

function Bootstrap-Node {
  if (Have-RuntimeNode) { Say ('  node：已有 ' + (& $Node -v) + '，跳过'); return }
  Say ("node：没有便携运行时，下载官方 " + $NodeWanted + "（约 33 MB）")
  $zip = Join-Path $UpdateCache ("node-" + $NodeWanted + "-win-x64.zip")
  Download-File ("https://nodejs.org/dist/" + $NodeWanted + "/node-" + $NodeWanted + "-win-x64.zip") $zip ('node ' + $NodeWanted) -Reuse
  $nodeExeRel = 'node-' + $NodeWanted + '-win-x64\node.exe'
  $stage = Join-Path $UpdateCache 'node-stage'
  $null = Expand-ArchiveLike -Archive $zip -Dest $stage -Expect @($nodeExeRel)
  $inner = Join-Path $stage ("node-" + $NodeWanted + "-win-x64")
  if (-not (Test-Path -LiteralPath (Join-Path $inner 'node.exe'))) {
    # 缓存的 zip 坏了（下载被截断、或磁盘写入出错）：删掉重新下一次，不让人手工去清 cache\update
    Say '  缓存的 node 压缩包不完整，删掉重新下载一次'
    RemoveTree $stage
    RemoveTree $zip
    Remove-Item -LiteralPath "$zip.size" -Force -ErrorAction SilentlyContinue
    Download-File ("https://nodejs.org/dist/" + $NodeWanted + "/node-" + $NodeWanted + "-win-x64.zip") $zip ('node ' + $NodeWanted)
    $null = Expand-ArchiveLike -Archive $zip -Dest $stage -Expect @($nodeExeRel)
    $inner = Join-Path $stage ("node-" + $NodeWanted + "-win-x64")
  }
  if (-not (Test-Path -LiteralPath (Join-Path $inner 'node.exe'))) { throw 'node 压缩包结构异常（找不到 node.exe）' }
  $target = Join-Path $Root 'runtime\node'
  RemoveTree $target
  New-Item -ItemType Directory -Path (Join-Path $target 'bin') -Force | Out-Null
  Move-Item -LiteralPath (Join-Path $inner 'node.exe') -Destination (Join-Path $target 'bin\node.exe')
  Get-ChildItem -LiteralPath $inner -Force | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination $target -Force }
  # 官方 zip 里的 npm/corepack 用不上（插件一律走 pnpm），清掉省 20 MB
  foreach ($junk in @('npm', 'corepack')) {
    $p = Join-Path $target ("node_modules\" + $junk)
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
  }
  $nm = Join-Path $target 'node_modules'
  if (-not (Test-Path -LiteralPath $nm)) { New-Item -ItemType Directory -Path $nm -Force | Out-Null }
  Set-Content -LiteralPath (Join-Path $nm 'README.txt') -Encoding ASCII -Value 'reserved for the bundled node runtime; npm/corepack intentionally removed (plugins are installed with pnpm)'
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  # 解包成功不等于能跑（老系统缺运行库 / 被杀软拦都会在这里暴露），装完立刻冒烟一次
  $probe = Test-NativeTool $Node @('-v') '^v\d+\.'
  if (-not $probe.ok) {
    $hint = (@($probe.out -split "`r?`n") | Where-Object { $_ }) -join ' '
    throw ('node 解包成功但无法在这台机器上运行（系统版本过低 / 缺运行库 / 被杀软拦截？）：' + $hint)
  }
  Say ('  node：' + $probe.out.Trim() + ' 就绪')
}

function Bootstrap-Pnpm {
  if (Have-Pnpm) { Say '  pnpm：已存在，跳过'; return }
  if (-not (Have-RuntimeNode)) { throw '还没有 node，无法解出 pnpm' }
  Say ("pnpm：下载 npm 包 " + $PnpmWanted + "（约 4 MB）")
  $tgz = Join-Path $UpdateCache ("pnpm-" + $PnpmWanted + ".tgz")
  Download-File ("https://registry.npmjs.org/pnpm/-/pnpm-" + $PnpmWanted + ".tgz") $tgz 'pnpm' -Reuse
  $stage = Join-Path $UpdateCache 'pnpm-stage'
  RemoveTree $stage
  # 不再硬依赖系统 tar（Win10 1703 没有它）：系统 tar → 随包 7z；都失败就删缓存重下一次
  try {
    $null = Expand-ArchiveLike -Archive $tgz -Dest $stage -TarGz -Expect @('package\dist\pnpm.mjs')
  }
  catch {
    Say ('  解包 pnpm 失败（' + $_.Exception.Message + '），删掉缓存重新下载一次')
    RemoveTree $stage
    RemoveTree $tgz
    Remove-Item -LiteralPath "$tgz.size" -Force -ErrorAction SilentlyContinue
    Download-File ("https://registry.npmjs.org/pnpm/-/pnpm-" + $PnpmWanted + ".tgz") $tgz 'pnpm'
    $null = Expand-ArchiveLike -Archive $tgz -Dest $stage -TarGz -Expect @('package\dist\pnpm.mjs')
  }
  $pkg = Join-Path $stage 'package'
  if (-not (Test-Path -LiteralPath (Join-Path $pkg 'dist\pnpm.mjs'))) { throw 'pnpm 包结构异常（缺少 dist\pnpm.mjs）' }
  $target = Join-Path $Root 'runtime\pnpm'
  RemoveTree $target
  Move-Item -LiteralPath $pkg -Destination $target
  if (-not (Test-Path -LiteralPath (Join-Path $target 'bin'))) { New-Item -ItemType Directory -Path (Join-Path $target 'bin') -Force | Out-Null }
  RemoveTree $stage
  Set-PnpmShim
  Say '  pnpm：就绪'
}

function Set-PnpmShim {
  # runtime\pnpm\bin 里只有 pnpm.cjs / pnpm.mjs，没有 cmd.exe 能按名字找到的 pnpm.cmd。
  # 于是 env.cmd 的 "PATH 置顶" 完全不生效：dsh 的 `dsh plugin …` 会命中机器上任意一代 pnpm
  # （实测同一台机器上同时存在全局 10.33.0 与便携 11.28.5，store 布局 v10 / v11 因此混用，
  #  pnpm 报 ERR_PNPM_UNEXPECTED_STORE，插件市场连卸载都做不了）。
  # runtime\ 不进 git，所以这份垫片只能由脚本生成——不能靠提交，也不能假设它一直在。
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'runtime\pnpm\dist\pnpm.mjs'))) { return }
  $bin = Join-Path $Root 'runtime\pnpm\bin'
  if (-not (Test-Path -LiteralPath $bin)) { New-Item -ItemType Directory -Path $bin -Force | Out-Null }
  foreach ($pair in @(@('pnpm.cmd', 'pnpm.mjs'), @('pnpx.cmd', 'pnpx.mjs'))) {
    $file = Join-Path $bin $pair[0]
    $body = "@echo off`r`n`"%~dp0..\..\node\bin\node.exe`" `"%~dp0" + $pair[1] + "`" %*`r`n"
    $same = $false
    if (Test-Path -LiteralPath $file) {
      try { $same = ([System.IO.File]::ReadAllText($file) -eq $body) } catch { $same = $false }
    }
    if (-not $same) {
      # 纯 ASCII + CRLF：cmd.exe 按字节解析，中文或 LF 都会出事（见 02-invariants.md 第 1 条）
      [System.IO.File]::WriteAllText($file, $body, (New-Object System.Text.ASCIIEncoding))
    }
  }
}

function Get-PnpmMajorRuntime {
  # 壳自带 pnpm 的大版本（v11）。store 布局目录名就是这个版本段，换一代就等于换一个 store。
  $pkg = Join-Path $Root 'runtime\pnpm\package.json'
  if (-not (Test-Path -LiteralPath $pkg)) { return $null }
  try {
    $v = (Json $pkg).version
    if (-not $v) { return $null }
    return ('v' + ($v -split '\.')[0])
  } catch { return $null }
}

function Get-ProfileStoreMajor {
  # home\profiles\node_modules\.modules.yaml 里记录的 store 大版本——它说的就是"这些包实际在哪个 store"。
  # 优先用 storeDir 的版本段；pnpm 也写 packageManager，两者一致，兜底用它。
  $f = Join-Path $Root 'home\profiles\node_modules\.modules.yaml'
  if (-not (Test-Path -LiteralPath $f)) { return $null }
  try {
    $j = Json $f
    if ($j -and $j.storeDir -and ($j.storeDir -match '\\v(\d+)$')) { return ('v' + $Matches[1]) }
    if ($j -and $j.packageManager -and ($j.packageManager -match '^pnpm@(\d+)\.')) { return ('v' + $Matches[1]) }
  } catch { return $null }
  return $null
}

function Get-PnpmStateText {
  # doctor 的一行：版本 / 垫片 / profile 记录 / 是否对齐。只读，不改任何东西。
  $want = Get-PnpmMajorRuntime
  if (-not $want) { return 'MISSING（没有 runtime\pnpm，先 bootstrap）' }
  $ver = ''
  try { $ver = (Json (Join-Path $Root 'runtime\pnpm\package.json')).version } catch { }
  $shim = Test-Path -LiteralPath (Join-Path $Root 'runtime\pnpm\bin\pnpm.cmd')
  $have = Get-ProfileStoreMajor
  # 光比大版本会给出假阳性：profile 里记的 storeDir 可能指向一个已经不存在的路径（比如把 store 搬进盘内之后）。
  # 所以再核对"记录的 storeDir 是否存在"和"盘内 store 是否有内容"两件事。
  $recDir = ''
  try {
    $mj = Join-Path $Root 'home\profiles\node_modules\.modules.yaml'
    if (Test-Path -LiteralPath $mj) {
      $raw = Get-Content -LiteralPath $mj -Raw -ErrorAction Stop
      if ($raw -match '"storeDir"\s*:\s*"([^"]+)"') { $recDir = $Matches[1] -replace '\\\\', '\' }
    }
  } catch { }
  $recExists = $false
  if ($recDir) { $recExists = Test-Path -LiteralPath $recDir }
  $storeRootNow = Join-Path $Root 'cache\pnpm-store'
  $storeHasContent = $false
  foreach ($cand in @((Join-Path $storeRootNow 'v11\index.db'), (Join-Path $storeRootNow 'index.db'))) {
    if (Test-Path -LiteralPath $cand) { $storeHasContent = $true }
  }
  if ($have -eq $want -and $recExists) { $state = 'aligned' }
  elseif ($have -eq $want -and -not $recExists) { $state = ('STORE-GONE（记录里是 ' + $recDir + '，已不存在；跑 dsh-portable.cmd fix-state 或 migrate-store）') }
  elseif (-not $have) { $state = 'no node_modules' }
  else { $state = ('MISMATCH ' + $have + ' -> ' + $want + '  << 运行 dsh-portable.cmd plugin-repair -Force') }
  if (-not $storeHasContent) { $state = $state + ' / 盘内 store 还是空的' }
  return ($ver + ' / shim=' + $(if ($shim) { 'ok' } else { 'MISSING' }) + ' / store=' + $(if ($have) { $have } else { '-' }) + ' / ' + $state)
}

function Repair-PluginEnv {
  # 插件依赖环境重建：把 home\profiles\node_modules 换成"壳自带那一代 pnpm"的布局。
  # 为什么必须重建而不是改配置：pnpm 总会把 store 根追加成 <root>\vN，配置里写什么都不可能
  # 让 11 去用 10 的 store（实测 --store-dir X\v10 -> X\v10\v11）。而官方报错里那句
  # "把记录里的 store 写进 pnpm-workspace.yaml" 只适用于"路径变了、大版本没变"。
  # 重建不动 node_modules 以外的任何东西；失败会把三份清单原样放回，可反复重跑。
  $prof = Join-Path $Root 'home\profiles'
  $want = Get-PnpmMajorRuntime
  if (-not $want) { throw '没有 runtime\pnpm，无法确定目标 pnpm 大版本（先 dsh-portable.cmd bootstrap）' }
  $have = Get-ProfileStoreMajor
  if ($have -eq $want) {
    Say ('  插件环境已经对齐（' + $want + '），只做清单与市场补丁同步')
    $null = Plugin-Tool @('sync', '--quiet')
    try { Fix-MarketPatch -Quiet } catch { }
    return
  }
  Say ('  需要重建：node_modules 记录 ' + $(if ($have) { $have } else { '(无)' }) + '，壳自带 pnpm 是 ' + $want)
  # 桌面端/浏览器端在跑时 node_modules 会被占用：删一半再失败比不删更糟，直接拒绝
  if (DesktopRunning) { throw '桌面窗口正在运行：先 close-desktop（或彻底退出 DeepSeek Harness）再重建插件依赖' }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $bak = Join-Path $Root ('cache\plugin-repair-' + $stamp)
  if (-not (Test-Path -LiteralPath $bak)) { New-Item -ItemType Directory -Path $bak -Force | Out-Null }
  foreach ($rel in @('', 'web', 'desktop')) {
    $src = if ($rel) { Join-Path $prof $rel } else { $prof }
    $dst = if ($rel) { Join-Path $bak $rel } else { $bak }
    if (-not (Test-Path -LiteralPath $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
    foreach ($f in @('package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml')) {
      $s = Join-Path $src $f
      if (Test-Path -LiteralPath $s) { Copy-Item -LiteralPath $s -Destination (Join-Path $dst $f) -Force }
    }
  }
  Say ('  三份清单已备份到 ' + $bak)
  foreach ($t in @((Join-Path $prof 'node_modules'), (Join-Path $prof 'web\node_modules'), (Join-Path $prof 'desktop\node_modules'))) {
    if (Test-Path -LiteralPath $t) { RemoveTree $t }
  }
  try {
    $pnpm = Join-Path $Root 'runtime\pnpm\dist\pnpm.mjs'
    if (-not (Test-Path -LiteralPath $pnpm)) { throw '缺少 runtime\pnpm\dist\pnpm.mjs' }
    $store = $StoreRoot
    Say '  正在用壳自带的 pnpm 重装插件依赖（包大多已在本地 store 里，通常很快）……'
    & $Node $pnpm --dir $prof install --store-dir $store --config.package-import-method=$ImportMethod --config.confirmModulesPurge=false --config.strict-dep-builds=false --reporter append-only
    if ($LASTEXITCODE -ne 0) { throw ('插件依赖安装失败（exit ' + $LASTEXITCODE + '）。清单已备份在 ' + $bak + '，处理完网络/权限后重跑本命令即可') }
    $null = Plugin-Tool @('sync', '--quiet')
    Fix-MarketPatch -Quiet
    Fix-PnpmState -Quiet
    $now = Get-ProfileStoreMajor
    Say ('  重建完成：node_modules 现在记录 ' + $(if ($now) { $now } else { '(未知)' }) + '，目标 ' + $want)
    if ($now -ne $want) { throw '重建后记录仍不对齐，请把这条输出一起回报（logs\ 里有细节）' }
  }
  catch {
    Say '  重建失败，正在把三份清单放回原位（node_modules 留空，下次重跑即可）'
    foreach ($rel in @('', 'web', 'desktop')) {
      $src = if ($rel) { Join-Path $bak $rel } else { $bak }
      $dst = if ($rel) { Join-Path $prof $rel } else { $prof }
      if (-not (Test-Path -LiteralPath $src)) { continue }
      foreach ($f in @('package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml')) {
        $s = Join-Path $src $f
        if (Test-Path -LiteralPath $s) { Copy-Item -LiteralPath $s -Destination (Join-Path $dst $f) -Force }
      }
    }
    throw
  }
}

function RemoveTree([string]$path) {
  # 删一棵可能带超长路径的目录。普通 Remove-Item / rmdir 在 >260 字符处会报
  # "Could not find a part of the path"，用 \\?\ 前缀才能绕过 MAX_PATH。
  if (-not $path) { return }
  if (-not (Test-Path -LiteralPath $path)) { return }
  # exFAT + 杀软/索引器常把删除卡在 EBUSY/EPERM 上几秒：退避重试比"删不掉就静默放弃"可靠。
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $long = '\\?\' + $path
    try { Remove-Item -LiteralPath $long -Recurse -Force -ErrorAction Stop; return } catch { }
    # 这里同样不能 2>&1：$ErrorActionPreference='Stop' 会把 cmd 的 stderr 变成终止错误，
    # 结果是"删不掉就静默回退"在最需要它的时候（文件被占用）反而抛出底层错误、盖住调用方真正关心的原因。
    $rmLog = Join-Path $env:TEMP 'dsh-rmtree.log'
    & $env:ComSpec ('/c rmdir /s /q "' + $long + '" 2> "' + $rmLog + '"') | Out-Null
    if (-not (Test-Path -LiteralPath $path)) { return }
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $path)) { return }
    Start-Sleep -Milliseconds (200 * $attempt)
  }
  Warn2 ('删不掉：' + $path + '（可能被占用；稍后重试或先关掉桌面窗口）')
}

function RoboCopyTree([string]$src, [string]$dst, [string]$label) {
  # 自举专用：把短路径里装好的东西搬到便携目录。
  # robocopy 走 cmd 重定向，避免 $ErrorActionPreference='Stop' 把它的 stderr 变成终止错误；
  # exit >= 8 视为失败（8 = 有文件没复制成功），并把日志尾部带进错误信息，便于定位长路径问题。
  if (-not (Test-Path -LiteralPath $dst)) { New-Item -ItemType Directory -Force -Path $dst | Out-Null }
  # 日志父目录必须先建：cmd 重定向在目录不存在时静默失败，会让"复制没做"看起来像成功
  if (-not (Test-Path -LiteralPath $UpdateCache)) { New-Item -ItemType Directory -Force -Path $UpdateCache | Out-Null }
  $log = Join-Path $UpdateCache 'robocopy.log'
  $rc = Resolve-Robocopy
  if (-not $rc) { throw ($label + ' 复制失败：系统没有 robocopy.exe（Windows 组件被裁剪？）') }
  $cmdLine = '/c ""' + $rc + '" "' + $src + '" "' + $dst + '" /E /R:2 /W:2 /NP /NFL /NDL /NJH > "' + $log + '" 2>&1"'
  & $env:ComSpec $cmdLine | Out-Null
  $code = $LASTEXITCODE
  if ($code -ge 8) {
    $tail = @(Get-Content -LiteralPath $log -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -Last 12) -join ' / '
    throw ($label + ' 复制失败（robocopy exit ' + $code + '）：' + $tail)
  }
  return $code
}

function SwapNext([string]$name) {
  # 自举换装：更新路径有 Swap-Tree 的 journal + Repair-State 兜底，自举这里简化成"失败就改回来"。
  # 先改名成 .bak-时间戳，换失败就把它改回原名：宁可留着旧版，也不留半个目录。
  $next = Join-Path $Root ($name + '.next')
  $target = Join-Path $Root $name
  if (-not (Test-Path -LiteralPath $next)) { throw ('缺少暂存目录 ' + $next) }
  $bak = $null
  if (Test-Path -LiteralPath $target) {
    $bak = Join-Path $Root ($name + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Move-Item -LiteralPath $target -Destination $bak
  }
  try { Move-Item -LiteralPath $next -Destination $target }
  catch {
    if ($bak) { try { Move-Item -LiteralPath $bak -Destination $target } catch { } }
    throw ('换装 ' + $name + ' 失败，已回滚到旧目录：' + $_.Exception.Message)
  }
  return $target
}

function Bootstrap-App {
  if (Have-App) { Say ('  app：已有 ' + (AppVersion) + '，跳过'); return }
  $pnpm = Join-Path $Root 'runtime\pnpm\dist\pnpm.mjs'
  if (-not (Test-Path -LiteralPath $pnpm)) { throw '缺少 pnpm，无法安装 app（先看上面 pnpm 那一步的失败原因）' }
  # 离线时 node 只往 stderr 写、stdout 是空的；先收集原始输出再判空，
  # 否则 $null.Trim() 会先抛"不能对 Null 值表达式调用方法"，"可能没联网"这条提示永远走不到。
  $rawVersion = & $Node -e "fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh/latest').then(r=>r.json()).then(j=>console.log(j.version)).catch(e=>{console.error(e.message);process.exit(1)})" 2>&1
  $versionExit = $LASTEXITCODE
  $latest = (@($rawVersion) -join ' ').Trim()
  if ($versionExit -ne 0 -or -not $latest) { throw ('无法查询 npm 上的官方版本（可能没联网）：' + $latest) }
  Say ("app：安装官方 @deepseek-ai/dsh@" + $latest + "（含 Office 引擎，解包后约 400 MB，慢在这一步）")
  # 两个坑：
  #   1) exFAT 不支持软链 → 必须 --config.node-linker=hoisted（默认 isolated 会在 symlinkAllModules 处 EISDIR）
  #   2) pnpm 10+ 默认 strictDepBuilds：有包没被允许跑构建脚本就整条命令失败（其实已经装好了），
  #      所以带 --config.strict-dep-builds=false（node-pty 有 prebuilds，不需要本地编译）
  #   3) U 盘路径本来就深，pnpm 在 app.next 里展开的路径会超过 260（MAX_PATH），
  #      报 "Could not find a part of the path 'xxx.js.map'"。所以先装到盘内短路径（tmp\build），
  #      再用 robocopy 搬回来（robocopy 原生支持长路径）。
  $build = Join-Path $StageRoot 'app'
  RemoveTree $build
  New-Item -ItemType Directory -Path $build -Force | Out-Null
  $store = $StoreRoot
  & $Node $pnpm --dir $build add ("@deepseek-ai/dsh@" + $latest) --store-dir $store --config.package-import-method=$ImportMethod --config.node-linker=hoisted --config.strict-dep-builds=false --reporter append-only
  if ($LASTEXITCODE -ne 0) { RemoveTree $build; throw 'app 安装失败' }
  if (-not (Test-Path -LiteralPath (Join-Path $build 'node_modules\@deepseek-ai\dsh\lib\bin.js'))) {
    RemoveTree $build
    throw 'app 安装结果不完整'
  }
  $next = Join-Path $Root 'app.next'
  RemoveTree $next
  Say '  搬到便携目录（robocopy，长路径安全）'
  $null = RoboCopyTree $build $next 'app'
  RemoveTree $build
  if (-not (Test-Path -LiteralPath (Join-Path $next 'node_modules\@deepseek-ai\dsh\lib\bin.js'))) {
    RemoveTree $next
    throw '复制到便携目录后校验失败'
  }
  $null = SwapNext 'app'
  try { Fix-OfficeRuntime } catch { }
  try { Fix-OfficeCli } catch { }
  Say ('  app：' + (AppVersion) + ' 就绪')
}

function Bootstrap-Desktop {
  if (Have-Desktop) { Say ('  desktop：已有 ' + (DesktopVersion) + '，跳过'); return }
  if (-not (Have-RuntimeNode)) { throw '还没有 node（上一步没成功），跳过 desktop' }
  if (-not (Test-Path -LiteralPath $SevenZip)) { throw ('缺少解包工具 ' + $SevenZip + '（tools\7z 必须随壳一起发布）') }
  $manifest = Get-Manifest
  Say ("desktop：下载官方安装包 " + $manifest.version + "（约 " + [math]::Round($manifest.size / 1MB) + " MB）")
  $installer = Get-Installer $manifest
  $next = Join-Path $Root 'desktop.next'
  if (Test-Path -LiteralPath $next) { RemoveTree $next }
  $stage = Join-Path $UpdateCache 'stage'
  RemoveTree $stage
  New-Item -ItemType Directory -Path $stage, $next -Force | Out-Null
  Say '  解包（第 1/2 层：安装包容器）'
  & $SevenZip x $installer ("-o" + $stage) -bsp1 -y | Out-Host
  if ($LASTEXITCODE -ge 2) { RemoveTree $stage; throw '第 1 层解包失败' }
  $innerArchive = Join-Path $stage '$PLUGINSDIR\app-64.7z'
  if (-not (Test-Path -LiteralPath $innerArchive)) { RemoveTree $stage; throw ('安装包结构异常：缺少 ' + $innerArchive) }
  Say '  解包（第 2/2 层：程序本体）'
  & $SevenZip x $innerArchive ("-o" + $next) -bsp1 -y | Out-Host
  if ($LASTEXITCODE -ge 2) { RemoveTree $next; throw '第 2 层解包失败' }
  RemoveTree $stage
  $err = TreeLooksValid $next
  if ($err) { RemoveTree $next; throw ("解出的目录不完整（" + $err + "）") }
  $upd = Join-Path $next 'resources\app-update.yml'
  if (Test-Path -LiteralPath $upd) { Move-Item -LiteralPath $upd -Destination "$upd.disabled" -Force }
  $null = SwapNext 'desktop'
  try { Fix-OfficeRuntime } catch { }
  Say ('  desktop：' + (DesktopVersion) + ' 就绪')
}

function Bootstrap-Profiles {
  # 商城与主题的依赖要落到 home\profiles\node_modules（两个 profile 的 modulesDir 都指向 ../node_modules）
  $prof = Join-Path $Root 'home\profiles'
  if (-not (Test-Path -LiteralPath $prof)) { throw ('缺少 ' + $prof + '（壳里应带 package.json 与 modulesDir 配置）') }
  if (Test-Path -LiteralPath (Join-Path $prof 'node_modules\dshmarket\package.json')) {
    Say '  插件：共享依赖已存在，只做清单对齐'
    $null = Plugin-Tool @('sync', '--quiet')
    return
  }
  $pnpm = Join-Path $Root 'runtime\pnpm\dist\pnpm.mjs'
  if (-not (Test-Path -LiteralPath $pnpm)) { throw '缺少 pnpm，无法安装插件依赖（先看上面 pnpm 那一步的失败原因）' }
  Say '  插件：按 home\profiles\package.json 安装商城与主题（约 20 MB）'
  $store = $StoreRoot
  & $Node $pnpm --dir $prof install --store-dir $store --config.package-import-method=$ImportMethod --config.confirmModulesPurge=false --config.strict-dep-builds=false --reporter append-only
  if ($LASTEXITCODE -ne 0) { throw '插件依赖安装失败（可重跑；或先 dsh-portable.cmd fix-state）' }
  $null = Plugin-Tool @('sync', '--quiet')
  Say '  插件：商城与主题就绪'
}
try {
# 只读动作不再顺手改包：原来 Repair-State 在分派前无条件执行（删 journal / .part / .next），
# 于是"跑一次 doctor"本身就成了修改。清理统一走 tidy、启动路径或 repair。
if ($Action -notin @('doctor', 'verify', 'plugin-list', 'plugin-stage-list', 'check-quiet', 'check-updates', 'sync-home', 'focus-desktop', 'show-desktop', 'clean-ship', 'fs-profile')) { Repair-State }

switch ($Action) {
  'repair' {
    Fix-Bom; Fix-PnpmState; Fix-Motw -IfNeeded; Fix-OfficeCli; Fix-MarketPatch; Clean-TempJunk
    # compat 档：exFAT 没有硬链接，给 dsh-fs-local 的"新建文件"补一条 rename 回退（NTFS 不动）；
    # 同时补商城路径与 pnpm 项目注册。三族都幂等，已打过是毫秒级检查。
    $patchRc = Repair-OfficialPatches -Quiet
    if ($patchRc -eq 4) { Warn2 '有补丁没打上（官方层可能刚升级过）：doctor 的 patches 三行有详情' }
    if ($patchRc -eq 1) { Warn2 '补丁写入失败（桌面程序可能占着 app.asar）：退出 DeepSeek Harness 后再修复' }
    if ($env:DSH_FS_PROFILE -eq 'compat') { $null = & $Node (Join-Path $Root 'tools\probe-fs.mjs') --quiet 2>&1 }
    $null = Plugin-Tool @('sync', '--quiet'); Say '已检查并修复中断残留'; break
  }
  'tidy' {
    # 显式清理：更新中断残留 + tmp 垃圾。doctor/verify 不再顺手做这些（只报 leftovers 计数）。
    # 桌面窗口在运行时默认拒绝（tmp\dsh-* 可能是活跃会话正在用的目录），-Force 可强来。
    if ((DesktopRunning) -and -not $Force) {
      Warn2 '桌面窗口正在运行：tmp 里可能有活跃会话正在用的目录。先关窗口再 tidy，或加 -Force。'
      exit 1
    }
    Repair-State
    Clean-TempJunk -Force
    # 旧树备份很大（desktop 一份约 1 GB、app 约 0.5 GB）：tidy 时只留最新 1 份；
    # 壳备份很小（<1 MB），留 2 份更安全。
    RemoveOldBackups 'desktop.bak-' 1
    RemoveOldBackups 'app.bak-' 1
    RemoveOldBackups 'shell-backup-' 2 -Dir (Join-Path $Root 'cache')
    if ($PurgeHostStore) {
      $extRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Hack3rX-Harness'
      $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
      $extFull = [System.IO.Path]::GetFullPath($extRoot).TrimEnd('\')
      $hasInFolder = (Test-Path -LiteralPath (Join-Path $StoreRoot 'v11\index.db')) -or (Test-Path -LiteralPath (Join-Path $StoreRoot 'index.db'))
      $storeUnderExt = ($StoreRoot -and ([System.IO.Path]::GetFullPath($StoreRoot).TrimEnd('\')).StartsWith($extFull + '\', [System.StringComparison]::OrdinalIgnoreCase))
      if ($storeUnderExt) {
        Warn2 ('拒绝清理：当前 store 就在外置残留目录里（' + $StoreRoot + '），它是正在用的，不是残留')
      }
      elseif ($rootFull -eq $extFull -or $rootFull.StartsWith($extFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        Warn2 ('拒绝清理：便携目录就在外置残留目录里（' + $extRoot + '），删了会把正在用的程序一起删掉')
      }
      elseif (-not (Test-Path -LiteralPath $extRoot)) { Say '外置残留：无' }
      elseif ((Test-Path -LiteralPath (Join-Path $extRoot 'pnpm-store')) -and -not $hasInFolder) {
        Warn2 '旧 store 还在用（盘内 store 是空的）：先运行 dsh-portable.cmd migrate-store，再清残留'
      }
      else {
        # 只清已知的两个旧子目录，绝不整删宿主根（用户可能把便携包放在这个目录里）
        foreach ($legacy in @('pnpm-store', 'build')) {
          $lp = Join-Path $extRoot $legacy
          if (Test-Path -LiteralPath $lp) { Say ('清理外置残留：' + $lp); RemoveTree $lp }
        }
        $left = @(Get-ChildItem -LiteralPath $extRoot -Force -ErrorAction SilentlyContinue)
        if ($left.Count -eq 0) { RemoveTree $extRoot }
        Say '外置残留：已清理'
      }
    }
    # 顺手把"每换一台机器留一份"的登录态备份收敛到 2 份（审计 F.1：原来保留上限是死代码）
    RemoveOldBackups 'shell-login-bak-' 2 -Dir (Join-Path $Root 'cache')
    RemoveOldBackups 'desktop.bak-' 1
    RemoveOldBackups 'app.bak-' 1
    # staging 残留（tmp\build）不是 dsh-* 前缀，Clean-TempJunk 不管，这里显式清
    $stageLeft = Join-Path $Root 'tmp\build'
    if (Test-Path -LiteralPath $stageLeft) { RemoveTree $stageLeft }
    foreach ($bad in @(Get-ChildItem -LiteralPath $Root -Directory -Filter '*.failed' -Force -ErrorAction SilentlyContinue)) { RemoveTree $bad.FullName }
    Say '已清理临时残留'
    break
  }
  'clean-ship' {
    # 交付前清理：把源机器的凭证/会话/登录态/崩溃日志/旧路径痕迹从包里去掉。
    # 默认 dry-run 只列清单；--apply 才真删；--verify 只断言（还没干净就 exit 1）。
    $tool = Join-Path $Root 'tools\clean-ship.mjs'
    if (-not (Test-Path -LiteralPath $tool)) { Warn2 '找不到 tools\clean-ship.mjs'; exit 2 }
    $toolArgs2 = @($tool)
    foreach ($a in @($From, $Arg2)) { if ($a) { $toolArgs2 += $a } }
    & $Node @toolArgs2
    exit $LASTEXITCODE
  }
  'verify' {
    # 壳自己的断言集（编码/依赖一致/bundles/补丁 54 处/sync 幂等/结构与体积）—— 不依赖外部 audit 脚本
    $tool = Join-Path $Root 'tools\verify-shell.mjs'
    if (-not (Test-Path -LiteralPath $tool)) { Warn2 '找不到 tools\verify-shell.mjs'; exit 2 }
    & $Node $tool
    exit $LASTEXITCODE
  }
  'bootstrap' {
    # 只有壳、没有官方那层时用（git 仓库 clone 下来就是这种状态）：
    # 一条命令补齐 node / pnpm / app / desktop / 插件依赖，每步都带进度条，已存在的跳过。
    Say '=== 便携壳自举：补齐官方那层（需要联网）==='
    Say-Deps
    if (-not (Assert-HostReady)) { exit 1 }
    $missingParts = @(Get-MissingParts)
    if ($missingParts.Count -eq 0) {
      Say '  官方那层已经齐了（node / pnpm / app / desktop / 插件都在），不用自举：离线也能直接启动。'
      break
    }
    Say ('  这次要补：' + ($missingParts -join ' / '))
    if ($env:DSH_PORTABLE_OFFLINE -eq '1' -or -not (Test-Network)) {
      Warn2 '  连不上网（registry.npmjs.org / nodejs.org 都不可达），或已设 DSH_PORTABLE_OFFLINE=1'
      Say '  自举必须联网。离线机器请用"整包复制"：把 app\ desktop\ runtime\ home\profiles\node_modules 一起拷过来，不用自举。'
      exit 1
    }
    if ($Root.Length -gt 92) {
      # 官方 app 解包后最长相对路径约 150 字符，Windows 单条路径上限 260；
      # 目录太深会在 pnpm / 解包阶段失败，与其装一半炸掉，不如先说清楚。
      Warn2 ('当前目录有 ' + $Root.Length + ' 个字符，偏深：官方 app 解包后最长路径约 150 字符，Windows 上限 260。建议把整包放到更浅的目录（例如 D:\Hack3rX-Harness）。')
    }
    $fail = @()
    foreach ($step in @('node', 'pnpm', 'app', 'desktop', 'profiles')) {
      try {
        if ($step -eq 'node') { Bootstrap-Node }
        elseif ($step -eq 'pnpm') { Bootstrap-Pnpm }
        elseif ($step -eq 'app') { Bootstrap-App }
        elseif ($step -eq 'desktop') { Bootstrap-Desktop }
        else { Bootstrap-Profiles }
      }
      catch {
        $fail += ($step + ': ' + $_.Exception.Message)
        Warn2 ('  ' + $step + ' 失败：' + $_.Exception.Message)
      }
    }
    if ($fail.Count -gt 0) {
      Warn2 ('自举没做完（' + $fail.Count + ' 步失败），已成功的部分保留，重跑会接着来：')
      $fail | ForEach-Object { Warn2 ('  - ' + $_) }
      Say '修好网络/权限后重跑：dsh-portable.cmd bootstrap'
      exit 1
    }
    try { Fix-MarketPatch } catch { }
    # 自举会把 app / desktop / pnpm 整份换掉：三族补丁收尾统一重打（不需要人记得 repair）
    $null = Repair-OfficialPatches -Quiet
    Say ''
    Say ('自举完成：app ' + (AppVersion) + ' / desktop ' + (DesktopVersion) + ' / node ' + (& $Node -v))
    Say '下一步：preflight.cmd（或直接 start-web.cmd / start-desktop.cmd）'
    break
  }
  'unblock' { Fix-Motw; break }
  'fix-state' { Fix-PnpmState; break }
  'reset-shell' { Reset-ShellCrypto; break }
  'fix-office' { Fix-OfficeRuntime -Force:$Force; Fix-OfficeCli; Clean-TempJunk; break }
  'fix-market' { Fix-MarketPatch; break }
  'auto-prepare' {
    # 每个子步骤都记账：任何一步失败就不写 prep 标记（下次启动会重试），并留 logs\prep.err。
    # 原来"失败也算跑过"，一旦某次没跑成，之后就永远不会再重试。
    $errs = @()
    try { Fix-Motw -IfNeeded -Full } catch { $errs += ('motw: ' + $_.Exception.Message) }
    try { Fix-PnpmState -Quiet } catch { $errs += ('state: ' + $_.Exception.Message) }
    try { Reset-ShellCrypto } catch { $errs += ('shell-login: ' + $_.Exception.Message) }
    try { Fix-OfficeRuntime } catch { $errs += ('office: ' + $_.Exception.Message) }
    try { Fix-OfficeCli } catch { $errs += ('office-cli: ' + $_.Exception.Message) }
    try { Fix-MarketPatch -Quiet } catch { $errs += ('market: ' + $_.Exception.Message) }
    try { Clean-TempJunk } catch { $errs += ('temp: ' + $_.Exception.Message) }
    try { $null = Plugin-Tool @('sync', '--quiet') } catch { $errs += ('plugins: ' + $_.Exception.Message) }
    if ($errs.Count -gt 0) {
      try {
        $logDir = Join-Path $Root 'logs'
        if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
        Add-Content -LiteralPath (Join-Path $logDir 'prep.err') -Encoding UTF8 -Value ('[' + (Get-Date -Format o) + '] ' + ($errs -join '; '))
      } catch { }
      Warn2 ('首次准备有 ' + $errs.Count + ' 步失败（不会记标记，下次启动重试；详见 logs\prep.err）')
      exit 1
    }
    Set-Marker 'prep'
    break
  }
  'launch-desktop' {
    # 已在跑就别再起第二个：第二实例会被官方单实例锁立刻挡掉，它的日志重定向又会撞上被首个
    # 实例占用的文件 —— 结果就是"双击了但什么也没发生"（旧版最难受的体验）。
    if (@(DesktopWindows).Count -gt 0) {
      $st = Invoke-DesktopWindow
      if ($st -eq 1) { Say '桌面窗口已在运行，已从托盘还原到前台' }
      elseif ($st -eq 3) { Say '桌面窗口已在运行（主窗口还没出现，请稍等）' }
      else { Say '桌面窗口已在运行，已切到前台' }
      exit 0
    }
    # 黑框问题、脱敏、以及本机 Start-Process -Redirect* 会抛 NO_PROXY 的坑，都在这个 helper 里处理
    if (-not (Start-DesktopDetached)) { exit 2 }
    exit 0
  }
  'focus-desktop' { exit (Focus-Desktop) }
  'show-desktop' {
    # start-desktop.cmd 的第一步就调它：四态决定"去启动"还是"等一等/只还原"。
    # 退出码：2 = 桌面没在运行（调用方去启动）；3 = 进程在但还没有主窗口（调用方应等待/聚焦，不能再起一个）；
    #         1 = 已从托盘/隐藏态还原；0 = 本来就在屏幕上。
    $st = Invoke-DesktopWindow
    if ($st -eq 2) { exit 2 }
    if ($st -eq 3) { Say '桌面程序在跑，但主窗口还没出现（可能刚启动或只剩托盘）；先等一会儿再试'; exit 3 }
    if ($st -eq 1) { Say '已把桌面窗口从托盘还原'; exit 1 }
    Say '窗口本来就在屏幕上，已切到前台'
    exit 0
  }
  'close-desktop' { exit (Stop-DesktopGracefully) }
  'plugin-list' { exit (Plugin-Tool @('list')) }
  'plugin-add' {
    if (-not $From) { Say '用法：dsh-portable.cmd plugin-add <包名或包名@版本>'; Say '（要一次装多个请用 dsh-plugin-shared.cmd add A B）'; exit 1 }
    exit (Plugin-Tool @('add', $From))
  }
  'plugin-remove' {
    if (-not $From) { Say '用法：dsh-portable.cmd plugin-remove <包名>'; exit 1 }
    exit (Plugin-Tool @('remove', $From))
  }
  'plugin-adopt' {
    if (-not $From) { Say '用法：dsh-portable.cmd plugin-adopt <包名>'; exit 1 }
    exit (Plugin-Tool @('adopt', $From))
  }
  'plugin-sync' { exit (Plugin-Tool @('sync')) }
  # 暂存安装：下载/校验在影子 home 里做，不碰 live 插件树；退出程序后下次启动由启动器提交。
  # 参数透传（插件名/规格可能带 @ 和版本号），From 只接第一个，多个用 dsh-plugin-shared.cmd。
  'plugin-stage' {
    if (-not $From) { Say '用法：dsh-portable.cmd plugin-stage <包名或包名@版本>'; Say '（一次装多个请用 dsh-plugin-shared.cmd stage A B）'; exit 1 }
    exit (Plugin-Tool @('stage', $From))
  }
  'plugin-stage-remove' {
    if (-not $From) { Say '用法：dsh-portable.cmd plugin-stage-remove <包名>'; exit 1 }
    exit (Plugin-Tool @('stage-remove', $From))
  }
  'plugin-stage-list' { exit (Plugin-Tool @('stage-list')) }
  'plugin-stage-discard' {
    if (-not $From) { Say '用法：dsh-portable.cmd plugin-stage-discard <id|all>'; exit 1 }
    exit (Plugin-Tool @('stage-discard', $From))
  }
  'plugin-activate' { exit (Plugin-Tool @('activate')) }
  # 附件库回到便携目录：撤掉 cordis.patch.yml 里的 dshHome 重定向，并把旧附件复制回来。
  # 先把 tools\patch-attachment.mjs 的补丁打上再执行（没补丁会被拒，退出码 4）。
  'fix-attachment' {
    $fa = Join-Path $Root 'tools\fix-attachment.mjs'
    if (-not (Test-Path -LiteralPath $fa)) { Warn2 '缺少 tools\fix-attachment.mjs'; exit 2 }
    $faArgs = @()
    if ($From -eq 'apply') { $faArgs += '--apply' }
    if ($Force) { $faArgs += '--purge-old' }
    & $Node $fa @faArgs | Out-Host
    exit $LASTEXITCODE
  }
  # 商城"操作历史"清不掉：界面只关当次显示，服务端读的是 <profile>\.dsh-market\drain.ndjson。
  # 这里直接整理那几个文件（默认清已结束记录；-Force 连 log.ndjson 一起清）。
  'market-history' {
    $mh = Join-Path $Root 'tools\market-history.mjs'
    if (-not (Test-Path -LiteralPath $mh)) { Warn2 '缺少 tools\market-history.mjs'; exit 2 }
    $mhArgs = @()
    if ($From -eq 'check') { $mhArgs += '--check' }
    if ($Force) { $mhArgs += '--all' }
    & $Node $mh @mhArgs | Out-Host
    exit $LASTEXITCODE
  }
  'shell-update' {
    # 壳自更新 v2：真正干活的是 tools\shell-update.mjs（取版本线清单 → 校验 → 调 shell-apply.mjs 备份 /
    # 换装 / 回滚，verify 不过就整体回滚）。这里只做三件事：子命令分派、占用检查、把 -Force 翻成 --force。
    $tool = Join-Path $Root 'tools\shell-update.mjs'
    if (-not (Test-Path -LiteralPath $tool)) { Warn2 '找不到 tools\shell-update.mjs'; exit 2 }
    if (-not (Test-Path -LiteralPath $Node)) { Warn2 'runtime\node 不在：先运行 dsh-portable.cmd bootstrap'; exit 2 }
    $sub = if ($From -in @('check', 'apply', 'rollback', 'recover', 'notes', 'stage', 'backups', 'snooze')) { $From } else { 'check' }
    # 桌面窗口占着壳文件：apply 之前必须没有桌面窗口（check / notes 只读，不受影响）
    if ($sub -eq 'apply' -and $Force -and (DesktopRunning)) { throw '桌面窗口正在运行：先退出 DeepSeek Harness 再更新壳（文件会被占用）' }
    $cli = @($sub)
    # 第二个位置参数是清单来源（本地文件或 URL）：镜像 / 离线 / 自测时用得上
    if ($Arg2) { $cli += @('--manifest', (PathOf $Arg2)) }
    if ($sub -eq 'apply' -and $Force) { $cli += '--force' }
    # 退出码由 node 侧决定：0 有更新 / 4 已最新 / 3 被兼容性挡下 / 1 失败 / 2 用法
    & $Node $tool @cli
    exit $LASTEXITCODE
  }
  'plugin-repair' {
    # 插件依赖环境重建。触发场景：换机器/换启动方式后，dsh 的插件操作从 PATH 上拿到的是
    # 另一代 pnpm -> store 布局目录不同（v10 vs v11）-> pnpm 报 ERR_PNPM_UNEXPECTED_STORE，
    # 市场里装不上也卸不掉。只对齐到壳自带的那一代，不删除 store 里的包。
    # 默认预演（与 update-* 一致）：报两端版本，什么都不改；加 -Force 才真重建。
    $want = Get-PnpmMajorRuntime
    $have = Get-ProfileStoreMajor
    if (-not $want) { Warn2 '没有 runtime\pnpm（先 dsh-portable.cmd bootstrap）'; exit 2 }
    Say ('壳自带 pnpm : ' + $want)
    Say ('profile 记录 : ' + $(if ($have) { $have } else { '(没有 node_modules)' }))
    Say ("垫片         : " + $(if (Test-Path -LiteralPath (Join-Path $Root 'runtime\pnpm\bin\pnpm.cmd')) { 'runtime\pnpm\bin\pnpm.cmd 就绪' } else { '缺失（-Force 重建时会自动补写）' }))
    if ($have -eq $want) { Say '两端一致：不需要重建（-Force 也只跑清单同步与市场补丁）' }
    if (-not $Force) { Say '这是预演，加 -Force 才真重建（会删除并重装 home\profiles\node_modules）'; break }
    Repair-PluginEnv
    Say '插件环境已对齐：现在可以在市场里正常安装/卸载了'
    break
  }
  'plugin-allow' {
    if (-not $From) { Say '用法：dsh-portable.cmd plugin-allow <包名>'; exit 1 }
    exit (Plugin-Tool @('allow', $From))
  }
  'plugin-revoke' {
    if (-not $From) { Say '用法：dsh-portable.cmd plugin-revoke <包名>'; exit 1 }
    exit (Plugin-Tool @('revoke', $From))
  }
  'migrate-store' {
    # 把旧版放在宿主用户目录的 pnpm store 搬进便携目录（一次性，GB 级，慢是正常的）
    $legacy = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Hack3rX-Harness\pnpm-store'
    if (-not (Test-Path -LiteralPath $legacy)) { Say '没有找到旧的外置 store，无需迁移'; break }
    if (Test-Path -LiteralPath $StoreRoot) {
      $hasContent = (Test-Path -LiteralPath (Join-Path $StoreRoot 'v11\index.db')) -or (Test-Path -LiteralPath (Join-Path $StoreRoot 'index.db'))
      if ($hasContent) { Say ('盘内 store 已有内容：' + $StoreRoot + '（要重建请先手工删掉它）'); break }
    }
    if (DesktopRunning) { throw '桌面窗口正在运行：先退出桌面再搬 store（否则记录会被并发改写）' }
    Say ('搬迁 store：' + $legacy + ' -> ' + $StoreRoot + '（GB 级，慢是正常的）')
    New-Item -ItemType Directory -Path (Split-Path -Parent $StoreRoot) -Force | Out-Null
    $null = RoboCopyTree $legacy $StoreRoot 'store'
    $idx = Join-Path $StoreRoot 'v11\index.db'
    if (-not (Test-Path -LiteralPath $idx)) { throw ('搬迁结果不完整：缺少 ' + $idx + '（先看 doctor，再决定是否重试）') }
    Fix-PnpmState
    Say '完成。若 pnpm 仍报 store 不一致，运行 dsh-portable.cmd plugin-repair'
    break
  }
  'fs-profile' {
    # 重新探测卷类型并打印生成的片段（排障/换机器后用）
    & powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'tools\fs-profile.ps1') -Root $Root -Force
    if ($LASTEXITCODE -ne 0) { Warn2 '卷类型探测失败（详见上面的输出），本次仍按残留片段/兜底值运行' }
    $frag = Join-Path $Root 'tmp\fs-profile.cmd'
    if (Test-Path -LiteralPath $frag) { Get-Content -LiteralPath $frag | Where-Object { $_ -like 'set *' } | ForEach-Object { Say ('  ' + $_) } }
    break
  }
  'doctor' {
    Say "root      : $Root"
    Say ("app       : " + (AppVersion) + "  (" + (Size (Join-Path $Root 'app')) + " MB)")
    Say ("desktop   : " + (DesktopVersion) + "  (" + (Size (Join-Path $Root 'desktop')) + " MB)")
    Say ("node      : " + $(if (Test-Path $Node) { (& $Node -v).Trim() } else { 'MISSING' }))
    Say ("home      : " + (Join-Path $Root 'home') + "  (" + (Size (Join-Path $Root 'home')) + " MB)")
    Say ("shell     : " + (Size (Join-Path $Root 'shell-profile')) + " MB")
    $vol = Split-Path -Qualifier $Root
    $fmt = 'unknown'; try { $fmt = ([System.IO.DriveInfo]::new($vol)).DriveFormat } catch { }
    Say ("volume    : " + $vol + " (" + $fmt + "), 剩余 " + (FreeMB $Root) + " MB")
    if (-not $env:DSH_FS_PROFILE) {
      # 单独跑 dsh-portable.ps1 时没有 env.cmd 的环境：直接读探测片段
      $frag = Join-Path $Root 'tmp\fs-profile.cmd'
      if (Test-Path -LiteralPath $frag) {
        foreach ($ln in @(Get-Content -LiteralPath $frag)) {
          if ($ln -match '^\s*set\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?\s*$') { Set-Item -Path ('env:' + $Matches[1]) -Value $Matches[2] }
        }
      }
    }
    Say ("fs        : " + $(if ($env:DSH_FS_FORMAT) { $env:DSH_FS_FORMAT } else { 'unknown' }) + " -> " + $(if ($env:DSH_FS_PROFILE) { $env:DSH_FS_PROFILE } else { 'unknown' }) + " / " + $(if ($env:DSH_PERMISSION_MODE) { $env:DSH_PERMISSION_MODE } else { 'unknown' }))
    if ($env:DSH_FS_PROFILE -eq 'compat') {
      if (Test-Path -LiteralPath $Node) {
        $null = & $Node (Join-Path $Root 'tools\patch-fs.mjs') --check --quiet 2>&1
        $patchState = switch ($LASTEXITCODE) { 0 { 'applied' } 2 { 'applied' } 4 { 'not-applied' } default { 'anchor-mismatch' } }
      } else { $patchState = 'unknown (no node yet)' }
      Say ("fs-patch  : " + $patchState)
    } else { Say ("fs-patch  : n/a (" + $(if ($env:DSH_FS_PROFILE) { $env:DSH_FS_PROFILE } else { 'unknown' }) + ")") }
    Say ("store     : " + $StoreRoot + "  exists=" + (Test-Path -LiteralPath $StoreRoot))
    $extRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Hack3rX-Harness'
    Say ("external  : " + $(if (Test-Path -LiteralPath $extRoot) { 'present: ' + $extRoot } else { 'none' }))
    Say ("7z        : " + (Get-SevenZipState))
    Say ("deps      : " + (Get-DepsText))
    Say ("pnpm      : " + (Get-PnpmStateText))
    # 壳自身状态三行：版本与清单规模、上一次 check 的缓存结论、壳换装 journal 是否残留。
    # 只读（doctor 是只读动作，分派前已跳过 Repair-State）；清 journal 要显式 shell-update recover。
    $shMf = Json (Join-Path $Root 'shell-version.json')
    $shVer = if ($shMf -and $shMf.shellVersion) { [string]$shMf.shellVersion } else { 'MISSING' }
    $shChan = if ($shMf -and $shMf.channel) { [string]$shMf.channel } else { 'stable' }
    $shCount = if ($shMf -and $shMf.files) { @($shMf.files.PSObject.Properties).Count } else { 0 }
    Say ("shell-ver : " + $shVer + ' (' + $shChan + ') 清单 ' + $shCount + ' 文件 / 源 releases/latest')
    $shUpd = '未知（还没检查）'
    $chk = Json (Join-Path $Root 'tmp\shell-check.json')
    if ($chk -and $chk.summary) {
      $at = 0
      try { if ($chk.at) { $at = [int64]$chk.at } elseif ($chk.summary.at) { $at = [int64]$chk.summary.at } } catch { $at = 0 }
      $ageH = -1
      if ($at -gt 0) {
        $epoch = New-Object System.DateTime(1970, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)
        $ageH = ((([datetime]::UtcNow - $epoch).TotalMilliseconds) - $at) / 3600000
      }
      # 缓存可能来自"上一个本地版本"：必须校验归属，否则会把旧版本号念给已升级的用户
      $cacheLocal = [string]$chk.summary.local
      $cacheRemote = [string]$chk.summary.remote
      $newerRemote = $false
      try { $newerRemote = ([version]$cacheRemote) -gt ([version]$shVer) } catch { $newerRemote = $true }
      if ($ageH -lt 0) { $shUpd = '未知（还没检查过）' }
      elseif ($ageH -gt 24) { $shUpd = ('上次检查 ' + [math]::Round($ageH / 24, 1) + ' 天前（下次启动会重查）') }
      elseif ($shVer -eq 'MISSING' -or $cacheLocal -ne $shVer) { $shUpd = '未知（缓存属于旧版本 ' + $cacheLocal + '）' }
      elseif ($chk.summary.status -eq 'update-available' -and $newerRemote) { $shUpd = ($cacheRemote + ' 可更新') }
      elseif ($chk.summary.status -eq 'blocked') { $shUpd = ('被兼容性挡下（' + $cacheRemote + '）') }
      elseif ($chk.summary.status -eq 'local-newer') { $shUpd = ('本地比远端新（' + $cacheRemote + '）') }
      else { $shUpd = '已是最新' }
    }
    Say ("shell-upd : " + $shUpd)
    Say ("journal   : " + $(if (Test-Path -LiteralPath $Journal2) { '有中断残留（运行 dsh-portable.cmd shell-update recover）' } else { 'none' }))
    Say ("office    : " + (Get-OfficePatchState))
    Say ("login-bak : " + (Get-LoginBackupCount))
    Say ("leftovers : " + (Get-LeftoverCount))
    Say ("auto-upd  : " + $(if (Test-Path (Join-Path $Root 'desktop\resources\app-update.yml')) { 'ENABLED' } else { 'disabled' }))
    Say ("market    : " + (Get-MarketPatchState))
    # 四族补丁状态：applied / needs-work / failed / n-a。needs-work 通常是官方刚升级、壳还没适配
    $patchTool = Join-Path $Root 'tools\patch-all.mjs'
    if (Test-Path -LiteralPath $patchTool) {
      $patchLines = @(& $Node $patchTool --check 2>&1 | Where-Object { $_ -match '^\s+(market|fs|pnpm|attachment)\s' })
      if ($patchLines.Count -eq 0) { Say 'patches   : （四族状态读取失败）' }
      foreach ($pl in $patchLines) { Say ('patches   : ' + ([string]$pl).Trim()) }
    }
    Say ("compat    : " + (Get-CompatState))
    Say ("running   : " + $(if (DesktopRunning) { 'desktop window is open' } else { 'no' }))
    Say ("backups   : " + (@(Get-ChildItem -LiteralPath $Root -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*.bak-*' }).Count))
    break
  }
  'check-quiet' {
    $out = (& $Node (Join-Path $Root 'tools\update-check.mjs')) -join ''
    if ($out) { Write-Output $out }
    break
  }
  'check-updates' {
    & $Node (Join-Path $Root 'tools\update-check.mjs') --verbose --force
    break
  }
  'sync-home' {
    $src = Join-Path $env:USERPROFILE '.dsh'
    if (-not (Test-Path -LiteralPath $src)) { throw "源目录不存在：$src" }
    Say "同步 $src -> $(Join-Path $Root 'home')（只复制，不动源）"
    $code = Robo $src (Join-Path $Root 'home') @('/XO')
    Say "完成（robocopy exit $code）"
    break
  }
  'update-app' {
    if (-not $Force) { Say ("app 当前 " + (AppVersion) + "；这是预演，加 -Force 才真更新"); break }
    Install-App
    # 官方层整份换掉了：补丁必须跟着重打（否则商城装不上、exFAT 上新建文件失败）
    $null = Repair-OfficialPatches -Quiet
    break
  }
  'update-desktop' {
    if ($From) {
      $From = (PathOf $From).TrimEnd('\')
      if ($From -match '^[A-Za-z]:$') { throw "来源不能是整个盘符：$From" }
      $rootNorm = (PathOf $Root).TrimEnd('\')
      if ($From -eq $rootNorm -or $rootNorm.StartsWith($From + '\')) { throw "来源不能是本便携目录自身或它的上级：$From" }
      if (-not (Test-Path -LiteralPath (Join-Path $From 'DeepSeek Harness.exe'))) { throw "不是有效的桌面版目录：$From" }
      Say "来源：$From"
      if (-not $Force) { Say '这是预演，加 -Force 才真更新'; break }
      Install-Desktop $From $null
    }
    else {
      $m = Get-Manifest
      Say ("desktop 当前 " + (DesktopVersion) + " / 最新 " + $m.version)
      if ((DesktopVersion) -eq $m.version -and -not $Force) { Say '已是最新（加 -Force 可强制重装）'; break }
      if (-not $Force) { Say '这是预演，加 -Force 才真更新'; break }
      Install-Desktop $null $m
    }
    # 桌面层整份换掉了（app.asar / 内置 pnpm）：补丁必须跟着重打
    $null = Repair-OfficialPatches -Quiet
    break
  }
  'update-all' {
    if (-not $Force) { Say '这是预演，加 -Force 才真更新'; break }
    $failed = 0
    try { Install-App } catch { $failed++; Warn2 ("引擎更新失败：" + $_.Exception.Message) }
    try {
      $m = Get-Manifest
      if ((DesktopVersion) -ne $m.version) { Install-Desktop $null $m } else { Say 'desktop 已是最新' }
    }
    catch { $failed++; Warn2 ("桌面更新跳过：" + $_.Exception.Message) }
    if ($failed -gt 0) { Say '更新未全部成功；原版本仍然可用。'; exit 1 }
    # app 与 desktop 都可能被换掉：收尾统一重打三族补丁
    $null = Repair-OfficialPatches -Quiet
    break
  }
}
} catch {
  Warn2 ('✗ ' + $_.Exception.Message)
  exit 1
}
