# 壳发布说明（RELEASE-NOTES）

本文件随壳发布：每个版本一节，`shell-update check` 会把它当成"更新细则"展示给用户，
`tools\shell-release.mjs prepare` 会把 `## v<版本>` 这一节的六个小节解析成清单里的 `notes`。

写作规矩（发布前请照做）：

- 版本标题固定格式 `## v<版本> — <YYYY-MM-DD>`，`<版本>` 必须与 `shell-version.json` 的 `shellVersion` 一致。
- 六个小节必须都在、顺序固定：`### 新增` / `### 修复` / `### 优化` / `### 破坏性变更` /
  `### 升级会做什么` / `### 如何回退`。没有内容就写 `无`（**小节不能省**，缺一个小节 `prepare` 会直接失败并点名）。
- 一条一行，用 `- ` 开头；一行说清一件事，别写"若干优化"这种空话。
- 讲"用户能感觉到什么"，不要罗列内部重构。

---

## v0.1.0 — 2026-11-03

第一个按 GitHub Release 版本线发布的壳。

### 新增

- 壳自更新通道：`dsh-portable.cmd shell-update` 增加 `check` / `stage` / `apply` / `rollback` / `recover` / `notes` 子命令，默认更新源改为 `releases/latest/download/shell-version.json`（不再读 master 上的裸文件）。
- 清单升级到 schemaVersion 2：除每个文件的 sha256 外，还带 `tag` / `minShellVersion` / `requires`（dsh、node 版本要求）/ `userOwned`（用户私有文件清单）/ `notes`（更新细则）/ `zip`（整包的 name、sha256、bytes）。
- 更新前静默检查：`preflight.cmd` 调 `tools\shell-update.mjs check --cached 1440 --prompt`，24 小时内只查一次、离线静默不打扰；有更新时先展示本文件里那个版本的"更新细则"，输入 Y 才继续（选 N 则 7 天内不再问，菜单 U 随时可手动更新）；更新完成后自动重跑自检。
- 换装引擎带备份与 journal：换装前把将被覆盖/删除的文件整份备份（`shell-backup-<yyyyMMdd-HHmmss>` 目录，apply 会打印确切路径），换装后自动跑 `verify-shell`；verify 不通过就整体回滚。
- exFAT 双档 fs-profile：`tools\fs-profile.ps1` 探测壳所在卷的文件系统并生成 `tmp\fs-profile.cmd`。NTFS/ReFS 走 native 档（保留官方推荐的 ACL 沙箱、pnpm 默认导入方式）；exFAT/FAT32/UNC 走 compat 档（这类卷存不下安全描述符，自动关 ACL 沙箱、pnpm 改用 copy 导入）。
- `migrate-store`：把 pnpm store 收进便携盘内，换机器后插件安装/卸载不再跨盘、不再因为换盘符报错。
- 第三个插件 `dsh-session-clean-delete`（1.0.2）进清单：会话列表里可以干净删除单个会话，不再需要手工删 `home\sessions`。
- `plugin-repair`：插件环境坏了（依赖树缺失、patch 被改）时按备份重建，备份落在 `cache\plugin-repair-<时间戳>`。
- 发布工具链：新增 `tools\shell-release.mjs`（`prepare` / `publish` / `verify-published` / `defaults` 四条命令）、本文件与 `RELEASING.md`。

### 修复

- pnpm 大版本错配：`runtime\pnpm` 是 11.28.5（store 版本段 v11），但 dsh 是从 PATH 上取第一个 pnpm 来装的。新增 `runtime\pnpm\bin\pnpm.cmd` 垫片 + `fix-state`，让 store 版本段与真正执行安装的那个 pnpm 一致，修掉 `ERR_PNPM_UNEXPECTED_STORE`（换机器后插件市场点卸载就报这个错）。
- store 路径写死：`home\profiles\*\node_modules` 里记着原机器的绝对路径（storeDir / virtualStoreDir / projects 键），搬盘或换用户名后 pnpm 拒绝一切安装。现在 `fix-state` / `plugin-repair` 能把它们对回本机解析出的 store。
- 壳升级半途中断会留下残缺目录：现在有 journal + 备份，`shell-update recover` 能把壳还原成换装前的样子。
- 只读动作不再顺手改包：`Repair-State` 从"所有动作分派前无条件执行"改成只在有副作用的分支里执行，`doctor` / `verify` / `check-quiet` 这类动作真的只读了。
- 交付前"为了对齐计数就删会话"的老做法去掉了：`clean-ship refresh` 只刷 `version.json` 计数与壳清单，不删任何文件。

