# DSH 便携版 · Hack3rX-Harness

> 一句话记住：**这个仓库只装"壳"，官方那层（app / desktop / 运行时）第一次运行时自动下载**——所以它小、干净、可以放进 U 盘，也可以直接 clone。

官方 DeepSeek Harness（`@deepseek-ai/dsh`，MIT）本身是一个装在 Windows 上的桌面 + Web 客户端。本项目在它**外面**套了一层便携壳：

| | 官方那层 | 本仓库（壳） |
| --- | --- | --- |
| 是什么 | `app\`（npm 包）、`desktop\`（Electron 安装包）、`runtime\`（node + pnpm） | 10 个根目录脚本（9 个 `.cmd` + 1 个 `.ps1`）+ `tools\` + `home\profiles\` 的清单/锁文件 |
| 谁维护 | 官方发布，我们只下载、不改 | 我们自己写，随仓库走 |
| 体积 | 约 1.5 GB | 约 3.9 MB |
| 会不会进 git | **不会**（单文件最大 235 MB，超过 GitHub 100 MB 硬限制） | 会 |

壳负责的事：便携（数据和程序都待在同一个文件夹里）、`web` / `desktop` 两种启动方式、主题随身带、一键更新、关掉官方自动更新、把插件市场改成认子目录的路径。

---

## 一、快速开始

前提：Windows 10 1803+（要系统自带 `tar.exe`）、能上网。

1. `git clone https://github.com/Blue-Seventeen/hack3rx-harness` 到任意目录（**路径别太深**，见"已知坑"）。
2. 双击 `preflight.cmd`。
3. 第一次运行会发现"官方那层不在"，自动补齐（可断点重跑），补完直接选自检 / 浏览器模式 / 桌面模式。

`preflight.cmd` 判断"缺官方层"的依据是四样东西：`runtime\node\bin\node.exe`、`runtime\pnpm\dist\pnpm.mjs`、`app\node_modules\@deepseek-ai\dsh\lib\bin.js`、`desktop\resources\app.asar`。

等价命令行：

```bat
dsh-portable.cmd bootstrap
```

`bootstrap` 依次做五件事，**已经存在的步骤自动跳过**（所以可以反复跑）：

| 步骤 | 下载内容 | 下载 / 落盘 | 产物 |
| --- | --- | --- | --- |
| node | `nodejs.org` 官方 x64 zip（v24.21.0） | 35.9 MB / 89 MB | `runtime\node\bin\node.exe` |
| pnpm | npm 上的 `pnpm` 包（11.28.5） | 5.5 MB / 22 MB | `runtime\pnpm\dist\pnpm.mjs` |
| app | `@deepseek-ai/dsh@latest` 及全部传递依赖（本次 567 个包） | — / 407 MB | `app\node_modules\@deepseek-ai\dsh\lib\bin.js` |
| desktop | 官方安装包，两层解包（外层容器 + 内层 `app-64.7z`） | 276 MB / 1044 MB | `desktop\resources\app.asar` |
| 插件 | 商城 `dshmarket` + 两个主题 | ~20 MB / 11 MB | `home\profiles\node_modules\dshmarket` |

进度显示：**node / pnpm / desktop 有进度条**（自己读 HTTP 流 + `Write-Progress`，7z 解包用 `-bsp1`）；**app 与插件这两步输出的是 pnpm 日志行**（`--reporter append-only`），慢也慢在这两步，别以为卡住了。

下载物：

