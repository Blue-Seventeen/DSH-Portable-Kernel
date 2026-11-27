# DSH-Portable-Kernel 发布说明（RELEASE-NOTES）

本文件随壳发布：每个版本一节，`shell-update check` 会把它当成"更新细则"展示给用户，
`tools\shell-release.mjs prepare` 会把 `## v<版本>` 这一节的六个小节解析成清单里的 `notes`。

写作规矩（发布前请照做）：

- 版本标题固定格式 `## v<版本> — <YYYY-MM-DD>`，`<版本>` 必须与 `shell-version.json` 的 `shellVersion` 一致。
- 六个小节必须都在、顺序固定：`### 新增` / `### 修复` / `### 优化` / `### 破坏性变更` /
  `### 升级会做什么` / `### 如何回退`。没有内容就写 `无`（**小节不能省**，缺一个小节 `prepare` 会直接失败并点名）。
- 一条一行，用 `- ` 开头；一行说清一件事，别写"若干优化"这种空话。
- 讲"用户能感觉到什么"，不要罗列内部重构。

---

## v0.6.5 — 2026-11-27

内核兼容区间修正：**壳更新不该被内核版本锁死**，同时上界必须跟着我们适配到的最新内核走。

### 新增

- **发版时的"上界过期检查"**：`prepare` 现在会去 npm 查 `@deepseek-ai/dsh` 的 `latest`/`next`，跟本次要写的 `requires.dsh` 上界对一次。落后就大声警告并拒绝发布（`--allow-stale-range` 可显式豁免）。以前这个上界是每次发版手工重复传的参数，连着几个版本没人动，直到出厂内核跑到自己声明的区间外面。

### 修复

- **内核比壳新不再阻断壳升级**（实测死锁）：原来"本机内核高于适配上界"被当成硬阻断，于是 npm 上 `latest` 一旦超过上界，所有新装用户就再也收不到壳更新。更荒唐的是我们自己 0.6.x 出厂的内核是 `0.2.2-rc.5`，而壳声明 `<0.2.2-rc.2`，**出厂组合自己"不支持"自己**，那批用户永远升不了壳。现在改为只警告（壳照装），并明确指出哪三族补丁（商城装卸 / exFAT 新建文件 / 附件）可能需要适配，装完看体检的 `patches` 一行即可。
- **上界写错成开区间**：`<0.2.2-rc.2` 把 `0.2.2-rc.2` 本身排除了，而 rc.2 正是我们已经适配并验证过的内核（也是很多用户的桌面版本）。改成 `<=0.2.2-rc.2`。

### 优化

- 区间语义在代码里写清楚了：`blockers`（装了会坏：schema 读不懂 / 更新器太老 / 跨版本太大 / 内核低于下界）与 `advisories`（装了不会坏，但补丁可能没适配：内核高于上界）分成两类，不再混在一个数组里。
- `check` 的输出在计划之前多一行"注意：…"，`--json` 里多一个 `advisories` 字段。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变。`requires.dsh` 的值从上界开区间改为闭区间（更宽松，不会挡下任何原本能装的组合）。

### 升级会做什么

- 替换清单里的壳文件（本次变更 4 个：`tools\shell-update.mjs`、`tools\shell-release.mjs`、`shell-version.json`、`RELEASE-NOTES.md`）。
- 只换壳，不动 app / desktop / 运行时，也不动你的数据和配置。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.6.4 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.6.5.zip` 整包覆盖壳文件（**先备份 `home\profiles`**，zip 里含出厂配置）。

### 已知待办（下一版）

- npm 上最新内核是 `0.2.2-rc.5`，我们只适配到 `0.2.2-rc.2`。`rc.3`/`rc.4`/`rc.5` 的三族补丁适配还没做，所以上界暂时停在 rc.2；在 rc.3+ 上装壳会看到上面那条"注意"，补丁可能失效。要真正跟上，需要逐版对锚点。

---
## v0.6.4 — 2026-11-27

两个真实用户模拟测出来的坑：升级入口的**结论行根本显示不出来**，以及**旧壳上双击后一片空白**。

### 新增

- 无。这是纯修复版本，`update.cmd` 的名字、参数、依赖面一律不变（它已冻结）。

### 修复

- **版本行不显示，反而在便携目录里生成垃圾文件**（用户模拟实测，稳定复现两次）：`--notice` 打印的是 `SHELL 0.6.2 -> 0.6.3`，而 `update.cmd` 用 `echo %LINE%` 输出——cmd 在展开变量**之前**就解析重定向符，于是 `>` 被当成写文件：屏幕上没有版本号，根目录多出一个名为 `0.6.3（3` 的文件。改用延迟展开（`echo !LINE!`），展开发生在解析之后，`>` 就只是普通字符。
- **旧壳上双击 update.cmd 是一片空白然后退出**（0.5.x/0.6.0/0.6.1 实测）：那些版本的 `tools\say.ps1` 没有 `update-shell-*` 文案键，遇到未知键**不报错、直接退出 0**，所以任何兜底都看不见。现在每次打印文案都会探测输出是否为空，为空就用纯 ASCII 兜底，老壳至少能读到"为什么没升"和"下一步做什么"。
- **失败提示不再只说"网络问题"**：检查失败可能有两个原因（网络不通 / 壳太旧读不了新清单）。现在会直接给出旧壳的两步升级指令：`node tools\shell-update.mjs apply --to 0.6.2 --force`，再双击 `update.cmd`。
- **整包 zip 兜底会重置用户配置，以前没人警告**：`harness-shell-*.zip` 里含 `home\profiles` 的出厂配置，直接覆盖会把用户改过的插件清单洗掉（用户模拟里用一行 marker 实测到）。现在所有提到整包兜底的文案都要求先备份 `home\profiles`。
- **`check-update.cmd` 会信任从调用者继承来的 `ROOT`**：别的 `.cmd` 都用 `set "ROOT=%~dp0"` 强制定位，只有它写 `if not defined ROOT`。结果是调用方环境里残留一个 `ROOT`（例如指向另一套安装），它就对**另一个安装**做检查、往那边写缓存。现在无条件用自身目录。

### 优化

- 升级询问的默认值从 Y 改成 **N**：stdin 被重定向时（脚本、计划任务）`choice` 会立刻取默认值而不是等 20 秒，默认 Y 等于"无人值守时静默自动升级"。
- 等桌面关闭的提示只打印一次（原来写在循环体内，会连刷 60 遍同一句话，实测时长 232 秒）。
- 超时文案从"3 分钟"改成"约 4 分钟"，与实测一致。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变、`requires.dsh` 不变。

### 升级会做什么

- 替换清单里的壳文件（本次变更 4 个：`update.cmd`、`check-update.cmd`、`tools\say.ps1`、`RELEASE-NOTES.md`）。
- 只换壳，不动 app / desktop / 运行时，也不动你的数据和配置。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.6.3 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.6.4.zip` 整包覆盖壳文件（**先备份 `home\profiles`**，zip 里含出厂配置）。

