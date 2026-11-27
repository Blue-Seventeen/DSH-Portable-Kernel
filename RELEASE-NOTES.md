# DSH-Portable-Kernel 发布说明（RELEASE-NOTES）

本文件随壳发布：每个版本一节，`shell-update check` 会把它当成"更新细则"展示给用户，
`devtools\shell-release.mjs prepare` 会把 `## v<版本>` 这一节的六个小节解析成清单里的 `notes`。

写作规矩（发布前请照做）：

- 版本标题固定格式 `## v<版本> — <YYYY-MM-DD>`，`<版本>` 必须与 `shell-version.json` 的 `shellVersion` 一致。
- 六个小节必须都在、顺序固定：`### 新增` / `### 修复` / `### 优化` / `### 破坏性变更` /
  `### 升级会做什么` / `### 如何回退`。没有内容就写 `无`（**小节不能省**，缺一个小节 `prepare` 会直接失败并点名）。
- 一条一行，用 `- ` 开头；一行说清一件事，别写"若干优化"这种空话。
- 讲"用户能感觉到什么"，不要罗列内部重构。

---

## v1.0.7 — 2026-11-27

对 v1.0.6 那套"跳过自检"的补丁做**收紧与补全**。1.0.6 有三个我自己找出来的洞，这一版全堵上。

### 新增

- 用例：自检脚本在、但它依赖的模块缺失（壳真坏）→ 必须回滚，不许当跳过。
- 用例：自定义自检命令不许被路径重解析劫持（只接管 `verify*.mjs`）。

### 修复

- **1.0.6 的跳过判定太宽，会把"壳真坏了"也放过。** 初版只要输出里有 `Cannot find module` 就往"脚本没了、跳过吧"走；于是"自检脚本在、但它 import 的模块被删了"这种真正的半截壳也会被提交。现在必须**精确比对**：node 抱怨的缺失模块必须**就是我们要跑的那个自检脚本本身**，缺别的模块照旧整份回滚。
- **回滚到老版本时误报"回滚失败"。** 回滚会把树换回老结构，但自检命令还沿用换装前算好的新结构路径，那个文件已经不在 → 必然失败 → 报"回滚失败"，可文件其实早已正确还原（实测 0.7.3 备份 66/66 全部一致却报失败）。现在落盘后**按当前这棵树重挑自检器**：回滚到老版本就跑老版本自己的自检。
- **路径重解析会劫持自定义自检命令。** `resolveVerifyCmd` 初版无条件替换候选，把 `node -e "process.exit(3)"` 换成了目录里的 verify 脚本，退出码从 3 变 1（自测用例 E 当场变红）。现在只接管文件名形如 `verify*.mjs` 的命令，其余原样不动。

### 优化

- 三处判定抽成 `isVerifyScriptGone` / `resolveVerifyCmd` 两个助手，apply 与 rollback 共用同一套规则，避免两边逻辑漂移。

### 破坏性变更

- 无。

### 升级会做什么

- 替换 `tools\update\shell-apply.mjs` 与本说明。

### 如何回退

- `dsh-portable.cmd shell-update rollback`

---

## v1.0.6 — 2026-11-27

解掉**老客户端跨结构升级的死结**：0.6.2 ~ 0.7.x 现在能真正升上来了。

### 新增

- `tools\verify-shell.mjs` **兼容转发桩**：只把参数与退出码原样交给 `tools\verify\verify-shell.mjs`，自己不实现任何检查。老版本把"换装后自检"的路径写死成这个位置，留着它就等于给老客户端留了一条能走通的路。
- `verifyCmd` 改为**候选路径**：先找 `tools\verify\verify-shell.mjs`，再找扁平兼容路径，不再写死单一位置。

### 修复

- **0.6.2 ~ 0.7.x 带清单的壳永远升不到 1.x。** 老客户端换装完成、去跑自检时，那条写死的 `tools\verify-shell.mjs` 已经被换装删掉 → node 报 `Cannot find module` → 旧代码判定"自检不通过"→ 整份回滚。用户看到的是"升级失败，已回滚"，重试多少次都一样。
- 现在两条路都通：新结构里有转发桩，自检照常**真跑**（安全网没缺口）；万一将来又挪了位置，自检脚本确实消失时**记"跳过"而不是回滚**，并提示用户手动跑一次 `verify` 复核 —— 不再用"不许升级"惩罚用户。
- 跳过逻辑只认"脚本找不到"这一种情形（`Cannot find module` / `ERR_MODULE_NOT_FOUND`）；自检**真跑失败**依旧整份回滚，安全网没被拆掉。