- `cache\update\` 只留三个安装包（node zip / pnpm tgz / desktop exe）和每次的日志，重跑时按 `.size` 里的长度核对后直接复用（长度对不上就重下）。
- app 与插件的包体在 pnpm 的全局 store：`%LOCALAPPDATA%\Hack3rX-Harness\pnpm-store`（GB 级）。
- `app` 与 `desktop` 都是先装进 `xxx.next`，校验通过才改名，不会留半成品；自举换装失败会自动把旧目录改回来。

---

## 二、目录结构

```
<root>\
  preflight.cmd          ← 双击入口：缺官方层就先 bootstrap，再选自检/启动
  start-web.cmd          ← 浏览器模式
  start-desktop.cmd      ← 桌面窗口模式
  dsh-portable.cmd       ← 管理命令入口（doctor / verify / tidy / update-all …）
  dsh.cmd / dsh-plugin*.cmd / check-update.cmd / env.cmd
  dsh-portable.ps1       ← 壳的全部逻辑（唯一的"大脑"）
  version.json           ← 出厂快照（文件数 / 体积 / asar 字节 / 版本）
  README.md  LICENSE     ← 文档与许可
  tools\                 ← node 小工具（verify-shell / clean-ship / plugin-shared / patch-market / 7z …）
  runtime\               ← [自动下载] node + pnpm；vcredist（7 个 DLL）随仓库
  app\                   ← [自动下载] 官方 npm 包
  desktop\               ← [自动下载] 官方 Electron 程序
  home\profiles\         ← 插件清单（web / desktop 各一份）+ 共享 node_modules
  cache\  logs\  tmp\    ← 运行时产物，不入库