### 老用户必读（0.6.1 及更早）

你们的壳读不了带新文件的清单（旧白名单直接拒收整份清单），所以**没法一步跳到最新版**。请按顺序做一次，之后就能全自动：

1. `node tools\shell-update.mjs apply --to 0.6.2 --force` —— 先到 0.6.2（它的清单还是 63 个文件，旧读取器认得）
2. 双击 `update.cmd` —— 从 0.6.2 起自动升到最新

---

## v0.6.3 — 2026-11-27

`update.cmd` 正式上线，并补上一条机制性修复：新版可以给老用户发新文件了。

### 新增

- `update.cmd` 进入壳清单（第 64 个文件），从此随升级自动到达每一台机器——包括从 0.6.2 及以后版本升上来的机器。

### 修复

- **发一个新文件曾经等于掐断所有人的升级路**（本次发布前实测）：清单读取用的是同一份白名单，而读清单的是**已经装出去的旧版本**。旧版本看到清单里有它不认识的文件，就把整份清单判为非法（`whitelist-violation`），于是谁都升不了级。现在根目录下的壳脚本（`.cmd`/`.bat`/`.ps1`）不再要求逐个登记；`app/`、`desktop/`、`runtime/`、`home/` 以及显式禁止清单照样拒绝，安全边界没变。

### 优化

- 为了让这条修复真正到达用户，v0.6.2 先把"能容忍新文件的读取器"发出去、清单仍保持 63 个文件；v0.6.3 才把 `update.cmd` 加进清单。这就是升级器类改动的标准两步走：先让旧版本学会读，再发新东西。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变、`requires.dsh` 不变。

### 升级会做什么

- 新增 `update.cmd`，其余壳文件不变。只换壳，不动 app / desktop / 运行时和你的数据。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.6.2 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.6.3.zip` 整包覆盖壳文件。

---

## v0.6.2 — 2026-11-27

升级入口终于成型：双击 `update.cmd` 就能升级，不用敲任何命令。

### 新增

- **`update.cmd`：永久升级入口**。双击即用：先查有没有新版 → 一行结论 → 问一句 Y/n（20 秒不选就自动开始）→ 如果你还开着 DeepSeek 就提示你关掉并自动等待 → 换装 → 完成。**这个文件的内容从此冻结**：名字、行为、依赖都不再变，因为老版本只认它当初带的那个名字，改名或重写等于把所有老用户的升级路断掉。
- 换装过程现在**每个阶段都有输出**：正在检查更新（最多约 15 秒）/ 下载并校验壳文件（逐文件计数 + 累计 KB）/ 正在替换壳文件 / 正在对齐 pnpm 状态（最多 2 分钟）。以前这几步是静默的，慢一点就像卡死。

### 修复

- **升级入口是断的**（用户实测）：唯一带“要不要升级 Y/N”的文件是 `preflight.cmd`，但它没有被任何脚本调用——双击 `start-desktop.cmd` 走不到它，双击 `dsh-portable.cmd` 只跑体检，所以两条路都不会提示升级。现在升级收敛到一个专门入口 `update.cmd`。
- **提示文案指向不存在的东西**：v0.6.0 写的是“双击 dsh-portable.cmd，菜单里选 U”——可那个入口只打印体检结果，根本没有菜单。现在一律指向 `update.cmd`。
- **体检不再只报“有新版”**：`shell-upd` 显示可更新时，紧跟一行“升级方式：关掉 DeepSeek 后双击本目录的 update.cmd”，照着做就行。

### 优化

- 本地壳文件被你手改过（版本没变、只是文件不一致）时不再弹升级询问：那种情况算“修复”，不该显示 `x.y.z -> x.y.z` 去吓人。
- 检查更新的进度提示写到 stderr，`--json` 等机器可读输出完全不受影响。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变、`requires.dsh` 不变，`shell-update` 的命令行参数一个没改。

### 升级会做什么

- 替换清单里的壳文件（本次变更 6 个：新增 `update.cmd`，更新 `dsh-portable.ps1`、`tools\say.ps1`、`tools\shell-update.mjs`、`tools\shell-release.mjs`、`RELEASE-NOTES.md`）。
- 只换壳，不动 app / desktop / 运行时，也不动你的数据和配置。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.6.1 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.6.2.zip` 整包覆盖壳文件。

