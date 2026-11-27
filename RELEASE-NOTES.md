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