### 优化

- 升级前先给"升级会做什么"：用户能看到会替换哪些文件、要不要跑迁移、备份在哪，再决定按不按 Y。
- 清单与整包可复现：整包用 7z 打包时把所有文件时间戳钉死，同一个 tag 打两次包字节完全相同，所以清单里的 `zip.sha256` 可以被 publish 重新打包校验。
- 发布从手工操作收成四条命令，且带门禁（clean-ship refresh → verify-shell → selftest-shell-update）与 tag 自校验（tag 里清单的每个 sha256 都要等于 tag 里文件的真实字节）。
- 下载校验按字节：`shell-update` 只认 sha256 一致的文件，编码铁律（`.cmd` 纯 ASCII+CRLF、`.ps1` 单个 BOM、`.md/.json/.mjs/.yml` 无 BOM）在落盘前就校验。

### 破坏性变更

- **从 v0.1.0 起，壳的更新源改为 GitHub Release 版本线**（`releases/latest/download/shell-version.json`），不再从 master 分支读裸文件。更早的实例不认新清单（schemaVersion 2），必须先手工同步一次壳：把新版的 `tools\shell-update.mjs`、`dsh-portable.ps1`、`preflight.cmd`、`tools\preflight.mjs` 等覆盖进旧目录，之后才能自动升级。
- 清单 schemaVersion 从 1 升到 2。老的 `shell-update` 读 v2 清单会报"清单不合法"，这是上面那条"必须先手工同步一次"的直接原因。
- `home\profiles\desktop\cordis.patch.yml` 是**硬黑名单**（不在清单 `files` 里，永不随壳更新）：它是用户私有的网关/中转配置，升级不覆盖、回滚也不删。
- 整包 `harness-shell-<版本>.zip` **不含** `shell-version.json` 自己（清单里记着 zip 的 sha256，zip 里再装清单就成了死循环）；需要单独恢复清单时从 Release 页面单独下。

### 升级会做什么