---

## v0.6.1 — 2026-11-27

体检不再卡住：`tmp` 堆到几十万文件时，`dsh-portable.cmd` 以前会空转好几分钟，看起来像死机。

### 新增

- 无。这是纯修复版本：只换体检读取残留的方式，命令、参数和输出格式都不变。

### 修复

- **`dsh-portable.cmd` 体检卡在 `login-bak` 之后不动**（实测事故）：统计"残留文件"时对整棵 `tmp` 做递归遍历。`tmp` 里会堆运行时目录、Office 转换临时目录、自测夹具，实测某台机器 84 万个文件——在 exFAT 上遍历一遍烧掉 85% CPU、3.9 分钟，用户看到的就是"半天不动"。现在只查真正会留下半成品的位置（两个更新日志、`app.next`/`desktop.next`、`cache\update\*.part`、三个目录**顶层**的散落临时文件），常数级开销：同一台机器从"跑不完"降到 **220 毫秒**。
- **残留计数会把截图临时文件也算进去**：Windows 的文件系统过滤器参数按 8.3 后缀匹配，`*.tmp` 会连 `xxx.tmp.png`（会话截图临时文件）一起算上，凭空多报几百个残留。改用标准通配符逐条比对。

### 优化

- 体检的残留统计对每个目录只遍历一次（原来 4 个模式各列一遍）。
- 本地测试套件 119 → 121 项（含"不许递归""不许用过滤器参数""深层子目录一律不算"三条断言，各做过反向验证）。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变、`requires.dsh` 不变。

### 升级会做什么

- 替换清单里的壳文件（本次只改 `dsh-portable.ps1` 一个文件，另加发布说明）。
- 只换壳，不动 app / desktop / 运行时，也不动你的数据和配置。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.6.0 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.6.1.zip` 整包覆盖壳文件。

---

## v0.6.0 — 2026-11-26

双击 `start-desktop.cmd` 也能收到壳更新提示了——习惯一直用这个入口的人，以前永远不知道壳发了新版。

### 新增

- **`start-desktop.cmd` 启动路径也提示壳更新**：只出一行（`SHELL 壳 0.5.1 -> 0.6.0 可用（N 个文件变更）`），不自动安装——壳换装会替换正在使用的文件，必须由你在菜单里显式选 U 才做。查到有更新时窗口停 5 秒，并告诉你怎么升。
- `shell-update.mjs check --notice`：新增"启动提示"模式，只输出一行结论，不打印文件清单和更新细则；被兼容性挡下时明说"挡下"。供启动脚本调用。
- 检查结果缓存 180 分钟：反复双击启动不会每次都走网络，也不会因为一时断网就反复报错。

### 修复

- **`env.cmd` 每次启动都刷三行英文 REM 帮助**：一行注释写成了 `rem ???/???`，cmd.exe 看到注释里的 "/"+"?" 组合会当成 `rem /?`，于是打印 "Records comments (remarks) in a batch file or CONFIG.SYS."。这是从首版就带的老毛病，每次启动都出现，只是没人当成问题报过。
- 该行注释同时改成有意义的说明（它守着"整份拷贝换了盘符要重新探测文件系统"这条判断）。
- **换壳后启动仍提示"内核出界"**：内核检查的 6 小时缓存只认内核版本，不认壳声明的适配区间。壳升级换了区间，内核版本没变，旧结论就被原样回放——刚换成支持新内核的壳，看到的还是"出界"。缓存现在同时认"适配区间 + 冻结状态"，区间变了立刻重查。
- **插件暂存自测会洗掉真实插件清单**（发布流程内部问题，普通使用碰不到）：`plugin-shared.mjs stage-selftest` 原本直接往当前目录的 `home\profiles\*.json` 写夹具（包名改成 selftest-web、依赖清空），不传 `--root` 就等于改真实清单。本版让自测自己先快照、跑完还原，并加了一条用例盯着「跑完真实清单必须原样」。
- **启动时多出一行 `The syntax of the command is incorrect.`**：判断内核提示类型时，变量在"内核检查什么都没输出"的情况下是空的，空值做子串展开会让 cmd 把整条 if 判为语法错误。这是本版新开出来的路径（旧版内核检查永远有话说，走不到），已用哨兵值兜住，并顺手保证"官方内核有更新就问 Y/N"这条判断不被带偏。

### 优化

- 启动路径的两类提示（壳 / 内核）共用同一个停留逻辑：有提示才停，没提示立刻继续，双击到桌面出现的手感不变。
- 本地测试套件 107 → 118 项（壳提示、缓存作废、启动路径语法安全三组，每条硬约束都做过反向验证：故意改坏必须变红）。
- 启动路径的壳检查用 4 秒单次超时（交互式检查仍用 10 秒两次）：网络抽风时宁可这次不提示，也不能把启动拖住——复测中真撞到过一次 91 秒的卡顿。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变、`requires.dsh` 不变。

### 升级会做什么

- 替换清单里的壳文件（本次变更 4 个：`check-update.cmd`、`env.cmd`、`tools\say.ps1`、`tools\shell-update.mjs`）。
- 只换壳，不动 app / desktop / 运行时，也不动你的数据和配置；换装前备份到 `cache\shell-backup-<时间戳>`。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.5.2 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.6.0.zip` 整包覆盖壳文件。

