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
- 想退回某个更早的版本：`dsh-portable.cmd shell-update check --to v<旧版本>`，确认后 `stage --force` + `apply`（降级必须显式 `--force`，默认拒绝降级）。
- 备份目录可以手工清理（`tmp\` 下 `shell-backup-*`），删之前建议先复制一份到盘外。
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
- 想退回某个更早版本：`node tools\shell-update.mjs apply --to 0.1.0 -Force`（降级必须显式 -Force）。
- 网页兜底：从 Release 页下载 `harness-shell-0.1.1.zip` 整包覆盖壳文件；只想修清单就单独下 `shell-version.json`。
