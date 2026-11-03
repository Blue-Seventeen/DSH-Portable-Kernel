# 发布壳（RELEASING）

给维护者的 30 秒版本。完整规则见 [`doc/agent-develop-doc/10-release-and-versioning.md`](doc/agent-develop-doc/10-release-and-versioning.md)。

## 版本号规则（0.x 阶段）

| 改动性质 | 版本位 | 例子 | 注意 |
| --- | --- | --- | --- |
| 修 bug、改文案、换主题默认值 | **patch** | `0.1.0` → `0.1.1` | 最常见 |
| 加功能、加子命令、加清单字段 | **minor** | `0.1.1` → `0.2.0` | 清单新增字段必须向后兼容（老壳读到不认识字段要能忽略） |
| 用户必须手工做点什么才能升级（改配置、搬目录、换更新源） | **major** | `0.2.0` → `1.0.0` | 同时 bump 清单的 `updaterMin`，并把"要人工做什么"写进 `### 破坏性变更` |

- tag 名 = `v` + `shellVersion`（例：`v0.1.0`），tag 一旦推上去就**永不移动、永不删除**。
- `minShellVersion`：能自动升到本版的最低壳版本；低于它的实例必须先手工同步一次壳。
- `updaterMin`：能正确读本版清单的最小 `shell-update` 版本（清单 schemaVersion 2 对应 `updaterMin: 2`）。
- `releasedAt` / `tag` / `notesUrl` / `zip` 全部由 `prepare` 写入，**不要手改**。

## Runbook（9 步）

1. **改壳**：改完代码（`tools\*.mjs`、根脚本、`home\profiles` 的清单类文件）。新文件要进壳，先加进 `tools\shell-update.mjs` 的壳白名单，再跑 `clean-ship refresh` 才会出现在清单 `files` 里。
2. **写更新细则**：在 `RELEASE-NOTES.md` 顶部新增 `## v<新版本> — <YYYY-MM-DD>` 一节，六个小节写全（没有就写"无"，小节不许省）。
3. **本地自检**：`dsh-portable.cmd verify`、`node tools\selftest-shell-update.mjs`、`node tools\shell-update.mjs check` 都要绿。工作树要干净（发布提交里不该混进调试残留）。
4. **先看计划**：`node tools\shell-release.mjs prepare --version <新版本> --dry-run`。
   它会打印要写进 `shell-version.json` 的字段变更、将执行的命令、以及整包的 `name / bytes / sha256 前 12 位`（整包在 `%TEMP%` 里试打，仓库零写入）。确认版本位选对了再往下。
5. **正式 prepare**：`node tools\shell-release.mjs prepare --version <新版本>`。
   它会：写 v2 清单字段 → 跑三门禁（`clean-ship refresh` / `verify-shell` / `selftest-shell-update`）→ 再 refresh → 按清单 `files` 打 `harness-shell-<版本>.zip`（**不含** `shell-version.json`）→ 把 `zip:{name,sha256,bytes}` 写回清单 → 再 refresh → `git add -A` + commit + `git tag -a v<版本>` → tag 自校验（tag 里清单的每个 sha256 必须等于 tag 里文件字节）。
   最后一行看到 `tag 自校验 … ✓` 才算过。
6. **配 token**：`set GH_TOKEN=<PAT>`。fine-grained PAT 需要 **Contents: Read and write**；经典 PAT 需要 `repo`。也可以用 `--token-env <变量名>` 指定别的变量；都没配时脚本会试 `git credential fill`（token 永不打印，只报来源和长度）。
7. **发布**：`node tools\shell-release.mjs publish`。
   它会：`git push origin master` + `git push origin v<版本>` → 查/建 Release（已存在则复用，`--sync-notes` 可刷新说明）→ 上传 `shell-version.json`（字节取自 `git show v<版本>:shell-version.json`，**不是工作树**）与 `harness-shell-<版本>.zip`（按 tag 重打并校验 sha 与清单一致）→ 下载回来比对 sha256。
   先演练可以加 `--dry-run`（只打印，不推送不联网）。
8. **端到端验**：`node tools\shell-release.mjs verify-published --version <新版本>`。
   它拿**上一个 tag** 当"老用户"：clone 到 `%TEMP%` → 跑老壳的 `shell-update check`（断言 `update-available` 且 `remote` == 新版本）→ `stage` 到临时目录并逐文件比对 sha256 → 断言用户数据（`home\sessions`、`home\.credentials.yaml` 等）哈希零改动 → 断言 Release 上的清单字节 == tag 字节、整包资产 size == 清单 `zip.bytes`。首个版本会打印"首个版本，跳过"（退出码 0）。
9. **同步本机实例**：把本机那份壳（例如 `G:\Hack3rX-Harness`）当成普通用户走一遍 `dsh-portable.cmd shell-update check` → `apply`，确认升级后 `doctor` 正常、插件能装卸。这样发布链路才算真正验过。

出问题随时 `node tools\shell-release.mjs <子命令> --help`；`defaults --json` 会打印默认仓库/清单地址/tag 模板/退出码表。

## 坏版本处置

**原则：已发布的 tag 不移动、不删除，用"下一个版本"修。**

1. **立即止损**：在 GitHub 上把该 Release 勾成 **pre-release**（`releases/latest` 会自动回退到上一个稳定版，用户侧的 `check` 就不再指向坏版本）。
2. **发补丁版**：修好后走一次正常 runbook，版本号只 +patch，`### 修复` 里写清"上一版哪里坏了、这版怎么修"。
3. **禁止**：删除 Release、删除/移动 tag、`git push --force` 覆盖 master、就地覆盖 Release 上的资产文件（资产有下载缓存与 sha256 记录，就地换文件会让"清单 sha ≠ 实际字节"，用户端校验直接失败）。
4. **用户已升级且坏得严重**：在 `RELEASE-NOTES.md` 的 `### 如何回退` 里写明确的回退命令（`dsh-portable.cmd shell-update rollback` / `recover`），并提醒备份目录位置。
5. **清单本身发错**（例如 `zip.sha256` 与资产不符）：也发补丁版覆盖 latest，别手改资产；`verify-published` 会把这类问题打成 FAIL。

## 发布前检查清单

- [ ] `RELEASE-NOTES.md` 新版本小节六小节齐全，日期与 `releasedAt` 同一天
- [ ] `shell-version.json` 里 `schemaVersion: 2`、`tag`、`minShellVersion`、`requires`、`userOwned`、`notes`、`zip` 都在
- [ ] `files` 里没有该排除的东西（`version.json`、`home\sessions`、`.credentials.yaml`、`node_modules`）
- [ ] `zip.name == harness-shell-<版本>.zip`，`zip.bytes` 与本地资产大小一致
- [ ] 三门禁全绿；`prepare` 末尾的 tag 自校验打印 ✓
- [ ] `publish` 的两个资产下载校验都打印 sha256 一致
- [ ] `verify-published` 全 PASS（或明确是首个版本跳过）