### 优化

- 新增 5 条用例（共 175 条）：桩存在且在清单里、参数与退出码透传、脚本消失→跳过、真失败→仍回滚、`verifyCmd` 候选路径。

### 破坏性变更

- 无。

### 升级会做什么

- 新增 `tools\verify-shell.mjs`（约 1.9 KB 的转发桩），替换 `tools\update\shell-update.mjs`、`tools\update\shell-apply.mjs` 与本说明。

### 如何回退

- `dsh-portable.cmd shell-update rollback`

---

## v1.0.5 — 2026-11-27

修一个**每个用户都会撞上**的自检缺陷 —— 修它是在真实安装上升级时发现的。

### 新增

- 新增守卫用例：`verify` 的必需文件清单里不许出现 `devtools/`，对 `devtools` 的任何执行必须先过 `MAINT()` 存在性守卫。

### 修复

- **`dsh-portable.cmd verify` 在用户机器上必然报红。** `verify-shell` 里有 4 处引用 `devtools/`（`selftest-drain` / `selftest-patches` / `selftest-store` / 必需文件清单里的 `clean-ship.mjs`）。`devtools/` 是维护者工具，**不随壳下发**，所以用户环境里一个都没有——三项自测直接 FAIL，必需文件清单还常年缺一项。
- 现在：三项维护者自测在没有 `devtools` 时记 SKIP（不算失败、不算通过），必需文件清单移除 `clean-ship.mjs`。工作区（有 devtools）里行为不变，仍然真跑。

### 优化

- SKIP 行会写明原因（维护者自测、devtools 不随壳下发），不让用户以为是自己的环境坏了。

### 破坏性变更

- 无。

### 升级会做什么

- 只替换 `tools\verify\verify-shell.mjs` 与本说明。

### 如何回退

- `dsh-portable.cmd shell-update rollback`

---

## v1.0.4 — 2026-11-27

升级模块的两处**契约级**问题：一处会误删用户文件，一处会让两个进程互相拆台。

### 新增

- `tmp\shell-update.lock` 单实例锁：换装 / 回滚 / 恢复同一时刻只许跑一个。活着的新锁会拒绝并报出持锁 pid；已死的 pid、损坏的锁、超过 30 分钟的锁会被接管并提示。预演（dry-run）不抢锁。

### 修复