---

## v0.5.2 — 2026-11-26

让"内核比壳新"的提示真正能被看见：停在启动窗口 5 秒。

### 新增

- 无。

### 修复

- **内核更新提示一闪而过**：`start-desktop.cmd` 在启动桌面之前调 `check-update.cmd`，提示打印完不到 1 秒控制台就随启动关闭——内核出界那条 KERN 提示（含"升壳/冻结/维持现状"三条路）实际从没被人看到过（2026-11-26 用户反馈：十几天里一直以为没有更新提示）。现在这类提示会停 5 秒再继续。
- 停 5 秒用 `timeout`，在 stdin 被重定向（从别的脚本/终端拉起）时自动退化为 `ping -n 6` 等待，保证任何启动方式都能看到。

### 优化

- 冻结状态（`frozen.json`）不占用这 5 秒：那是你自己选定的稳定组合，每次启动都停反而烦；它照旧只打印一行。
- 顺带在官方 `0.2.2-rc.5` 上做了一次适配验证：四族补丁锚点、asar 版本解析、`dsh plugin` 用法、profile 清单结构全部成立，壳本身不需要为新内核改动。本版支持的区间仍是 `>=0.2.1-rc.5,<0.2.2-rc.2`（保持"内核不高于壳已验证的上限"这条纪律），所以升级内核的提示会继续出现——这次它停 5 秒，你能看见。

### 破坏性变更

- 无。

### 升级会做什么

- 替换清单里的壳文件（本次变更 2 个：`check-update.cmd`、`tools\say.ps1`）。
- 只换壳，不动 app / desktop / 运行时，也不动你的数据和配置。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.5.1 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.5.2.zip` 整包覆盖壳文件。

---

## v0.5.1 — 2026-11-12

补丁状态的退出码映射修复：官方换内置 pnpm 后，补丁失配不再被误报成"已打上"。

### 新增

- `patch-all --check --json` 新增状态 `env-blocked`（聚合退出码 5）：子进程根本没启动（受限会话/安全拦截）时不再伪装成"失败"，与真实锚点失配明确区分（此前表现为"4 个补丁全 failed 且 detail 为空"的伪红，2026-11-12 曾因此误诊）。

### 修复

- **pnpm 补丁失配被静默吞掉**：旧逻辑把退出码 2 一律当"已打上"，但 patch-pnpm 的 2 = "锚点失配（pnpm 可能改版）"。官方升级换内置 pnpm 后，商城装/卸插件会静默失败且无任何警告。现在 pnpm 的失配判为 needs-work，启动器的"补丁需要适配"提示能正常触发。
- 退出码 2 按模式门控：check 模式下的 2（attachment 半打状态）不再误报"已打"。
- `patch-all.mjs` 被测试导入时不再有副作用（执行体加 isMain 守卫；此前 import 会立刻跑补丁并退出进程）。

### 优化

- 无。

### 破坏性变更

- 无。`--json` 输出新增 `env-blocked` 状态值与聚合退出码 5；按 state 字符串过滤的消费方（doctor / verify / 启动器）不受影响。

### 升级会做什么

- 替换清单里的壳文件（本次变更 2 个：`tools\patch-all.mjs`、`shell-version.json`）。
- 三份 `pnpm-workspace.yaml` 不随壳走；换装前备份到 `cache\shell-backup-<时间戳>`。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.5.0 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.5.1.zip` 整包覆盖壳文件。

---

## v0.5.0 — 2026-11-12

双向兼容闸门：壳从此对官方内核的"太新"方向也有闸（调研报告见仓库 `doc/compat-report-2026-11-12.md`）。

### 新增

- **内核-壳适配闸门**：清单的 `requires.dsh` 升级为区间声明（本次 `>=0.2.1-rc.5,<0.2.2-rc.2`）——官方内核跃出区间时，启动提示不再诱导你按 Y 升级，改为给出三条路：升壳适配 / 冻结当前组合 / 显式改上界。
- `node tools\shell-update.mjs compat [--json] [--dsh <版本>]`：唯一的适配判定入口（本地清单、零网络），退出码 0=在区间内 / 3=出界。
- 冻结模式：壳根目录放 `frozen.json`（`{"dsh":"<版本>","reason":"..."}`）后内核更新提示静默；壳更新通道不受影响（升壳是解冻的正规通道）。
- `version.json` 的 `dshVersion` / `bundlesWeb` / `bundlesDesktop` / `desktopAsarBytes` 全部改为脚本自动算（发版 `clean-ship refresh` + 升级收尾自动刷新），不再人工维护。
- `preflight` 在源码目录（含 `.git`）运行时提醒：日常使用请用便携副本，避免改掉出厂默认。
- README「必须守住的不变式」从四条扩到六条（三层边界 + 元数据全自动）。

### 修复

- **app 更新检测失效**：`app\package.json` 是 pnpm 生成的（没有 version 字段），旧检测器读空后永远不提示 app 更新。现在回退到已装官方包（`app\node_modules\@deepseek-ai\dsh`）。
- **desktop 版本读歪**：0.2.2 起官方 asar 的 JSON 段带 3 字节对齐 padding，旧代码按 `16+jsonLen` 算数据起点直接读歪。现按 `8+headerSize` 规范解析（且只读头部，208MB 的 asar 从 107ms 降到 6ms）。
- **升完还提示升级**：更新检查缓存里记下"当时的本地版本"，升级成功后旧缓存自动作废重查，不再 6 小时内反复问同一句。
- desktop 版本回退链：`version.dsh` 是官方从不写的死文件，改为回退读 `DeepSeek Harness.exe` 的版本资源。