- 先备份：把本次会被覆盖或删除的壳文件整份备份，apply 会打印备份目录（`shell-backup-<yyyyMMdd-HHmmss>`）。
- 只替换清单 `files` 里列出的壳文件：根脚本（`dsh-portable.ps1`、`*.cmd`）、`tools\**`（含 `tools\7z` 二进制）、`runtime\vcredist`、`home\profiles` 的清单/锁文件、`README.md` / `LICENSE` / `RELEASE-NOTES.md`。
- 不碰官方层与用户数据：`app\`、`desktop\`、`runtime\node`、`runtime\pnpm`、`home\sessions`、`home\storages`、`home\settings.yaml`、`home\.credentials.yaml` 一律不在更新范围。
- `userOwned` 里的文件：本地改过就原样保留（不覆盖），没改过才更新；你自己放进 `tools\` 的脚本永远不会被删。
- 换装后自动跑 `verify-shell`（`--update-gate` 模式）；不通过就整体回滚并把壳还原成换装前的样子。
- verify 通过后才跑清单里声明的迁移脚本（`tools\` 下已进清单的 `.mjs`）；迁移失败只记录、不整体回滚。

### 如何回退

- 换装刚结束发现不对：`dsh-portable.cmd shell-update rollback` —— 用最新一份备份整体还原（包含被删掉的文件），还原后同样跑一次 verify。
- 半途断电/被杀进程（壳看起来"少了一半"）：`dsh-portable.cmd shell-update recover` —— 发现残留 journal 就按备份还原并清 journal；没有 journal 则什么都不做。
- 想退回某个更早的版本：`node tools\shell-update.mjs apply --to <旧版本> --force`（走 `dsh-portable.cmd` 时写成 `shell-update apply -Force`；降级必须显式 `--force`，默认拒绝降级）。
- 备份目录可以手工清理（`cache\` 下 `shell-backup-*`），删之前建议先复制一份到盘外。
- 网页兜底：打开 GitHub Release 页面下载 `harness-shell-<版本>.zip` 整包手工覆盖；只想修清单就单独下 `shell-version.json`。

## v0.1.1 — 2026-11-04

第二个公开版本（产品名：**DSH-Protable-Kernel**）。这一版只做修复与硬化，没有破坏性变更。

### 新增

- `tools\patch-pnpm.mjs`：给便携盘里的 pnpm 打“store 项目注册容错”补丁——exFAT 不支持符号链接，pnpm 每次安装前都会去建 `store\projects\<hash>` 链接，失败就会让商城“装不上也卸不掉”。补丁只影响 prune 的项目簿记。
- 该补丁已接进 `dsh-portable.cmd repair`：compat 档（exFAT/FAT32/UNC）每次 repair 都会自动重打，`update-app` / `bootstrap` 换掉 pnpm 后也能自愈。
- `shell-update` 的下载更耐抖动：重试 3 次 + 退避、并发降到 2；逐文件下载没全过时自动改走 Release 的整包 zip 兜底（企业网关偶发 618/jwt 错误也能升级）。

### 修复

- **exFAT 上 store 迁进便携盘后，pnpm 的写操作全部失败**（`EISDIR ... symlink ... projects\<hash>` / 重试链里的 `ENOENT ... unlink`）：根因是 pnpm 的 `registerProject`，已用 `patch-pnpm.mjs` 整段容错。
- `verify-shell` 不再把“用户自己改过的 `home\profiles\*`”当成错误（userOwned 差异永久豁免），用户实例跑 verify 不会再红一片。
- `verify-shell` 的 `packageImportMethod` 检查现在接受带引号的 YAML 值（`'copy'`），与 `fix-pnpm-state` 实际写入一致。
- 开发版（`x.y.z-dev` / `-rc` / `-beta`）不再强制要求 `RELEASE-NOTES` 里有对应小节。

### 优化

- 发布流程增加了“行尾归一”门禁（`tools\normalize-eol.mjs`）：`.cmd` 纯 ASCII+CRLF、`.ps1` 单 BOM+LF、其余无 BOM+LF，避免“清单哈希 ≠ tag 字节”。
- `dsh-portable.cmd` 把“已是最新（exit 4）”当成功处理，不再打印“命令失败”。

### 破坏性变更

- 无。

### 升级会做什么

- 只替换清单里列出的壳文件（54 个，含新增的 `tools\patch-pnpm.mjs`）；`home\` 下你自己的插件清单 / 网关配置 / 会话 / 凭证一律不碰。
- 换装前整份备份到 `cache\shell-backup-<时间戳>`，换完自动跑 `verify-shell` 的换装闸门，不通过就整体回滚。
- **升级后建议手动跑一次 `dsh-portable.cmd repair`**：它会把 pnpm 补丁打到 `runtime\pnpm`（compat 档），之后商城才能正常装/卸插件。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`（按最新备份整体还原，还原后同样跑 verify）。
- 想退回某个更早版本：`node tools\shell-update.mjs apply --to 0.1.0 --force`（降级必须显式 `--force`；走 `dsh-portable.cmd` 时参数写成 `-Force`，脚本会翻成 `--force`）。
- 网页兜底：从 Release 页下载 `harness-shell-0.1.1.zip` 整包覆盖壳文件；只想修清单就单独下 `shell-version.json`。

## v0.1.2 — 2026-11-04

全量测试（4 组独立 QA：发布完整性 / 更新器路径 / 数据安全 / 运行时与 pnpm）之后的一版**纯修复**，没有破坏性变更。

### 新增

- 无新功能。这一版只修 QA 揪出来的问题。

### 修复