```

`home\` 里随仓库走的只有两样：`profiles\`（插件清单 / 锁文件，不含 `node_modules`）和 `cordis.patch.yml`（壳的加载器补丁层：只留主题与界面偏好，**不含任何第三方网关、模型供应商或密钥**；想接自己的 OpenAI 兼容网关，文件开头有注释示例，密钥一律走 `apiKeyEnv` 读环境变量）。其余一切（`sessions\`、`storages\`、`logs\`、`dsh-market\`、`.credentials.yaml`、`.anonymous-user-id`、`settings.yaml`）都是运行时产物，**仓库里一个都不带**。

---

## 三、常用命令

全都可以用 `dsh-portable.cmd <动作>`：

| 动作 | 做什么 |
| --- | --- |
| `bootstrap` | 只有壳时补齐官方那层（可反复跑） |
| `doctor` | 只读体检：残留、7z、Office 补丁、市场补丁、版本豁免 |
| `verify` | 交付门禁，31 项断言，全过 exit 0 |
| `tidy` | 清临时残留（桌面程序在跑会拒绝，`-Force` 强来） |
| `update-all` / `update-app` / `update-desktop` | 更新官方那层。**默认只预演**，加 `-Force` 才真更新（`xxx.next` → 校验 → 换名） |
| `repair` | 修启动失败：`check-update.cmd` 会自动调用它 |
| `fix-state` / `fix-office` / `fix-market` / `unblock` | 修 pnpm 状态 / Office 补丁 / 市场补丁 / 解除"下载文件被锁" |
| `show-desktop` / `close-desktop` / `focus-desktop` | 桌面窗口三件事（退出码见下） |
| `clean-ship [apply\|verify\|refresh] [keep-creds]` | 出货前清个人数据；`refresh` 重算 `version.json` 的文件数/体积 |
| `plugin-list` / `plugin-add` / `plugin-remove` / `plugin-sync` / `plugin-allow` | 插件管理（写的是共享目录） |
| `plugin-adopt` / `plugin-revoke` | 把插件收进共享目录 / 撤销 |
| `sync-home` / `reset-shell` / `launch-desktop` / `check-updates` | 对齐 DSH_HOME / 重置壳状态 / 直接起桌面模式 / 只查更新 |

`show-desktop` 的退出码：`0` 窗口可见、`1` 原来在托盘/隐藏态、这次被唤出来了、`2` 进程都没有、`3` 进程在但还没建出窗口。`close-desktop` 只要**确认没有可见窗口**就 `exit 0`——此时进程可能还在托盘里，想彻底退出用任务管理器或先 `focus-desktop` 再关窗。

壳认的几个环境变量（都在代码注释里，不放心的可以不设）：`DSH_PORTABLE_KEEP_CONSOLE=1` 启动后保留黑框、`DSH_PORTABLE_NO_UPDATE_CHECK=1` 跳过启动前查更新、`DSH_PORTABLE_NO_FOCUS=1` 不自动抢焦点、`DSH_PORTABLE_OFFICE_ALWAYS=1` 强制重装 Office 运行库。

---

## 四、三条必须守住的不变式

改壳的时候这三条最容易踩，`tools\verify-shell.mjs` 会逐条查：

1. **`.cmd` 只能是纯 ASCII + CRLF**。cmd.exe 按字节解析 UTF-8 中文会错位（曾把一行注释当命令执行），中文一律走 `tools\say.ps1`；只写 LF 会报 `The system cannot find the batch label specified - dsh_done`。`.gitattributes` 里这三类文件是 `-text`（按字节存，任何机器 clone 都不会被转成 LF）。
2. **`dsh-portable.ps1` 与 `tools\say.ps1` 必须 UTF-8 BOM，而且只能有一个**。PS 5.1 不带 BOM 会按 ANSI 读中文，字符串全变乱码；写脚本时用 `.NET` 读回再写会把 BOM 当字符保留、于是变成两个 BOM，PowerShell 直接报 `An expression was expected after '('`。`README.md` / `version.json` 反过来：**不要 BOM**。
3. **插件只有一份共享副本**。`home\profiles\node_modules` 是共享目录，两个 profile 的 `pnpm-workspace.yaml` 都写 `modulesDir: ../node_modules`，三份 `package.json` 的 `dependencies` 必须逐字符一致；`home\profiles\{web,desktop}\node_modules\dshmarket` 不允许存在（否则同一个插件会有两份，升级后一份新一份旧）。

另外三条官方规则，改不了只能顺着：

- **版本豁免必须是精确版本**。`compatibility.json` 里写 `"*"` 会让整条记录被忽略（日志里就是 `dsh: skipping profile bundle "@huanlin/…"`）。换版本由 `compat-heal` 在启动前把精确版本改写掉；没有任何插件需要豁免时，官方语义是**删掉这个文件**（缺失 = 无豁免），所以干净交付里两份 `compatibility.json` 都不存在。
- **exFAT / 移动盘不支持软链**，所以 `pnpm-workspace.yaml` 里固定 `nodeLinker: hoisted`。
- `storeDir` 与机器用户名有关：`tools\fix-pnpm-state.mjs` 会在每次启动时把本机的绝对路径写进三份 `pnpm-workspace.yaml`（这三个文件是入库的），所以**跑过之后 `git status` 会显示它们被改动、diff 里带本机路径**。发布前用 `git checkout -- home/profiles` 清掉即可，仓库里的版本本身不含 `storeDir`。

---

## 五、已知的官方行为

| 现象 | 原因 |
| --- | --- |
| 有一个 Inspector 默认监听 `127.0.0.1:9230` | 官方 `@deepseek-ai/dsh-experimental-inspector` 的默认值，只在回环地址；壳既没改它，也没替你转发端口。该包内部另有 `authorizeIndex` / 401-403 的拒绝逻辑，具体鉴权策略以官方实现为准 |
| 点标题栏的 `X` 只是 `hide()`，进程还在 | Electron 官方写法；`close-desktop` 只是"不再有可见窗口"，真要退出得结束进程 |
| 只有一个实例，第二次双击会唤回旧窗口 | 官方单实例锁；壳把它映射成退出码 3 / `focus-desktop` |
| LibreOffice 转换成功却 `exit 1` | 官方 kit 的退出码怪癖：产物文件才是判断依据。壳已给它打 `maxRetries: 3` 补丁缓解只读目录清理失败，**再遇到 exit 1 先看产物** |
| 启动时有个黑框一闪 | `desktop\...\app-update.yml` 被禁用后仍会尝试，日志已脱敏 |

---

## 六、已知坑与对策

| 坑 | 对策 |
| --- | --- |
| 目录太深，pnpm 解包后路径超过 260 字符（`Could not find a part of the path 'xxx.js.map'`） | `bootstrap` 与 `update-app` 都先装到 `%LOCALAPPDATA%\Hack3rX-Harness\build\`，再用 robocopy 搬回来（robocopy 支持长路径）。**建议把整包放在路径不超过 ~80 字符的地方**，`preflight.mjs` 会按"官方层最长相对路径约 180 字符"给出警告 |
| pnpm 报 `ERR_PNPM_IGNORED_BUILDS` | pnpm 10+ 的严格构建策略；`bootstrap` / `update-app` / 插件安装都带 `--config.strict-dep-builds=false`（`node-pty` 有 prebuilds，不需要本地编译） |
| 报 `ERR_PNPM_EISDIR … symlinkAllModules` | 盘不支持软链（exFAT/FAT32）；必须 `nodeLinker: hoisted` |
| 插件装完就"消失" | 版本豁免没跟上：`dsh-portable.cmd plugin-list` 看状态，`tools\plugin-shared.mjs compat-heal` 修 |
| 桌面窗口双击没反应 | `dsh-portable.cmd show-desktop` 看退出码（0/1/2/3 含义见上） |
| pnpm 的包仓库在 `%LOCALAPPDATA%\Hack3rX-Harness\pnpm-store`（GB 级，不随便携目录走） | 有意为之：store 放在 U 盘上装插件会慢一个数量级；真要整盘带走，把这个目录一起拷过去 |
| `fix-office` 在 Win10 1809+ 默认**跳过** vcredist 拷贝 | 系统自带运行库就够了；确实要重装用 `fix-office -Force` 或 `DSH_PORTABLE_OFFICE_ALWAYS=1` |
| 市场补丁显示"另有 17 处未覆盖的 `node_modules` 引用" | 已知且可接受：这 17 处不是 `join(a, 'node_modules', b)` 的三参形状，不影响商城装/列插件（补丁本身 55 处字面 = 1 定义 + 54 调用点，`verify` 会逐文件核对） |

---

## 七、验证记录

常规门禁（2026-11-02 / 03，Windows 11 26200 / node v24.21.0 / dsh 0.2.1-rc.5 / exFAT U 盘）：

| 项目 | 结果 |
| --- | --- |
| `verify`（交付门禁） | **31 项全过**，连跑多次指纹不变 |
| `doctor`（只读体检） | 6–8 s，残留 0、7z 24.08、Office 已打 14 个 DLL、市场补丁 55 处字面、版本豁免一致 |
| `clean-ship verify` | 11 项全过，0 文件 / 0 MB 残留 |
| 桌面冷启动 | 4.3–5.3 s 返 `exit 0`，13 s 出现窗口 |
| 第二次双击 | 4.4 s 返 `exit 0`，进程数 5→5（没有起第二份） |
| 浏览器模式 | 8 s 出地址，HTTP 200 / 39,645 B，日志里 `skipping profile bundle` 0 条 |

自举（在只有壳的目录里实测）：

| 场景 | 结果 |
| --- | --- |
| 全新空壳（40 个文件）跑 `bootstrap` | 成功补齐 node / pnpm / app / desktop / 插件，随后 `verify` 31 项全过 |
| 已有官方层再跑 `bootstrap` | 2.8 s 全部跳过，`exit 0`（幂等） |
| 删掉 `runtime\node`、`runtime\pnpm`、`app` 后重跑 | 418 s 全部重建，五个产物齐全，`exit 0` |

---

## 八、许可与归属

- `@deepseek-ai/dsh` 与官方桌面程序：MIT，版权归 DeepSeek；本仓库**不包含**它们的二进制，只提供下载脚本。
- 插件：`dshmarket`、两个主题皮肤，各自遵循其包内许可。
- 壳（根目录脚本、`tools\`、文档）：MIT，见 [LICENSE](LICENSE)。
- 本仓库的 `master` 曾经是官方源码的镜像分支，2026-11-03 起换成只装壳。覆盖前那一个提交是 `ce7073d51254c26cd63b22a60835b8f948deb447`（20,233 个文件，属于官方 DeepSeek Harness 源码，可在 GitHub 提交页按此 SHA 直接查看）。为了不让 clone 拖上 357 MB 的旧对象，没有给它留 tag。

> 一句话记住：**壳进仓库，官方那层靠 `bootstrap` 现拉；改壳先跑 `verify`。**
