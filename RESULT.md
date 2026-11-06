# RESULT — dsh-optimizer v0.2（对 TASK-hermes.md 的逐条交代）

> 状态：**已实现并可跑**（不是设计稿）。验收命令：`npm test`（23 项全绿）、`npm run check`。
> 未实现项在下文「没做」一节明写，不假装完成。

## 1. 三个动作（任务书 §1）

| 要求 | 实现 | 说明 |
|---|---|---|
| `scan` 只读 | ✅ `lib/scan.mjs` | 不 import 任何写接口；O1 用全树快照证明零写盘 |
| `findings` 字段形状 | ✅ | `id/title/severity/platform/applicable/notApplicableReason/verified/current/recommended/remediation` 全带 |
| `plan` 有序方案 + 预览 + risk + planHash | ✅ `lib/apply.mjs` | 每步含 `from→to` 预览、risk、requiresAdmin、reversible、evidence |
| `apply` 必须 `--expect` | ✅ | 无 expect → 退出码 4；哈希过期 → 退出码 3 |
| 默认只执行 low | ✅ | 单副本 skill 判 `medium`，默认跳过（有测试证明） |
| `requiresAdmin` 不偷跑 | ✅ | 非管理员 → `blocked:'requires-admin'`，且**不写 journal 条目**（O7） |
| journal 写 before 镜像 | ✅ | `$DSH_OPTIMIZER_HOME/journal/<planHash>.json` |
| `undo` 逐字节还原 | ✅ | 按 journal 逆序；O6 证明 SHA-256 回原值 |

## 2. 判据（任务书 §2）

| 判据 | 状态 | 测试位置 |
|---|---|---|
| O1 scan 绝不写盘 | ✅ | `test/core.test.mjs` 全树快照 before/after |
| O2 没跑 ≠ 通过 | ✅ | 不可读根 → `applicable:false` + reason + `info` |
| O3 存在性 ≠ 验证 | ✅ | 真可执行但 `exit 7` → `tool.unusable`，文案不含"可用" |
| O4 apply 无 expect 必拒 | ✅ | 退出码 4 + 盘上零改动 |
| O5 哈希过期必拒 | ✅ | 改一字节 plan → 退出码 3 |
| O6 journal 完备 + undo 还原 | ✅ | 还原后 SHA-256 与 apply 前一致 |
| O7 admin 步骤不偷跑 | ✅ | `blocked` 且 journal 步骤数 0 |
| O8 沙箱真隔离 | ✅ | `DSH_OPTIMIZER_HOME` 下跑完整 plan/apply/undo；假 HOME 的 `.npmrc`、未选中的 skill 逐字节不变 |
| O9 估算带标签 | ✅ | `contextEstimate.estimator === 'bytes/4'` |
| O10 planHash 键序无关、值敏感 | ✅ | 重排键 → 同哈希；改值 → 不同哈希 |

额外补的判据：

- 同名重复必须区分 `identical-copies` / `diverged-copies`（不合并结论）
- `undo` 遇到 apply 后被改过的文件 → `conflict`，**不覆盖**
- `verifyPlanHash` 能发现 plan body 被篡改
- CLI 退出码（4 / 3）真实可测
- MCP 面只有 `optimizer_scan` / `optimizer_plan`，`optimizer_apply` 调用必失败

## 3. 四个入口（任务书 §3）

| 入口 | 状态 | 备注 |
|---|---|---|
| DSH 插件 `index.js` | ✅ 源码完成 | `name` / `inject` / `createDefinitions` 具名导出，无 default export；**运行时加载未验证**（本 checkout 没装 `@deepseek-ai/dsh-tools`），`test/plugin-smoke.mjs` 明确标注为静态检查 |
| CLI `bin/dsh-optimizer.mjs` | ✅ 实测 | `scan/plan/apply/undo`，`--json` 时 stdout 纯 JSON |
| MCP `mcp-server.mjs` | ✅ 实测 | 只读：initialize / tools/list / tools/call(scan,plan) |
| `.codex-plugin/plugin.json` | ✅ | 依 dsh-cost 字段结构 |

## 4. 真机证据（脱敏）

在本机（macOS）跑 `node bin/dsh-optimizer.mjs scan`：

