# dsh-optimizer · AI 工具越装越多，也能查清来源、审阅变更、恢复配置

> 给同时装了 Claude Code、Codex、Cursor、DSH、OpenClaw、Hermes 的人：
> 你的 skill 被复制了几份？哪些指向了不存在的脚本？MCP 配了几处？
> 这一版只做一件事：**先把事实查清，再用可回滚的方式收干净。**

[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 它是什么

一个 **DSH 插件 + CLI + 只读 MCP**，共用一套治理核心：

| 动作 | 做什么 | 会不会改你的盘 |
|---|---|---|
| `scan` | 盘点每个 AI 工具的 skill 根、重复定义、断链引用、MCP 声明、工具版本 | **绝不写** |
| `plan` | 把选中的 skill 变成一份带风险的方案，算出 `planHash` | 不改 |
| `apply` | 只执行低风险归档，必须出示 `planHash`，每步写 journal | 只移动，可撤销 |
| `undo` | 按 journal 逆序还原 | 有改动就报冲突，不覆盖 |

## 三个真实场景

1. **一台 Windows 工作站装了 14 个 AI 工具，每个都有 28 个 skill**——约 392 份副本。
   `scan` 会把「同名同内容」和「同名不同内容」分开报，不合并结论。
2. **某个 skill 让 AI 去读 `scripts/run.mjs`，但那个文件早就没了**——`scan` 报
   `skills.broken-references`，并列出缺哪个文件。
3. **清理完发现某个工具不能用了**——`undo` 从 journal 还原，遇到你后来改过的文件
   会报冲突而不是覆盖。

## 第一次使用（三步）

```bash
# 1. 只读体检（不会改动任何东西）
npx dsh-optimizer scan

# 2. 出一份方案（先看再决定）
npx dsh-optimizer plan --select <skill名> --out plan.json

# 3. 拿着方案哈希执行；没有哈希会被拒绝（退出码 4）
npx dsh-optimizer apply --plan plan.json --expect <planHash>
```

安装到 DSH 作为插件：

```bash
# 插件清单在 .codex-plugin/plugin.json，MCP 面只读（scan/plan）
node mcp-server.mjs    # stdio MCP，只有两个只读工具
```

## 它证明过什么

本仓库的验收不靠自述，靠 `npm test` 的 16 条判据：

| 判据 | 防的是什么 |
|---|---|
| O1 scan 全程零写盘 | 「检查一下」把机器改了 |
| O2 没跑 ≠ 通过 | 读不到的目录被当成干净 |
| O3 存在 ≠ 可用 | PATH 里有、一跑就崩，却被报成已安装 |
| O4 无 `--expect` 必拒 | 没读方案就执行 |
| O5 哈希过期必拒 | 方案被改过仍照跑 |
| O6 journal 完备 + 逐字节还原 | 删了回不去 |
| O7 管理员步骤不偷跑 | 没做却留下「做过」的痕迹 |
| O8 沙箱隔离 | 测试污染真机 |
| O9 估算必须带标签 | 把 `bytes/4` 当精确 token 数 |
| O10 planHash 键序无关、值敏感 | 同一方案哈希漂移 |

```bash
npm test        # 16 项
npm run check   # 结构 + 只读边界 + MCP 不暴露 apply
```

## 开始前你可能想知道

- **它会删东西吗？** 不删。`apply` 只把目录移动到 `$DSH_OPTIMIZER_HOME/archive/`。
- **它会改我的 MCP 配置吗？** 不会。v0.2 的 MCP 面只读，只报声明数量与条目名。
- **它会帮我升级 Node / PowerShell 吗？** 不会。版本只做建议，不做自动升级。
- **重复的 skill 能直接删吗？** 不能直接下结论。同名同内容只说明是重复定义，
  不说明哪份没人用。方案里单副本 skill 是 `medium` 风险，默认不执行。
- **Mac 和 Windows 都能跑吗？** 核心是跨平台的；Windows 上多出的工具根目录用
  `DSH_OPTIMIZER_ROOTS` 显式声明，不猜盘符。
- **免费吗？** MIT。没有账号、没有网络请求。

## 本页依据

- 源码：本仓库 `main`
- 验收：`npm test`（16 项）与 `npm run check`
- 安全边界：`SECURITY.md`
- 最后核对：2026-11-06

## 支持矩阵

| 能力 | Windows | macOS | Linux |
|---|---|---|---|
| skill 根盘点 / 重复 / 断链 | ✅ | ✅ | ✅ |
| MCP 声明只读盘点 | ✅ | ✅ | ✅ |
| 工具版本探测（node/git/pwsh/claude/codex） | ✅ | ✅ | ✅ |
| 可回滚归档 | ✅ | ✅ | ✅ |
| 版本升级 / MCP 自动卸载 | ❌ 仅建议 | ❌ 仅建议 | ❌ 仅建议 |
| 动态启动 MCP / 执行 skill 脚本 | ❌ 不做 | ❌ 不做 | ❌ 不做 |

## 和 U-King「AI 优化大师」的关系

同一个方向，两个入口，**共享同一套治理语义**（资产模型、方案、哈希门禁、journal、
退出码）。U-King 侧已有环境体检与一键优化（可回滚）；本仓库负责跨工具资产盘点与
清理。两边不互相重写执行器。