- **预演会删文件。** 不带 `--force` 的 `apply` 帮助里写着"只报告，不改文件"，但"已是最新"分支里无条件跑了残留清理——用户只想看一眼有没有更新，盘上的旧文件就没了。现在预演只报"将清理 N 个"，真删必须 `--force`。
- **并发换装互相拆台。** 两个进程同时换装会算出同名备份目录（名字只精确到天），一起写同一个 `files\`。实测其中一个 EBUSY 后回滚，而它读的是被两个进程混写过的备份，等于把另一个进程刚装好的壳倒回去。

### 优化

- 新增 4 条"契约级"用例（共 169 条）：预演零写盘、锁的三种状态（活锁拒绝 / 死锁接管 / 坏锁接管）、三个写盘入口都必须持锁。

### 破坏性变更

- 无。锁文件只在换装期间存在，结束即删。

### 升级会做什么

- 只替换 `tools\update\shell-apply.mjs`、`tools\update\shell-update.mjs` 与本说明。

### 如何回退

- `dsh-portable.cmd shell-update rollback`

---

## v1.0.3 — 2026-11-27

换装的最后一处 Windows 脆性：**刚执行过的文件删不掉**。

### 新增

- `shell-apply` 增加瞬时锁重试：`EBUSY`/`EPERM`/`EACCES`/`ENOTEMPTY` 退避重试 5 次（50→800ms），其他错误照旧立即抛。

### 修复

- 1.0.2 验证时实测到：`--full` 用 `tools\7z\7z.exe` 解完整包后，紧接着按目标清单删这个 7z 会报 `EPERM`，整次换装失败。Windows 上刚执行过的 exe、杀软实时扫描、索引器都会短暂持有句柄——这是**瞬时**状态，不是真占用。
- 现在重试即可通过；同样的降级换装已实测成功（"2 个旧文件已删"）。

### 优化

- 回滚路径（删除本次新增的文件）也走同一套重试。

### 破坏性变更

- 无。

### 升级会做什么

- 只替换 `tools\update\shell-apply.mjs` 与本说明。

### 如何回退

- `dsh-portable.cmd shell-update rollback`

---

## v1.0.2 — 2026-11-27

**修一个我自己的判断失误**：1.0.0/1.0.1 把 7z 踢出了壳，但它是**运行期依赖**，不是发布工具。

### 新增

- 化石清单清理加了三重保护：不再删"新版清单里仍然存在"的路径（否则 7z 会被当残留清掉）。

### 修复

- **7z 回到壳里**（`tools\7z\`，58 个文件）。它至少在三处运行期要用：`--full` 整包换装、更新内核时解官方 tar.gz、更新桌面窗口时解 NSIS 里的 `$PLUGINSDIR\app-64.7z`（系统 tar 顶不了这个）。
- 1.0.1 的用户如果走过 `--full` 或更新过内核/桌面，会撞上 `no-7z`。装完 1.0.2 就恢复。
- `clean-ship` 是维护者命令，用户壳里没有它；现在改成优雅提示，而不是"找不到 xxx"报错。

### 优化

- 新增运行期依赖守卫测试：清单必须带 7z，运行期脚本不许把 7z 指向 `devtools\`，引用 `devtools\` 的任何一行都必须紧跟存在性检查。

### 破坏性变更

- 无。

### 升级会做什么

- 新增 `tools\7z\7z.exe` 与 `tools\7z\7z.dll`（约 2.4 MB），替换 updater 与本说明。
- 1.0.1 的用户清单里没有这两个文件，属于"新增"，不会影响其他文件。

### 如何回退

- `dsh-portable.cmd shell-update rollback`

---

## v1.0.1 — 2026-11-27

修掉 1.0.0 的一个尾巴：**从整包安装的壳升级后，旧结构的文件会留在盘上**。

### 新增

- 化石清单 `LEGACY_SHELL_FILES`（旧路径 → 旧版 sha256，35 条）与 `pruneLegacy()` 幂等清扫。

### 修复

- 整包装的壳没有本地清单（清单要记 zip 的 sha256，塞进 zip 就是循环依赖），而"列哪些文件该删"完全依赖已装清单。结果是 1.0.0 升级完，旧 `tools\*.mjs`（33 个）和 `tools\7z\`（2.4 MB）原样留着，白占空间。
- 现在带一份**化石清单**（旧路径 → 旧版 sha256，35 条）：命中且磁盘字节**逐字节一致**才删；用户改过一个字节就一律不动。
- 并且在"已是最新"时也顺手清一次（幂等），所以已经升过 1.0.0 的人，下一次启动就会自己收拾干净，不用重装。

### 优化

- 清完会把变空的 `tools\7z\` 目录一并移除。

### 破坏性变更

- 无。

### 升级会做什么

- 只替换 updater 自己（`tools\update\shell-update.mjs`）与本说明。
- 升级后再跑一次 `shell-update apply`（或等下一次启动），残留会被清掉。

### 如何回退

- `dsh-portable.cmd shell-update rollback`

---

## v1.0.0 — 2026-11-27

**结构重排：把「壳」和「开发工具」彻底分开。** 你拿到的东西少了一半还多，我们自己的发布工具不再跟着下发。

### 新增

- `tools/` 按职责分组：`update/`（自更新）、`patch/`（官方层补丁）、`profile/`（插件与 pnpm 状态）、`lib/`（公共件）、`verify/`（换装后自检）。找东西不用再在 35 个平铺文件里翻。
- `tools/lib/shell-root.mjs`：统一的壳根定位。以前每个工具都靠"往上数两层"找壳根，一旦目录分组就全错（这次就是这么把清单扫成 0 个文件的）。现在改成"就近向上找标记"，加多少层分组都不会断。

### 修复

- **整包里塞着 2.4 MB 的 7z**：那是我们打发布包用的，用户根本用不到。已随 `devtools/` 移出壳——整包从 1.83 MB 降到约 **0.6 MB**。
- `devtools/`（9 个发布/自测工具）也不再随壳下发，清单从 66 项减到 **56 项**。

### 优化

- 壳里只剩运行期真需要的东西：11 个入口脚本 + 25 个工具 + 出厂配置 + vcredist。
- `test/`（159 条用例）与 `doc/`（设计档案）从仓库忽略名单里解放：`test/` 已纳入版本控制，不再因为一次手滑就永久丢失（0.7.3 之前丢过一整个用例文件）。

### 破坏性变更

- **工具路径全部变了**（`tools\xxx.mjs` → `tools\<组>\xxx.mjs`）。对你没有影响：升级由壳自己完成，你不需要记路径。
- 若你在自己的脚本里硬编码过 `tools\shell-update.mjs` 之类的路径，需要跟着改：`tools\update\shell-update.mjs`。
- 用户数据、会话、插件、配置：**一个字节都不动**。

### 升级会做什么

- 按新清单添加/替换壳文件，并清掉旧路径上的壳文件（只清我们自己的壳文件，`userOwned` 与 `home\` 下你的东西一律不动）。
- 换装前自动备份到 `cache\shell-backup-<时间戳>`，换完跑自检，失败自动回滚。

### 如何回退

- `dsh-portable.cmd shell-update rollback`
- 或 `node tools\\update\\shell-update.mjs apply --to 0.7.3 --force`
- 网页兜底：从 Release 页下载 `harness-shell-1.0.0.zip` 整包覆盖（**先备份 `home\profiles`**）。

### 从 0.6.x 及更早升上来的话

- 那些版本的清单校验会拒绝新版清单（`whitelist-violation`），需要用一次 `--full` 整包换装，见 0.7.2 说明里的三步。

---
## v0.7.3 — 2026-11-27

为下一次结构重排铺路：升级模块学会「大版本迁移」，用户不用再手动下载脚本。

### 新增

- **大版本迁移声明**：壳清单可以带 `migration: { url, sha256, entry, note }`。当目标版本换了目录结构、逐文件替换根本做不到时，升级模块会改为：下载一次性迁移脚本 → 校验 sha256 → 执行 → 脚本自己删除。
  - 校验从严：**只接受 https + 可信主机**、只接受 64 位 sha256、入口只能是 `.cmd/.bat/.ps1`。任何一项不满足，就当没写这个字段，退回原来的逐文件升级（行为与旧版完全一致）。
  - 失败即中止：脚本哈希不符时**一个字节都不执行**；脚本退出码非 0 时报错并指向 `cache\major-upgrade-*` 备份；脚本说成功但版本没变，也会被复核抓出来。

### 修复

- 无。

### 优化

- 迁移执行期间的进度会显示在屏幕上（下载 / 执行两段），不会看着一动不动。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变、`requires` 不变。不带 `migration` 字段的清单，走的是原来那条路径。

### 升级会做什么

- 只替换一个文件：`tools\update\shell-update.mjs`（外加本说明）。
- 不动 app / desktop / 运行时，也不动你的数据、会话、插件和配置。

### 如何回退

- `dsh-portable.cmd shell-update rollback`
- 或 `node tools\update\shell-update.mjs apply --to 0.7.2 --force`

### 下一版预告

- 下一次发布会是 **1.0.0**：把 `tools/` 按职责分组（update / patch / profile / lib / verify），我方的发布工具（含 2.4 MB 的 7z）从壳里剥离到 `devtools/`，整包从 1.83 MB 降到约 0.6 MB，并合并几个重复入口。
- 装了 0.7.3 的人会**自动迁移**过去，什么都不用做；0.7.2 及更早的用户需要下载一次 `upgrade-to-1.0.0.cmd` 双击（升完会自己删掉）。

---

## v0.7.2 — 2026-11-27

模拟用户跑了两轮测试（壳升级链路 / 内核拉取与运行），查出 **1 个 P0 + 2 个 P1**。全部修掉。

### 新增

- 无。修缺陷版本。

### 修复

- **P0：从 Release 整包安装出来的壳，自升级 100% 失败**（`staging 里缺这个文件：tools/xxx.mjs`，一个字节都不写）。
  - 根因：整包**故意不含** `shell-version.json`（清单要记 zip 自己的 sha256，塞进去就是循环依赖）→ zip 安装没有本地清单 → `installed.files` 为空。而判定逻辑里有一条"`tools/` 下的陌生文件是用户自建脚本，永不覆盖"，判据正是 `installed.files[rel] === undefined` —— 空对象让**所有内容有变化的 tools 文件全被判`preserved`**（不下载、不进 staging）。可 `shell-apply` 只认 `userOwned`，其余一律要求 staging 里有它 → 原子预写校验必然失败。
  - 修法："陌生文件 = 用户自建"的推断只在**存在本地清单**时成立；无从证明是用户改动时，以远端清单为准。
  - 实测：0.7.0 整包 + 无清单 + 普通 `apply --force` → 16 秒成功、退出码 0、本地清单被写出、再查显示"已是最新"。
- **P1：全新 exFAT 机器 `bootstrap` 第一次必然失败（两处）**
  - ① pnpm 补丁打得太晚：`bootstrap` 原来只在五步全跑完后才打补丁，而 pnpm 族补丁修的正是 `registerProject()` 那条符号链接调用。exFAT 不支持软链 → 装 app 阶段直接 `EISDIR`。现在 `Bootstrap-Pnpm` 成功后**立刻**打 pnpm 族补丁，再继续装 app。
  - ② `Bootstrap-Profiles` 与 `Repair-PluginEnv` 调 pnpm 时漏了 `--config.node-linker=hoisted`（只有装 app 那两处传了）。exFAT 上默认 isolated 会在 `symlinkAllModules` 处 `EISDIR`。两处都补上。
- **P3：`update-app` 在全新壳上直接抛 `MODULE_NOT_FOUND: runtime\pnpm`**，用户看不出该先自举。现在缺 pnpm 时给一句人话：先跑 `bootstrap`。
- **`compat-live --refresh` 吞掉真实失败原因**：拿不到远端声明时只说"未采用（not-an-object）"。现在会带上本次刷新的失败原因（没网 / 404 / JSON 坏）。
- **旧壳人工介入的文案漏了 `--full`**：文案与文档都写 `apply --to 0.6.2 --force`，实测在 0.6.1 上必然失败（就是上面那个 P0）。已改成 `apply --to 0.6.2 --full --force`。

### 优化

- **补上发布门禁的盲区**：新增 6 条守卫（153 项）。核心是把 plan 阶段的判定做成可注入本地哈希的纯函数 `computePlanForTest`，从而能在隔离目录里直接验证"无本地清单 → tools 差异必须判 update 而不是 preserved"。这个 P0 能发布出去，正是因为门禁只比"清单 vs 资产"，从没测过"整包装出来的壳能不能自己升"。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变、`requires` 不变。

### 已在旧版本的用户请注意（重要）

- 如果你是从 **Release 整包 zip** 安装的（不是用 `bootstrap` 装的），在 0.7.2 之前你**升不动**。一次性人工介入：
  ```bat
  :: 把新壳这三个文件覆盖到旧壳目录
  ::   update.cmd
  ::   tools\update\shell-update.mjs
  ::   tools\update\compat-live.mjs
  node tools\update\shell-update.mjs apply --full --force
  ```
  `--full` 整包换装，绕开那个判定分歧；之后再升级就正常了。
- 用 `dsh-portable.cmd bootstrap` 装的用户不受影响（bootstrap 会写本地清单）。

### 升级会做什么

- 替换清单里的壳文件（本次变更 5 个：`dsh-portable.ps1`、`tools\update\shell-update.mjs`、`tools\update\compat-live.mjs`、`tools\lib\say.ps1`、`RELEASE-NOTES.md`）。
- 只换壳，不动 app / desktop / 运行时，也不动你的数据和配置。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`。
- 想退回上一版：`node tools\update\shell-update.mjs apply --to 0.7.1 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.7.2.zip` 整包覆盖壳文件（**先备份 `home\profiles`**，zip 里含出厂配置）。

