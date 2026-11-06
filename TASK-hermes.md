# 任务：实现 DSH 插件 `dsh-optimizer`（AI 优化大师）

一句话：把「体检这台机器的 AI 战斗力 → 出可执行的优化方案 → 经批准后落地且可回滚」做成一个
DeepSeek Harness 插件，同时能被 Codex CLI 和 Claude Code 用。

工作目录：`D:\uking编程\dsh-optimizer`（已建好，空目录，你负责 `git init`）

## -1. 当前进度（上一轮跑到一半断了，从这里接着做，别推倒重来）

盘上已有：`package.json`（结构 OK，不用改）、`lib/util.mjs`。

**`lib/util.mjs` 里有一个已经实测确认的 bug，第一件事就是修它：**

```
canonicalStringify({x:1,y:{b:2,a:3}}) === canonicalStringify({y:{a:3,b:2},x:1})   → true   ✅
sha256Hex({x:1,y:{b:2,a:3}})          === sha256Hex({y:{a:3,b:2},x:1})            → false  ❌
```

`sha256Hex` 对非字符串走的是 `JSON.stringify`，而不是旁边那个写好的 `canonicalStringify`。
后果：`planHash` 键序敏感 —— plan 重新序列化一次键序变了，`apply --expect <hash>` 就会误报
diverged（退出码 3），O5 判据形同虚设。**函数在、判据在、调用方不在。**

修法：`sha256Hex` 对非字符串一律走 `canonicalStringify`。
并补一条判据 **O10**：两个键序不同、语义相同的 plan 对象，`planHash` 必须相等；
改任何一个**值**则必须不等。这条判据必须能因为改回 `JSON.stringify` 而变红。

## 0. 参照物（先读，别自己发明）