### 优化

- 版本区间语法：逗号与空格等价（`">=X,<Y"` ≡ `">=X <Y"`）；旧实现空格写法会把上界静默吞掉。
- 版本比较/区间判定抽到 `tools\version-range.mjs`（零依赖纯函数，测试可单独拷贝运行）。
- 本地测试套件 91 → 101 项（update-check 五个回归用例 + 快照刷新五个用例，均做过"破坏必须变红"的反向验证）。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变；`requires.dsh` 从单边改区间对老更新器透明（读到的还是字符串）。

### 升级会做什么

- 替换清单里的壳文件（63 个，本次变更 9 个：`check-update.cmd`、`shell-version.json`、`tools\clean-ship.mjs`、`tools\fix-pnpm-state.mjs`、`tools\preflight.mjs`、`tools\shell-update.mjs`、`tools\update-check.mjs`、`tools\verify-shell.mjs`、新增 `tools\version-range.mjs`；`README.md`/`RELEASE-NOTES.md`/`version.json` 属随包快照）。
- 换装收尾自动对齐 pnpm 状态并刷新 `version.json` 快照。
- 三份 `pnpm-workspace.yaml` 不随壳走、也不会被删；换装前备份到 `cache\shell-backup-<时间戳>`。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.4.3 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.5.0.zip` 整包覆盖壳文件。

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

第二个公开版本（产品名：**DSH-Portable-Kernel**）。这一版只做修复与硬化，没有破坏性变更。

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
---

## v0.2.1 — 2026-11-04

修 0.2.0 升级后"商城装不上插件"的问题：pnpm 的 store 被升级冲掉了。

### 新增

- 无（补丁版只修问题）。

### 修复

- **升级后商城装/卸插件报"store 不一致"**：`storeDir` / `packageImportMethod` 是机器配置，却写在随壳发布的 `home\profiles\*\pnpm-workspace.yaml` 里；升级把这些文件换回"干净版"后 pnpm 回落到 `$PNPM_HOME\store`，与 `node_modules\.modules.yaml` 记录的盘内 store 不一致，于是该 profile 的所有装/卸都被拒绝。现在这三份 yaml **不再随壳发布**，机器配置由 `tools\fix-pnpm-state.mjs` 每次启动生成。
- **升级后立刻对齐**：清单新增 `migrations`，换装成功后由已安装的升级器直接跑一次 `fix-pnpm-state`，**不用先重启**就能装插件。
- 同一原因丢失的 `packageImportMethod: copy` 一并恢复（exFAT 上没有它，pnpm 会去试硬链接）。

### 优化

- `verify` 新增「pnpm store 与 node_modules 记录一致」「store 一致性自测」（54 → 56 项）；新增 `tools\selftest-store.mjs`（10 个夹具：缺 storeDir、指向不同 store、记录带 `v11`、坏 `.modules.yaml` 等）。
- `doctor` 与门禁能从"记录 vs 解析"的角度发现这类问题，而不是等用户点安装才报错。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变；`home\` 下的插件清单、网关配置、会话、凭证一律不碰。

### 升级会做什么

- 替换清单里的壳文件；**不再覆盖**三份 `pnpm-workspace.yaml`（它们从此不随壳走）。
- 换装成功后自动跑一次 `fix-pnpm-state`（幂等、几十毫秒），把 store 配置对齐回当前机器。
- 换装前整份备份到 `cache\shell-backup-<时间戳>`；换完自动跑 `verify-shell` 的换装闸门，不通过整体回滚。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`（按最新备份整体还原，还原后同样跑 verify）。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.2.0 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.2.1.zip` 整包覆盖壳文件。
---

## v0.3.0 — 2026-11-04

修好"升级后还提示有更新"，并给商城历史一个能真正清干净的入口。

### 新增

- `dsh-portable.cmd market-history`：清空商城的操作历史（安装/卸载记录）。支持 `check`（只统计）、`-Force`（连 `log.ndjson` 一起清）、`node tools\market-history.mjs --root <别的实例>`；每个被改的文件先备份成 `.bak-<时间戳>`。
- `preflight` 头部信息块：产品名 / 壳版本 / 安装位置一屏可见，有更新时同一行提示；结尾新增 `结果：OK N · 注意 M · 问题 K` 计数。

### 修复

- **升级完成后 preflight 仍提示"0.2.0 -> 0.2.1"**：24 小时检查缓存没有绑定本地版本，升级后旧结论继续回放。现在缓存必须匹配当前安装版本才复用。
- **点 Y 后打印"清单已从 0.2.1 推进到 0.2.1"**：`apply` 在已是最新时仍走换装分支。现在直接输出"已是最新（版本），没有需要更新的文件"。
- **商城的"关闭此提示"关不掉历史**：界面只关当次显示，服务端没有删除入口，记录留在 `<profile>\.dsh-market\drain.ndjson`，重启又出现。现在用 `market-history` 清理（保留进行中的操作）。
- `preflight.cmd` 的退出码会被菜单选择（1..4）污染；现在只有真正启动 dsh 的分支带回退出码。
- `market-history --profile <非法值>` 以前静默什么都不做，现在明确报错并退出 2。

### 优化

- 更新提示改成要点式：每节最多 2 条 `·`，超出显示"… 还有 N 条（`shell-update notes` 看全部）"，不再用分号把一整节拼成一行。
- `preflight` 分区号统一成 `[01] … [11]`，去掉与头部重复的"位置"行；`[11]` 只留清单 tag 与 24 小时检查结论。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变，`home\` 下的数据一律不碰。

### 升级会做什么

- 替换清单里的壳文件；三份 `pnpm-workspace.yaml` 仍不随壳发布。
- 换装成功后自动跑一次 `fix-pnpm-state`（清单里的 `migrations`），把 store 配置对齐回当前机器。
- 换装前整份备份到 `cache\shell-backup-<时间戳>`，换完自动跑 `verify-shell` 的换装闸门，不通过整体回滚。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`（按最新备份整体还原，还原后同样跑 verify）。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.2.1 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.3.0.zip` 整包覆盖壳文件。

---

## v0.3.1 — 2026-11-04

修 0.3.0 的回归：升级会把三份 `pnpm-workspace.yaml` 当"清单已删文件"删掉，导致 pnpm store 漂移、装不上插件。

### 新增

- 无（补丁版只修问题）。

### 修复

- **0.3.0 升级会删掉 `home\profiles\{,\web,\desktop}\pnpm-workspace.yaml`**：升到 0.3.0 后 pnpm 回落到 `$PNPM_HOME\store`，与 `node_modules\.modules.yaml` 记录不一致，该 profile 的装/卸全部被拒绝；市场还会把插件装进 profile 自己的 `node_modules` 形成第二份副本。现在 `computeRemoved()` 的保护集包含"新清单 userOwned + 已安装清单 userOwned + 机器配置文件"，**绝不再删这三份 yaml**。
- **yaml 被删后不会自愈**：`fix-pnpm-state` 以前遇到缺失文件直接跳过；现在会**重建**（packages / nodeLinker / autoInstallPeers / modulesDir + storeDir + packageImportMethod 一次写全），启动器与升级迁移都会跑它。

### 优化

- 无。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变；`home\` 下的数据一律不碰。

### 升级会做什么

- 替换清单里的壳文件；**不会再删**三份 `pnpm-workspace.yaml`（0.3.0 删掉的会在升级后由 `fix-pnpm-state` 自动重建）。
- 换装成功后自动跑一次 `fix-pnpm-state`（清单里的 `migrations`），把 store 配置对齐回当前机器。
- 换装前整份备份到 `cache\shell-backup-<时间戳>`，换完自动跑 `verify-shell` 的换装闸门，不通过整体回滚。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`（按最新备份整体还原，还原后同样跑 verify）。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.3.0 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.3.1.zip` 整包覆盖壳文件。
---

## v0.3.2 — 2026-11-04

修 `plugin-shared sync --prune` 会误删"还有本地副本"的插件（丢 `@michengai/dsh-skills-manager` 的那次）。

### 新增

- 无（补丁版只修问题）。

### 修复

- **`sync --prune` 会删掉仍有本地副本的插件**：判定"悬空"以前只看共享目录，若某依赖的文件还在某个 profile 的 `node_modules` 里（历史遗留、或刚被手工搬动），会连依赖和 bundles 一起清掉。现在 prune 前先探每个 profile，仍有本地副本就**只提示不删**，并在真正删除前再兜一次底。
- `plugin-shared` 的用法说明漏了 `stage-selftest`（暂存引擎自测），补上。

### 优化

- 无。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变；`home\` 下的数据一律不碰。

### 升级会做什么

- 替换清单里的壳文件；三份 `pnpm-workspace.yaml` 不随壳走、也不会被删。
- 换装成功后自动跑一次 `fix-pnpm-state`（清单里的 `migrations`）。
- 换装前整份备份到 `cache\shell-backup-<时间戳>`，换完自动跑 `verify-shell` 的换装闸门，不通过整体回滚。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`（按最新备份整体还原，还原后同样跑 verify）。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.3.1 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.3.2.zip` 整包覆盖壳文件。
---

## v0.3.3 — 2026-11-04

修 preflight 把"上一版记下的更新"念给已升级用户的 bug。

### 新增

- 无（补丁版只修问题）。

### 修复

- **preflight 升级后仍显示"有可用更新：旧版本"**：`[11]` 与头部提示直接读 `tmp\shell-check.json`，只要里面写着"有更新"就照念，不看缓存属于哪个本地版本、也不比较远端是否真的更新。现在必须同时满足"24 小时内 + 缓存 local == 当前安装版本 + 远端严格更新"才提示（例如本地已 0.3.2 时，缓存里的 0.3.1 不再出现）。

### 优化

- 无。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变；`home\` 下的数据一律不碰。

### 升级会做什么

- 替换清单里的壳文件；三份 `pnpm-workspace.yaml` 不随壳走、也不会被删。
- 换装成功后自动跑一次 `fix-pnpm-state`（清单里的 `migrations`）。
- 换装前整份备份到 `cache\shell-backup-<时间戳>`，换完自动跑 `verify-shell` 的换装闸门，不通过整体回滚。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`（按最新备份整体还原，还原后同样跑 verify）。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.3.2 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.3.3.zip` 整包覆盖壳文件。
---

## v0.3.4 — 2026-11-05

把上一轮排查里发现的"静默失败"和"门禁盲区"补上，并加固发布流程。

### 新增

- `shell-update snooze --clear`：撤销"这次不更新"，让 preflight 立刻恢复更新提示（以前只能等 7 天）。
- `verify` 新增「各 profile 下没有本地 `node_modules`」（共享布局硬约束，57 项）：插件只能有一份共享副本，profile 下出现本地 `node_modules` 就报红。
- 本地 `test/` 套件扩到 **72 项**（新增换装引擎单测、健壮性、导入一致性 lint 等，不随壳发布）。

### 修复

- **`snooze --clear` 打印成功但文件还在**：`unlinkSync` 未 import，`ReferenceError` 被空的 `catch {}` 静默吞掉。已补 import，并加**导入一致性 lint**（静态比对 `tools/*.mjs` 里用到的内置函数是否 import/定义）。
- **`clean-ship refresh` 不幂等**：每次重写 `shipTime` / `generatedAt`，工作区永远脏、无法判断是否真有变化。现在内容未变时保留旧时间戳（连跑两次 diff 逐字节相同）。
- **`preflight` 升级失败静默回菜单**：`apply` 退出码非 0 时会打印失败原因（`cmd-failed` / `cmd-blocked`）并停住，不再让用户误以为已升级。
- **`preflight [11]` 把不同状态混成一句"没有新版本"**：现在按 `update-available` / `blocked` / `local-newer` / `up-to-date` / 缓存属于旧版本 / 还没检查过 / 状态未知 分别显示。
- **`doctor` 的 `shell-upd` 会念旧缓存**：改为"24h 内 + 缓存 local == 当前版本 + 远端确实更新"三条判据，与 `preflight` 一致。
- **`fix-pnpm-state` 两个问题**：① 会进 `.backup-*` 之类的点目录改 yaml（现在跳过）；② 没有 env.cmd 上下文时把 `packageImportMethod` 写成 `auto`（现在回退读 `tmp\fs-profile.cmd`，exFAT 上仍是 `copy`）。
- **`download.mjs` 无参时抛 `Failed to parse URL from undefined`**：补参数校验，打印用法并退出 2。

### 优化

- `clean-ship refresh` / `verify` 的幂等性可验证（连跑两次指纹一致），发布前更容易判断"这次到底改了什么"。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变；`home\` 下的数据一律不碰。

### 升级会做什么

- 替换清单里的壳文件；三份 `pnpm-workspace.yaml` 不随壳走、也不会被删。
- 换装成功后自动跑一次 `fix-pnpm-state`（清单里的 `migrations`）。
- 换装前整份备份到 `cache\shell-backup-<时间戳>`，换完自动跑 `verify-shell` 的换装闸门，不通过整体回滚。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`（按最新备份整体还原，还原后同样跑 verify）。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.3.3 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.3.4.zip` 整包覆盖壳文件。
---

## v0.4.0 — 2026-11-05

让附件在 exFAT 上原生可用（不再把数据写到 C 盘），并给"每次启动真查更新"与"备份只留 1 份"收尾。

### 新增

- **附件库补丁**：`@deepseek-ai/dsh-attachment-local` 发布附件时用硬链接，exFAT 不支持 → 图片附件全挂。现在 `patch-all` 的第四族 `attachment` 会把它的 `link()` 改成"失败回退 copy"（app 目录 + `app.asar` 两份），随启动/官方升级自动重打，**不再需要把附件目录指到 C 盘用户目录**。
- **`dsh-portable.cmd fix-attachment`**：撤掉 `cordis.patch.yml` 里旧的 `dshHome` 重定向，并把旧附件复制回 `home\attachments\v1`；`apply -Force` 再删旧目录。没有补丁时拒绝执行（退出码 4）。
- `tools\asar-lite.mjs`：通用 asar 单条目改写（偏移/integrity 重算、其它条目逐字节校验、原子换装与回滚），给后续补丁复用。
- `verify` 新增「附件库补丁」检查（57 → **58 项**）。

### 修复

- **preflight 不再拿缓存当结论**：启动时 `check --cached 0 --prompt --brief` 每次都真查；离线只打一行提示（4 秒 × 2 次超时），不会卡启动，也不会再出现"已升级还提示旧版本 / 新版本被旧缓存挡住"。
- **`[11]` 按状态如实显示**：有更新 / 被兼容性挡下 / 本地比远端新 / 已是最新（检查于 X）/ 缓存属于旧版本 / 还没检查过 / 同版本但本地有 N 处改动。
- **旧桌面/应用树的备份只留 1 份**（`desktop.bak-*` 每份约 1 GB、`app.bak-*` 约 0.5 GB），`tidy` 会一并回收；壳备份仍留 2 份。

### 优化

- `clean-ship refresh` 内容幂等（内容没变就不改 `shipTime` / `generatedAt`），发布前后 `git status` 不再被无谓弄脏。
- `download.mjs` 无参时给用法而不是 `Failed to parse URL from undefined`。
- 本地 `test` 套件扩到 **86 项**（新增 asar 改写单测、fix-attachment 场景、附件库补丁夹具等，不随壳发布）。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变；`home\` 下的数据一律不碰。附件会从 `C:\Users\<用户>\.dsh` 回到 `home\attachments\v1`（用 `fix-attachment` 一次性搬，原目录可保留）。

### 升级会做什么

- 替换清单里的壳文件（58 → 61 个：多了 3 个工具）。
- 换装成功后自动跑一次 `fix-pnpm-state`（清单里的 `migrations`），并让 `patch-all` 打上第四族 `attachment`。
- 若桌面窗口开着，`app.asar` 会被占用 → 该族标为 locked，**下次启动自动补**（启动器在起 dsh 之前跑 `patch-all`）。
- 换装前整份备份到 `cache\shell-backup-<时间戳>`，换完跑换装闸门，不通过整体回滚。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`（按最新备份整体还原，还原后同样跑 verify）。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.3.4 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.4.0.zip` 整包覆盖壳文件。
---

## v0.4.1 — 2026-11-05

修 `fix-attachment` 在真实附件布局下"搬回 0 个文件"的问题。

### 新增

- 无（补丁版只修问题）。

### 修复

- **`fix-attachment` 只处理平铺文件**：附件库真实布局是 `v1/objects/<两位>/<hash>` 嵌套目录 + `v1/tmp` 暂存，旧实现只复制顶层文件，于是"已复制 0 个"、`--purge-old` 也删不掉子目录。现在递归复制（跳过 `v1/tmp`）、递归删除旧根（带"必须以 `.../attachments/v1` 结尾"的安全断言）。
- 测试夹具同步改成嵌套布局：断言 `objects/aa/aaa`、`objects/bb/bbb` 被搬回，`tmp` 不搬，旧根删干净。

### 优化

- 实机验证：运行实例 0.3.4 → 0.4.0，221 个附件（53.4 MB）搬回 `home\attachments\v1`，C 盘旧根删除；重启后新发一张图片成功落到 `home\attachments\v1\objects\be\…`（内容寻址名与 SHA256 一致），`verify` 58/58。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变。

### 升级会做什么

- 替换清单里的壳文件（61 个）；三份 `pnpm-workspace.yaml` 不随壳走、也不会被删。
- 换装成功后自动跑 `fix-pnpm-state`；`patch-all` 在下次启动/升级收尾时保持四族补丁 applied。
- 换装前备份到 `cache\shell-backup-<时间戳>`，换完跑换装闸门。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.4.0 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.4.1.zip` 整包覆盖壳文件。
---

## v0.4.2 — 2026-11-05

修启动自检里的更新检查：超时误报 + [11] 展示不像"结论"。

### 新增

- 无（补丁版只修问题）。

### 修复

- **启动时误报"超时（4000ms）"**：`--brief` 单次超时从 4 秒放宽到 **10 秒 × 2 次**（GitHub 稍慢不再误判失败）；新增 `--quiet-fail`，失败不刷屏，改写 `tmp\shell-check.err.json`。
- **启动顺序不对**：以前"先自检、后查更新"，导致 `[11]` 永远显示上一次的结果；现在**先真查 → 再自检 → 有更新才问 Y/N**（Y/N 用刚写入的缓存回放，不二次联网）。
- **[11] 只有"清单 tag + 上次检查时间"**：改成"当前版本 / 最新版本 / 状态"三行；已是最新时不再重复同一个版本号，直接写"已是最新（远端 X，检查于 Y）"；检查失败时明说"本次检查失败：<原因>（X 前）；上次成功：Y"。

### 优化

- 本地测试套件 86 → 89 项（新增失败态显示、当前/最新版本行、`--quiet-fail`），并隔离测试之间的错误记录文件。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变。

### 升级会做什么

- 替换清单里的壳文件（61 个，本次变更 3 个：`preflight.cmd` / `tools\preflight.mjs` / `tools\shell-update.mjs`）。
- 三份 `pnpm-workspace.yaml` 不随壳走、也不会被删；换装后自动跑 `fix-pnpm-state`。
- 换装前备份到 `cache\shell-backup-<时间戳>`，换完跑换装闸门。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.4.1 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.4.2.zip` 整包覆盖壳文件。
---

## v0.4.3 — 2026-11-05

补上发布流程里缺失的"文本编码"闸门（0.4.2 提交信息曾出现乱码）。

### 新增

- `tools\check-text-encoding.mjs`：审计提交标题、tag 注释、已跟踪文本文件（`md/json/mjs/ps1/cmd`）是否有连续问号或 `U+FFFD`；默认只查最近 `v*` tag 之后（历史旧账用 `--all`）。
- `shell-release prepare` 的发布闸门新增 **text-encoding**（过不了不许打 tag）。

### 修复

- `tools\patch-attachment.mjs` 注释里的一个 `U+FFFD` 坏字符（之前写文件时留下的）。
- 发布 skill 的缺口：`hack3rx-software-ship` 增加 G6 文本编码闸门；`hack3rx-agent-lessons` R7 明确"提交信息文件必须 UTF-8、禁止 `Set-Content -Encoding ascii`"。

### 优化

- 本地测试套件 89 → 91 项（编码审计默认范围、`--all` 反向验证）。

### 破坏性变更

- 无。清单 schema 仍是 2、`updaterMin` 不变。

### 升级会做什么

- 替换清单里的壳文件（62 个，本次变更 4 个：`RELEASE-NOTES.md`、`tools\patch-attachment.mjs`、`tools\shell-release.mjs`、新增 `tools\check-text-encoding.mjs`）。
- 三份 `pnpm-workspace.yaml` 不随壳走、也不会被删；换装后自动跑 `fix-pnpm-state`。
- 换装前备份到 `cache\shell-backup-<时间戳>`，换完跑换装闸门。

### 如何回退

- 刚换完发现不对：`dsh-portable.cmd shell-update rollback`。
- 想退回上一版：`node tools\shell-update.mjs apply --to 0.4.2 --force`。
- 网页兜底：从 Release 页下载 `harness-shell-0.4.3.zip` 整包覆盖壳文件。