- **默认更新源基址算错**：清单地址 302 跳到 `release-assets.githubusercontent.com` 后，代码把跳转后的主机当成了文件基址，逐文件下载全部失败，只能靠 1.73 MB 整包兜底（一次 24 秒）。现在固定用 `raw.githubusercontent.com/<repo>/refs/tags/<tag>/`。
- **`--cached` 会串味**：缓存不校验来源，先查过一份假清单后再带 `--cached` 查真清单，会回放假清单的结论（preflight 也会被污染）。现在缓存绑定清单来源。
- **`--force` 越权**：原来它会连 `schemaVersion` 太新、`updaterMin` 太高、跨版本太大一起忽略。现在只放开 `requires-dsh` / `requires-node` 这类软要求，硬闸永远挡。
- **纯版本推进不生效**：清单只改了版本号 / 更新说明、没有文件变化时，`apply` 报成功却没写回清单，版本号永远不前进。现在会原子写回 `shell-version.json`。
- **退出码与 JSON 不一致**：被兼容性挡下时进程退出 1、JSON 里写 3。现在统一为 3。
- **`--json` 不是一行**：换装自检的 PASS 行会混进 stdout。现在自检输出收进 JSON 的 `verify.failed`，stdout 只有一行。
- **`check` 无条件写缓存**：连只读检查都落盘（`tmp\shell-check.json`）。现在只有 `--cached` / `--prompt` 才写。
- **更新说明少一节**：某节为空时（尤其「破坏性变更」）会被整节省略，看着像漏了。现在六节固定，空的打印「无」。
- **用户自建脚本被覆盖**：`tools\` 是整目录白名单，用户自己放在里面的脚本一旦和官方文件同名就会被覆盖。现在「本地有、上一版清单没装过」的 `tools\*` 一律保留（会在输出里列为「保留」）。
- **删掉的用户配置被装回来**：`home\` 下属于用户自己的文件（package.json / pnpm-workspace.yaml / cordis.patch.yml 等）被用户删掉后，升级会把它加回来。现在尊重删除意图，不再补装。
- **大小写导致的误报**：`verify` 的「清单覆盖完整」按大小写敏感比较，`TOOLS/X.MJS` 这类会误判。现在按小写比较。
- **doctor 的假阳性**：「pnpm aligned」只比 store 大版本，profile 里记的 storeDir 指向一个已经不存在的路径时照样报 aligned（仓库里实测复现）。现在会核对记录的 storeDir 是否存在、盘内 store 是否有内容。

### 优化

- `verify-published` 对网络抖动（代理偶发 618）重试 3 次，不再把「网络不好」判成「版本不能升级」。
- 成功换装后清掉 `tmp\build` 里的 staging；失败时保留，便于排查。
- 文档纠正：降级命令的正确写法是 `--force`（直接调 node CLI；走 `dsh-portable.cmd` 时写 `-Force`，脚本会翻），备份目录在 `cache\shell-backup-*`；顺带刷新了一批过期数字。

### 破坏性变更

- 无。行为变得更保守（该挡的一定挡、该保留的一定保留），不影响正常升级。

### 升级会做什么

- 替换清单里的壳文件（54 个）；`home\` 下你的插件清单 / 网关配置 / 会话 / 凭证一律不碰；你自己放进 `tools\` 的脚本也会保留。
- 换装前整份备份到 `cache\shell-backup-<时间戳>`，换完自动跑 `verify-shell` 的换装闸门，不通过就整体回滚。
- 升级后如需让 pnpm 补丁生效（compat 档），跑一次 `dsh-portable.cmd repair`。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`（按最新备份整体还原，还原后同样跑 verify）。
- 想退回某个更早版本：`node tools\shell-update.mjs apply --to 0.1.1 --force`（降级必须显式 `--force`）。
- 网页兜底：从 Release 页下载 `harness-shell-0.1.2.zip` 整包覆盖壳文件。

## v0.1.3 — 2026-11-04

插件生态相关的两个小修复（装/卸插件之后的自检误报、doctor 的更新状态陈旧），无破坏性变更。

### 新增

- 无新功能。

### 修复