- **骨架照抄**：`D:\uking编程\dsh-cost\`（package.json / index.js / lib / bin / mcp-server.mjs /
  .mcp.json / .codex-plugin/plugin.json / scripts/check.mjs / test/ / SECURITY.md / README 双语 / MIT）
  - `index.js` 必须具名导出 `name` / `inject` / `createDefinitions`，**禁止 `export default`**
  - package.json 里 `dsh.bundle.patch` 指向 `./cordis.patch.yml`，禁止 install 生命周期脚本
- **能力参照**：本机 `C:\Users\ZhuanZ\.uking\ukrt\ukrt.exe`（跑 `ukrt doctor --json` 看它体检哪些项、
  `ukrt --help` 看它的 fix/optimize/undo 分工）。**参照它的选题，不要包它的 exe。**

Node ≥ 22，ESM，零运行时依赖，MIT，跨平台（Windows 主场，但 macOS/Linux 上必须能装能跑）。

## 1. 三个动作，严格分开

### `scan` —— 只读体检
返回 findings 数组，每条：

```js
{
  id, title, severity: 'critical'|'high'|'medium'|'low'|'info',
  platform: 'win32'|'darwin'|'linux'|'all',
  applicable: boolean, notApplicableReason: string|null,
  verified: { method: 'ran'|'read-file'|'read-registry'|'path-only'|'none', evidence: string },
  current: any, recommended: any,
  remediation: { command: string, risk: 'low'|'medium'|'high',
                 requiresAdmin: boolean, reversible: boolean } | null
}
```

**探针清单**（每条都要有对应判据）：

| id | 查什么 | 为什么这项省 token |
|---|---|---|
| `harness.installed` | dsh / claude / codex / hermes 各自：在不在 PATH、`--version` 能不能真跑起来 | 基础事实 |
| `context.instruction-size` | 会被载入的每份 `CLAUDE.md` / `AGENTS.md`（全局 + 项目）的字节数和估算 token 数 | **这是最大头**：18KB 的项目 CLAUDE.md ≈ 9.2k token，每次会话都付 |
| `context.mcp-surface` | 已配置的 MCP server 数量 + 各自工具数 + 工具定义的估算 token | MCP 工具 schema 是常驻上下文成本 |
| `permissions.allowlist` | Claude settings 里允许清单条数 | 清单太少 → 反复审批 → 白烧回合 |
| `noise.npm` | npm 的 loglevel / fund / audit 配置 | 装包噪音直接进上下文 |
| `noise.powershell` | PowerShell profile banner、输出编码 | 同上 |
| `encoding.codepage` | Windows 活动代码页是否 65001 | 乱码 → 重试 → 双倍 token |
| `git.longpaths` / `git.quotepath` | `core.longpaths`、`core.quotepath` | 中文路径被转义 → 路径错 → 返工 |
| `squeeze.wired` | 有没有装 token 压缩机（rtk 或 dsh-squeeze）并接上 hook | 与姊妹插件 `dsh-squeeze` 交叉引用 |

跨平台降级：Windows 专属探针在 macOS/Linux 上返回 `applicable:false` + `notApplicableReason`，
**绝不能返回"通过"**。

### `plan` —— 把 findings 变成有序方案
每步带**预览**（改哪个文件/键、从什么值到什么值），带 risk，带 requiresAdmin。
整份方案算一个 `planHash`（内容 sha256）。**plan 不改任何东西。**

### `apply` —— 落地，且必须证明你读过方案
- 必须带 `--expect <planHash>`。不带 → 退出码 **4**（denied）。哈希对不上 → 退出码 **3**（diverged）。
  （这套退出码语义跟本仓库南桥/本境一致：0=成功 3=diverged 4=denied 1=用法错）
- 默认只执行 `risk:'low'`。`medium`/`high` 要显式 `--allow medium` / `--allow high`。
- `requiresAdmin` 的步骤在非管理员终端下**报 `blocked:'requires-admin'` 跳过**，不许静默失败也不许静默跳过。
- 每一步落地前把 **before 镜像**写进 journal（`$DSH_OPTIMIZER_HOME/journal/<planHash>.json`）。
- `undo --plan <planHash>` 按 journal 逐字节还原。

## 2. 必须存在的判据（`test/*.test.mjs`，`node --test`）

大部分是反向用例，代码里用注释标 id。

- **O1 scan 绝不写盘**：在沙箱 HOME 下跑完整 scan，比对沙箱内所有文件的 mtime+sha256，一个字节都不能变。
- **O2 「没跑」不等于「通过」**：`applicable:false` 的 finding 必须有 `notApplicableReason`，
  且 severity 只能是 `info`。构造一条 Windows 探针在 `process.platform='linux'` 下的用例验证。
- **O3 存在性 ≠ 验证**：`verified.method === 'path-only'` 的 finding，其结论文案和 `current`
  里**不许出现"可用/works/OK"**。构造一个假的、在 PATH 里但一跑就崩的可执行文件，
  断言它被报成 `path-only` 或 `ran` 失败，而不是"已安装可用"。
- **O4 apply 无 expect 必拒**：退出码 4，且盘上零改动。
- **O5 apply 哈希过期必拒**：改一个字节的 plan → 退出码 3，盘上零改动。
- **O6 journal 完备 + undo 逐字节还原**：apply 后每个已执行步骤都有 before 镜像；
  `undo` 之后目标文件 sha256 等于 apply 之前。
- **O7 admin 步骤不偷跑**：`requiresAdmin:true` 且非管理员时，结果里必须出现 `blocked:'requires-admin'`，
  且该步骤的 journal 条目不存在（没做就不许留"做过"的痕迹）。
- **O8 沙箱必须真隔离**：设了 `DSH_OPTIMIZER_HOME` 之后，所有读写都在沙箱内。
  写一条判据：在沙箱模式跑全套 apply/undo，断言真实 `C:\Users\ZhuanZ\.claude\`、`~/.npmrc`、
  git global config **一个字节都没变**。**这条判据不过，整个任务算失败**——
  测试污染用户真机是不可接受的。
- **O9 估算的 token 数必须带估算器标签**：`context.instruction-size` 报的 token 数要标明是
  `bytes/4` 这类估算，不能当成精确值。

## 3. 四个入口（同一个核心）

- **DSH 插件 `index.js`**：工具 `dsh_optimizer_scan`、`dsh_optimizer_plan`、`dsh_optimizer_apply`
- **CLI `bin/dsh-optimizer.mjs`**：`scan|plan|apply|undo`，`--json` 时 stdout 纯 JSON、人类文本走 stderr
- **MCP `mcp-server.mjs`**：**只暴露 `scan` 和 `plan`（只读），不暴露 `apply`。**
  让远端 MCP 调用方改本机环境是开后门。在 SECURITY.md 里明写这条边界和理由。
- **`.codex-plugin/plugin.json`**：照抄 dsh-cost 的字段结构

## 4. 验收（必须全绿）

```bash
cd D:\uking编程\dsh-optimizer
npm test
npm run check
npm run smoke:plugin
npm run smoke:mcp
node bin/dsh-optimizer.mjs scan --json          # 在真机上跑一次，看报告是否说人话
node bin/dsh-optimizer.mjs apply                # 必须退出码 4
```

把 O1~O10 每条的真实结果写进 `RESULT.md`，**没实现的写没实现**。
另外把 `scan --json` 在这台机器上的真实输出片段贴进 RESULT.md（脱敏：路径里的用户名替换成 `<user>`）。

## 5. 禁区

- ❌ 不要 `git push` / 不要发 npm / 不要建 GitHub repo
- ❌ **不要在非沙箱模式下跑 apply**（会改这台真机的配置）。测试一律 `DSH_OPTIMIZER_HOME=<临时目录>`。
- ❌ 不要碰注册表、不要动 Defender 排除项（ukrt 有这些能力，本插件 v0.1 一律不做，README 写明"不做"）
- ❌ 不要动任何已有仓库，只读
- ❌ 不要加 install 生命周期脚本
- ❌ 判据不许恒绿
- ✅ 本地 `git init` + commit 可以

## 6. 输出

- 代码 → `D:\uking编程\dsh-optimizer\`
- 自检报告 → `D:\uking编程\dsh-optimizer\RESULT.md`
- 需要人拍板的决策点 → RESULT.md 的「待人定夺」一节
