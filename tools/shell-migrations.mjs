/**
 * 清单里的 `migrations`：换装成功后由**已安装的**升级器（shell-apply）执行，不依赖新壳启动。
 *
 * 为什么需要：升级会替换壳文件，但 `home\profiles\*\pnpm-workspace.yaml` 里的机器配置
 * （storeDir / packageImportMethod）不随壳发布；从 0.2.0 升到 0.2.1 的实例里，那份 yaml 可能
 * 还停在被覆盖后的"干净版"，于是 pnpm 会漂到 `$PNPM_HOME/store`，与 `node_modules\.modules.yaml`
 * 记录不一致 → 商城装不上插件（2026-11-04 事故）。这条迁移在换装收尾立刻对齐一次，
 * 用户不必先重启、也不必手动 repair。
 *
 * 约束：`script` 必须是清单 files 里存在的 tools/*.mjs；必须幂等、快（几十毫秒）、失败不阻断。
 */
export const SHELL_MIGRATIONS = [
  { id: 'pnpm-store-dir', script: 'tools/fix-pnpm-state.mjs', args: ['--quiet'] },
]