- **装/卸插件后 `verify` 误报**：`version.json` 里的 `bundlesWeb` / `bundlesDesktop` 是发布时刻的快照，用户在商城装一个插件后两份 profile 的 bundles 变多，`verify` 就报「bundles 数量与 version.json 声明不一致」。现在 `plugin-shared` 每次改动 profile 清单都会同步刷新这两个计数（`add` / `remove` / `adopt` / `disable` / `sync` 全覆盖）。
- **doctor 的「壳更新」一行会长期显示旧结论**：`tool/shell-update.mjs check` 之前在非 `--cached` / 非 `--prompt` 场景不写缓存，升级完壳之后 `tmp\shell-check.json` 还停留在升级前的结论，doctor 继续显示「x.y.z 可更新」。现在凡是**从网络真查到**的结果都会刷新缓存（本地清单测试仍然不落盘），doctor / preflight 读到的永远是最近一次真实结论。
- **实例侧数据修正**：`app\node_modules\.modules.yaml` 里残留的旧 store 路径（`C:\Users\...\pnpm-store`）在 `migrate-store` 之后不会自动更新，会误导 pnpm；本次已把实例刷新为盘内路径（`cache\pnpm-store\v11`）。

### 优化

- 无。

### 破坏性变更

- 无。

### 升级会做什么

- 同前：只替换清单里的壳文件（54 个），`home\` 下的插件清单 / 网关配置 / 会话 / 凭证一律不碰。
- 换装前整份备份到 `cache\shell-backup-<时间戳>`，换完自动跑 `verify-shell` 的换装闸门，不通过就整体回滚。

### 如何回退

- `dsh-portable.cmd shell-update rollback`（按最新备份整体还原）。
- 想退回某个更早版本：`node tools\shell-update.mjs apply --to 0.1.2 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.1.3.zip` 整包覆盖壳文件。

## v0.1.4 — 2026-11-04

一个 bug 修复版（第三位 +1）：修好"从桌面商城装/卸插件在 exFAT 上失败"。

### 新增

- 无新功能。

### 修复

- **桌面窗口内置的那份 pnpm 没打补丁**：便携壳里有两份 pnpm —— `runtime\pnpm`（壳的插件 CLI 用）和 `desktop\resources\runtime\...\dependencies\pnpm`（**桌面窗口的插件管理、也就是商城装/卸用**）。之前只补了前者，所以在 exFAT 上从商城点安装仍会卡在 pnpm 的 `prepareStoreDir → registerProject`（建符号链接 `EISDIR` / 兜底链里 `ENOENT`）。现在两份都补。
- `tools\patch-pnpm.mjs` 改成**多副本**：自动发现所有带 `registerProject` 的 pnpm 主文件（壳 + 桌面 + app），逐个按版本白名单打补丁、各自备份到 `cache\pnpm-pristine-<ver>\`，`--check` / `--apply` / `--revert` 对全部副本生效。
- 该补丁已接进 `dsh-portable.cmd repair`：`update-app` / `bootstrap` 换掉官方层之后，跑一次 `repair` 就能把所有 pnpm 副本重新补上。

### 优化

- **发布流程加"用户批准"闸门**：`node tools\shell-release.mjs publish` 不带 `--approved`（或环境变量 `DSH_RELEASE_APPROVED=1`）会直接以退出码 2 拒绝——版本只由用户本地测完、明确说"发布"之后才发，agent 不能自己拍板。
- `RELEASING.md` 写明版本号规则：第一位 = 不兼容更新、第二位 = 小版本功能升级、第三位 = Bug 修复；一次发布只允许一种类型，修复版不夹带功能。

### 破坏性变更

- 无。

### 升级会做什么

- 替换清单里的壳文件（54 个）；`home\` 下的插件清单 / 网关配置 / 会话 / 凭证一律不碰，你自己放进 `tools\` 的脚本也会保留。
- 换装前整份备份到 `cache\shell-backup-<时间戳>`，换完自动跑 `verify-shell` 的换装闸门，不通过就整体回滚。
- **升级后建议跑一次 `dsh-portable.cmd repair`**：compat 档（exFAT/FAT32）下它会把 `runtime\pnpm` 与桌面内置 pnpm 的补丁都重新打上，之后商城装/卸才正常。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`（按最新备份整体还原，还原后同样跑 verify）。
- 想退回某个更早版本：`node tools\shell-update.mjs apply --to 0.1.3 --force`（降级必须显式 `--force`）。
- 网页兜底：从 Release 页下载 `harness-shell-0.1.4.zip` 整包覆盖壳文件。