### 尚未修的已知问题（如实列出）

- 整包不含 `version.json`：全新安装跑 `doctor` 会显示 `shell : 0 MB`，`verify` 有几项失败。不影响运行。
- 整包出厂 profile 的 bundles 计数与 `verify` 的声明差 1（web 6/7、desktop 13/14）。同上。
- `patch-all --apply` 在 app / dshmarket 尚未安装时返回硬失败（属于中间态噪声）。

---

> 更早的版本（v0.7.1 — 2026-11-27、v0.7.0 — 2026-11-27、v0.6.6 — 2026-11-27、v0.6.5 — 2026-11-27、v0.6.4 — 2026-11-27、v0.6.3 — 2026-11-27、v0.6.2 — 2026-11-27、v0.6.1 — 2026-11-27、v0.6.0 — 2026-11-26、v0.5.2 — 2026-11-26、v0.5.1 — 2026-11-12、v0.5.0 — 2026-11-12、v0.1.0 — 2026-11-03、v0.1.1 — 2026-11-04、v0.1.2 — 2026-11-04、v0.1.3 — 2026-11-04、v0.1.4 — 2026-11-04、v0.2.0 — 2026-11-04、v0.2.1 — 2026-11-04、v0.3.0 — 2026-11-04、v0.3.1 — 2026-11-04、v0.3.2 — 2026-11-04、v0.3.3 — 2026-11-04、v0.3.4 — 2026-11-05、v0.4.0 — 2026-11-05、v0.4.1 — 2026-11-05、v0.4.2 — 2026-11-05、v0.4.3 — 2026-11-05）见 GitHub Releases 与 `doc\release-notes-archive.md`。