```
DeepSeek Harness             131 skills
Agent Skills (cross-tool)      9 skills
Claude Code                   36 skills
Codex CLI                     35 skills
OpenClaw / ClawX               9 skills
Cursor                        44 skills
U-King                        16 skills

Findings: 8 info · 2 medium
  [medium] 8 skill name(s) exist with different content across roots
  [medium] 47 skill(s) reference local files that do not exist
Duplicates: 37 (identical 29)
MCP declarations: claude=1 codex=5 cursor=1
```

真实 plan（只生成、未执行）：

```
Plan 00dd54e3a793e91188962a4e29e5aa4ba383e0aa91763a104b3482caa5a75fe8
  [low] archive-skill:claude:cloudflare-domain
        ~/.claude/skills/cloudflare-domain -> ~/.dsh-optimizer/archive/claude__cloudflare-domain
```

`plan` 不写盘；`apply` 未运行。

## 5. 没做（诚实清单）

- **MCP 自动卸载/修改**：v0.2 只读。会审结论是「超时不能证明服务已死」，所以不给卸载动作。
- **Node/Git/PowerShell 自动升级**：只报版本与建议。会审指出「PATH 里有」≠「目标工具实际在用」。
- **skill 去重自动决策**：只报告，不自动判定哪份该删。
- **软链接 / junction 分发模式**：未实现（会审建议先做受管副本，链接等验证后再上）。
- **动态探测（启动 MCP、执行 skill 脚本）**：未实现，单独授权话题。
- **Windows 14 工具树的默认根**：不猜盘符，通过 `DSH_OPTIMIZER_ROOTS` 显式声明。
- **插件运行时加载验证**：需要 `@deepseek-ai/dsh-tools` 安装后才能做，当前仅静态检查。
- **`git push` / `npm publish` / 建仓**：任务书禁区，未执行。

## 6. 与旧原型的关系

- 旧 `lib/util.mjs` 的已知 bug 已修：`sha256Hex` 对非字符串改走 `canonicalStringify`，
  O10 可因改回 `JSON.stringify` 而变红。
- 旧原型只有 3 个文件；本版新增 `scan/apply/CLI/MCP/测试/文档`。
- Windows 侧 `D:\uking编程\dsh-optimizer` 仍是旧状态（1 commit），本 Mac 目录成为当前真相源，
  合并方向需要人拍板（见「待人定夺」）。

## 6.5 v0.2 代码会审后修复（std，6 模型）

会审发现并已修的缺陷：

| 缺陷 | 修法 | 回归测试 |
|---|---|---|
| 未知 risk/allow 绕过门禁（`undefined > 0 === false`） | `validatePlan` 白名单校验，未知值退出 1 | review: invalid allow / bad-risk |
| journal 只在最后落盘，中途失败无可恢复记录 | 先写 intent，再每步重写 | review: partial failure still journaled |
| undo 不检查原路径是否被重新占用 | `target-occupied` 冲突，不覆盖 | undo reports conflict |
| 只哈希 SKILL.md，非入口文件变化漏检 | 整目录 manifest（路径/类型/哈希/链接目标） | O6、review: tampered archive |
| archive 目标可能与旧归档合并 | 独占创建，已存在则 `archive-target-exists` | review: existing archive target |
| `isInside` 前缀检查挡不住符号链接逃逸 | `realpath` + 拒绝 symlink 源 | review: symlinked skill / outside roots |
| 归档复制与删除之间无校验 | staging + 复制校验 + 删除前复核源 manifest | O6 |

仍未消除的边界：并发写入窗口只能收窄、不能消除（见 SECURITY.md）。

## 7. 待人定夺

1. **仓库挂哪**：GitHub `ai-optimize-master` 现内容只有 `alarm.pod`，与本产品无关。是改名/换仓，
   还是新建 `dsh-optimizer`？
2. **是否合并 Windows 旧提交**（851ced1）再推。
3. **是否发 npm**：`dsh-optimizer` 在 npm 上不存在；发布需要 OTP 与明确授权。
4. **是否把本核心接进 U-King**（U-King 已有 ukrt/macopt 执行器，建议只共享资产模型与哈希门禁，不重写执行器）。