---

## v0.2.0 — 2026-11-04

运行期也能装插件，且官方升级后补丁自己会补回来。

### 新增

- **运行期暂存安装**：`dsh-portable.cmd plugin-stage <包名>` 在后台把下载 / 解压 / 校验做完（在影子目录里，不碰正在用的插件树），退出程序后下次启动自动启用。配套 `plugin-stage-remove` / `plugin-stage-list` / `plugin-stage-discard` / `plugin-activate`。**会话在跑时也能装插件，不再等所有会话结束**。
- `tools\patch-all.mjs`：三族补丁（商城路径 + drain、exFAT 硬链接回退、pnpm 项目注册）的统一入口，`--check` 打印状态表，`--json` 给门禁用。
- `tools\selftest-patches.mjs`：补丁锚点夹具（官方两代真实代码形状 + pnpm 三种写法），纯文本、不碰文件。
- `doctor` 增加 `patches` 三行；`verify` 增加「补丁三族」「补丁锚点自测」「暂存安装」等检查（47 → 54 项）。

### 修复

- **商城排队会冻结其他会话**：dshmarket 的 drain 在「等别的会话空闲」期间就把空闲会话占住了，它们的新消息只进队列、不开回合（实测一条消息等了 42 分钟，取消排队后同秒才开跑）。现在等待期一个都不占，只在「全员空闲的提交边界」一次性占用。
- **官方升级后商城装插件报 EISDIR**：桌面升到 0.2.2-rc.1 时整份替换了内置 pnpm，补丁丢失且没人重打。现在 pnpm 补丁按调用形态定位（参数改名、缩进变化都还能命中），并且每次启动与升级收尾自动重打。
- **桌面升级后 `app.asar` 里的硬链接回退补丁失配**：改成按 `createIfAbsent → link → catch` 的结构定位，0.2.1 与 0.2.2 两代形状都能打；asar 被运行中的桌面占用时记「下次启动自动补」，不再误报失败。
- 桌面内置 pnpm 与 `runtime\pnpm` 补丁不一致：`patch-pnpm` 现在自动发现所有副本。
- 商城卸载插件后留下的悬空条目（清单里仍写着依赖、bundles 计数对不上）：`plugin-shared sync --prune` 清理，`version.json` 计数自动跟随。

### 优化

- 补丁三族有了**启动自愈**：两个启动器在 `dsh web` 之前跑 `patch-all`，`repair` / `bootstrap` / `update-app` / `update-desktop` / `update-all` 收尾也各跑一次——**官方升级后不需要你记得手动 repair**。
- 三份 `pnpm-workspace.yaml` 的两个写入方统一为「只补缺、不重排、单个结尾换行」，`sync --check` 不再每次启动都报「将改写」。
- `patch-pnpm` 的改动面从「整段替换 registerProject」缩到「只包一行 try/catch」，对官方改版的敏感度更低。
- 启动顺序固定为 `activate`（暂存插件）→ `patch-all`（补丁）→ `compat-heal`，都在 dsh 起来之前完成。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变，老壳可以自动升到本版。

### 升级会做什么

- 替换清单里的壳文件；`home\` 下的插件清单 / 网关配置 / 会话 / 凭证一律不碰，你自己放进 `tools\` 的脚本会保留。
- 换装前整份备份到 `cache\shell-backup-<时间戳>`，换完自动跑 `verify-shell` 的换装闸门，不通过就整体回滚。
- 升级后第一次启动会自动补三族补丁，不需要再手动跑 `repair`。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`（按最新备份整体还原，还原后同样跑 verify）。
- 想退回某个更早版本：`node tools\shell-update.mjs apply --to 0.1.4 --force`（降级必须显式 `--force`）。
- 网页兜底：从 Release 页下载 `harness-shell-0.2.0.zip` 整包覆盖壳文件。