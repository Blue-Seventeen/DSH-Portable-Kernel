# test/ — 壳的多角度校验（本地专用，不进 GitHub、不随发布）

这个目录**只存在于工作区**：`.gitignore` 里有 `/test/`，壳清单（`shell-version.json:files`）也不会收录它，
所以它不会出现在 Release 整包里，也不会被 `shell-update` 覆盖。

## 为什么有它

`verify-shell.mjs` 是**交付门禁**（随壳发布、用户机器上也会跑，必须只读、快、不依赖网络）。
这里放的是"开发期更宽的多角度校验"：可以联网、可以起临时目录、可以跑几十秒。

## 怎么跑

```powershell
node test\run.mjs                # 全跑
node test\run.mjs --list         # 只列用例
node test\run.mjs --filter store # 只跑名字里含 store 的
node test\run.mjs --json         # 机器可读（给 CI / 发布流程用）
```

退出码：`0` 全过；`1` 有失败。**发布前必须全过**（`shell-release prepare` 只跑官方门禁，
这个套件是发布前额外的一道人工闸）。

## 覆盖的角度

| 组 | 校验什么 |
|---|---|
| `01-encoding` | 根目录 `.cmd` 纯 ASCII + CRLF；`dsh-portable.ps1` / `tools\lib\say.ps1` 各只有一个 BOM；`README.md` / `version.json` 无 BOM 且是合法 UTF-8 |
| `02-manifest` | 清单 schema、`tag`/`shellVersion` 一致、`files` == 磁盘上的壳文件集合、路径白名单、`userOwned ⊆ files`、六节 notes、`migrations` 的脚本存在 |
| `03-patches` | 三族补丁的锚点自测（`selftest-patches`）、store 判定自测、drain 自测、`patch-all --check`、暂存引擎自测 |
| `04-store` | `.modules.yaml` 记录的 store 与三份 yaml 的 `storeDir` 一致（2026-11-04 两次事故的核心） |
| `05-plugins` | 三份 `package.json` 依赖逐字符一致；bundles 数量与 `version.json` 一致；只有一份共享副本（web/desktop 下没有第二份） |
| `06-cli-surface` | 命令面齐全：`plugin-stage*` / `market-history` / `shell-update defaults`；`dsh-portable.ps1` 的 ValidateSet 含新动作；`dsh-portable.cmd` 也 `call env.cmd` |
| `07-update-plan` | 用**本地清单副本**跑一次 `check` / `apply --dry-run`（不联网）：同版本应为 `up-to-date`、`apply` 直接说"已是最新"；`computeRemoved` 不删机器配置 |

## 加用例

在 `cases/` 下新建 `NN-名字.mjs`，导出：

```js
export const cases = [
  { name: '这里写断言名', async fn() { /* 失败就 throw，成功就返回 */ } },
]
```

`lib.mjs` 提供 `ROOT / NODE / read / exists / sha / run / assert`。
用例之间互相独立，**不要**改工作区文件（需要落盘就写到系统临时目录）。
