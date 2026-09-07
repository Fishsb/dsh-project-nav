# project-nav 项目交接文档

> **创建日期**：2026-09-07  
> **工作目录**：`D:\FF\project-nav`  
> **关联工作区**：`D:\FF`（四项目治理文档：`PROJECT.md` + `modules/` + `.internal/nav-index.json`）

---

## 一、项目定位

### 一句话
project-nav 是 DSH 插件，为开发过程提供**双向映射导航**——任何文件改动都能追溯到它影响的功能和模块，任何功能都能展开到它涉及的文件。

### 解决什么问题
- 开发过程中「这个文件改动会影响什么」靠猜
- 新功能上线后文档没跟上，久而久之 PROJECT.md 沦为摆设
- AI agent 开发时缺乏项目全局视角，容易偏离主线

### 与现有治理体系的关系

```
project-map-governance (pmg)     project-nav (本插件)
         ↓                              ↓
    地图准不准（守门）          方向对不对（导航）
    文件是否存在                  功能是做什么
    tree 是否漂移                 改动该不该现在做
         ↓                              ↓
    共享 docs/map/root/*.md ←──→ 共享 .internal/nav-index.json
```

**原则**：不融合，数据互通，各守边界。

---

## 二、架构概览

```
┌─────────────────────────────────────────────────────────┐
│  DSH Harness (runtime)                                  │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ host/index.js — 插件入口 + 6 个 DSH 工具注册     │   │
│  │                                                 │   │
│  │  nav_query     双向映射查询（文件↔功能↔模块）    │   │
│  │  nav_update    同步功能/模块描述                 │   │
│  │  nav_add_feature 注册新功能                      │   │
│  │  nav_status    覆盖率 + 健康度                   │   │
│  │  nav_set_vector 更新主线向量                     │   │
│  └──────────────────────┬──────────────────────────┘   │
│                         │ 调用                          │
│  ┌──────────────────────▼──────────────────────────┐   │
│  │ shared/index.js — 核心层                        │   │
│  │                                                 │   │
│  │  loadIndex() / saveIndex()    ← ↔ nav-index.json│   │
│  │  loadVector() / saveVector()  ← ↔ vector.json   │   │
│  │  queryIndex(target)           ← 核心查询算法     │   │
│  └──────────────────────┬──────────────────────────┘   │
│                         │                               │
│  ┌──────────────────────▼──────────────────────────┐   │
│  │ .internal/ — 持久化数据                         │   │
│  │  nav-index.json  四维交叉索引                   │   │
│  │  vector.json     主线向量                       │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ client/index.js — UI 面板（侧边栏）             │   │
│  │  查询输入 + 结果展示 + 主线向量显示             │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 三、数据结构

### 3.1 nav-index.json（四维交叉索引）

```jsonc
{
  "indexes": {
    "fileToFeature": {
      "deepseek/prompt-enhancer-release/src/host/app.js": ["PE-F01"]
    },
    "featureToFiles": {
      "PE-F01": ["deepseek/prompt-enhancer-release/src/host/app.js", "..."]
    },
    "moduleToFeatures": {
      "prompt-enhancer": ["PE-F01", "PE-F02", "..."],
      "pmg": ["PMG-P01", "..."]
    },
    "projectToModules": {
      "prompt-enhancer": ["host", "client", "voice", "components"],
      "pmg": ["engine", "lib", "scripts"]
    },
    "functionToModule": {
      "deepseek/prompt-enhancer-release/src/host/app.js": ["host"]
    }
  },
  "descriptions": {        // nav_add_feature / nav_update 写入
    "PE-F01": {
      "name": "安装插件",
      "userView": "用户在 DSH 面板安装",
      "systemView": "bundle 装配 → 工具注册",
      "createdAt": "2026-09-07T00:00:00Z"
    }
  },
  "metadata": {
    "totalFiles": 33,
    "totalFeatures": 18,
    "totalModules": 14,
    "coverage": "partial"
  }
}
```

### 3.2 vector.json（主线向量）

```jsonc
{
  "doing": "project-nav plugin development — skeleton and 6 tools",
  "next": "build, inject, and test full workflow",
  "notDoing": "project-map-governance fusion, shoucang reactivation",
  "exitCondition": "plugin injects successfully, query/update/status tools work end-to-end",
  "updatedAt": "2026-09-07T00:00:00Z"
}
```

---

## 四、6 个工具详解

### 4.1 nav_query — 双向映射查询

**输入**：文件路径 或 功能编号  
**输出**：四维映射结果

```bash
# 文件 → 功能
nav_query -t "deepseek/prompt-enhancer-release/src/host/app.js"
# 输出：Features: PE-F01 / Modules: host / Projects: prompt-enhancer

# 功能 → 文件
nav_query -t "PE-F04"
# 输出：voice/mic-button.js, recorder.js, voice-section.js

# JSON 格式（给程序调用）
nav_query -t "PE-F04" -f json

# 自动对照主线向量
# 如果改动不在 doing/next 范围 → 输出 ⚠ 警告
```

**核心算法**（`shared/index.js → queryIndex()`）：
1. 判断目标类型：功能编号（正则 `/^[A-Z]{2,}-[FPSD]\d+$/`）vs 文件路径
2. 功能→文件：直接查 `featureToFiles` 表
3. 文件→功能：直接查 `fileToFeature` 表（路径归一化 `\` → `/`）
4. 反查模块：遍历 `moduleToFeatures` 找包含该功能的模块
5. 反查项目：遍历 `projectToModules` 找包含该模块的项目

### 4.2 nav_update — 同步描述

```bash
# 更新功能描述
nav_update -f "PE-F03" --field "systemView" -v "调 LLM 改写 → 结果插回 composer + 支持快捷键"

# 更新模块元数据
nav_update -f "prompt-enhancer" --field "status" -v "v3.4.0 开发中"
```

### 4.3 nav_add_feature — 注册新功能

```bash
nav_add_feature \
  -c "PE-F07" \
  -n "快捷键触发增强" \
  -u "用户按下 Ctrl+Shift+E" \
  -s "监听快捷键 → 调增强流程 → 插入 composer" \
  --files "src/host/enhance-handlers.js,src/client/components/enhance-button.js"
```

**幂等**：code 已存在时拒绝，提示用 `nav_update`。

### 4.4 nav_status — 健康度快照

```bash
nav_status
# 输出：
# Project Nav Status
# Root: D:\FF
# Coverage: partial
# Totals: 18 features, 33 files, 14 modules, 4 projects
# Unmapped files: 0
# Stale entries: 0
# Mainline Vector:
#   Doing: project-nav plugin development
#   Next: build, inject, and test full workflow
```

### 4.5 nav_set_vector — 更新主线向量

```bash
nav_set_vector -d "端到端测试" -n "发布 v0.1.0" -x "融合 pmg" -e "全部工具通过测试"
```

### 4.6 nav_add_module — 预留（尚未实现）

计划用于动态注册新模块到 `moduleToFeatures` 和 `projectToModules`。

---

## 五、文件结构

```
D:\FF\project-nav/
├── package.json                  # 依赖 + 脚本 + DSH bundle 配置
├── host/
│   ├── index.js                  # 插件入口：Service 注册 + 6 个 command
│   └── cordis.patch.yml          # DSH 装配配置
├── shared/
│   ├── index.js                  # 核心：loadIndex/saveIndex/queryIndex
│   └── tools/
│       ├── query.js              # nav_query 实现
│       ├── update.js             # nav_update 实现
│       ├── add-feature.js        # nav_add_feature 实现
│       ├── status.js             # nav_status 实现
│       └── set-vector.js         # nav_set_vector 实现
├── client/
│   └── index.js                  # UI 面板（侧边栏 + 状态栏）
├── scripts/
│   └── build.sh                  # 构建脚本
├── .internal/
│   └── vector.json               # 当前主线向量
└── .gitignore
```

---

## 六、开发纪律（AGENTS.md 已写入 D:\FF）

1. **开工前**：先读 `D:\FF\PROJECT.md`，确认改动属于哪个功能
2. **改动中**：判断影响范围（用户可见？技术契约？跨模块？）
3. **改动后**：
   - 影响用户行为 → 更新功能清单「系统做什么」
   - 影响技术约定 → 更新模块清单接口/依赖
   - 新增功能/模块 → `nav_add_feature` 注册
4. **阶段切换** → `nav_set_vector` 更新主线向量

---

## 七、当前进度

### 已完成
- [x] 目录结构 + package.json
- [x] host/index.js — 6 个工具注册
- [x] shared/index.js — 核心读写 + queryIndex 算法
- [x] 5 个工具实现（query / update / add-feature / status / set-vector）
- [x] client/index.js — UI 面板骨架
- [x] build.sh 构建脚本
- [x] .internal/vector.json 初始主线向量

### 待做
- [ ] `npm install` 安装依赖
- [ ] `bash scripts/build.sh` 构建
- [ ] `dev_inject_plugin D:\FF\project-nav` 注入
- [ ] 端到端测试 6 个工具
- [ ] client 面板样式 + 交互完善
- [ ] `nav_add_module` 工具实现
- [ ] 与 pmg check 联动（pmg 查结构，nav 查功能）
- [ ] 自动扫描 → 自动补充索引（从 PROJECT.md 反向生成 nav-index.json）

---

## 八、关键决策记录

| 日期 | 决策 | 理由 |
|------|------|------|
| 2026-09-07 | 不融合 pmg，独立插件 | 地图治理 ≠ 导航引导，融合会让 check 语义分裂 |
| 2026-09-07 | 数据互通：共享 root/*.md | pmg 产出结构骨架，nav 填充功能血肉 |
| 2026-09-07 | 文件级为主 + 关键函数级为辅 | 全覆盖函数级维护成本指数爆炸 |
| 2026-09-07 | 主线向量独立一节 | 地图是静态的，向量是动态的，混在一起会互相污染 |

---

## 九、下一步可直接执行

```powershell
# 进入项目目录
cd D:\FF\project-nav

# 1. 安装依赖
npm install

# 2. 构建（host/shared → dist/）
bash scripts/build.sh

# 3. 注入 DSH（免重启）
dev_inject_plugin D:\FF\project-nav

# 4. 测试
nav_query -t "PE-F01"
nav_query -t "deepseek/prompt-enhancer-release/src/host/app.js"
nav_status
```

---

## 十、常见疑问

**Q: 为什么不直接让 AI 读 PROJECT.md，还要做插件？**  
A: 文档是静态的，插件是可调用的。nav_query 返回结构化结果，AI 能做判断（"这个改动不在主线内，是否继续？"）；PROJECT.md 只能给 AI 做阅读理解，且上下文有限。

**Q: 索引和 PROJECT.md 会不同步吗？**  
A: 会。PROJECT.md 是给人类读的，nav-index.json 是给机器查的。两者通过 AGENTS.md 的纪律绑定——改动 PROJECT.md 时同步更新索引。未来可以加自动扫描兜底。

**Q: vector.json 和 PROJECT.md 的主线向量重复吗？**  
A: 内容重复，但用途不同。PROJECT.md 的向量是给人类和 AI 共同阅读的；vector.json 是给插件工具读取的（nav_query 时自动对照检查）。一份读的，一份查的。

---

## 十一、2026-09-07 晚 · 卸载事故调查报告（必读，修复前先看）

> **状态**：插件已从 web profile 卸载（源码保留本目录未动），dsh-web 已恢复。
> **症状**：插件挂载后，所有含工具调用的回合立刻崩：`turn/end error "Cannot read properties of undefined (reading 'prepare')"`；纯文本回合正常。

### 根因（证据链完整）

1. **双模块实例冲突**：dsh 核心运行时（agent-loop / ToolRuntime 服务）用 `C:\Users\lk\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-tools`（实例 A）；插件通过 `import { defineTool } from '@deepseek-ai/dsh-tools'` 注册工具时，解析到了**另一份物理拷贝**（实例 B）。`TOOL_RUNTIME_SCHEDULER` 是 `Symbol(...)`（非 `Symbol.for`），两个实例的 Symbol 互不相认 → agent-loop 用实例 A 的 Symbol 在 tools 服务上取调度器得 `undefined` → `.prepare` 崩。
2. **污染路径**：2026-09-07 19:16 左右，project-nav 以 link 依赖装入 profile 时，pnpm 把它的 peerDependencies（`dsh-tools` / `cordis` / `dsh-llm` / `dsh-client-locale`）解析成了**指向插件自己 node_modules 拷贝的符号链接**，写进 profile 顶层 `~/.dsh/profiles/web/node_modules/@deepseek-ai/`。此后 free-search 等所有经 profile 解析的插件也全被带偏。对照：官方插件 dsh-free-search 的 dsh-tools 是 peerDependency、**本地不带拷贝**。
3. **时间线**：17:31 工具调用正常（pwsh 成功）→ 19:16 污染链接建立 → 20:00 起所有工具回合崩（会话 journal 可查：turn 3 completed / turn 4-5 error）。

### 已执行的清理（2026-09-07 晚）

- profile `package.json`：已移除 `@dsh-external/project-nav` 的 dependencies 与 bundles 条目（备份 `package.json.bak-uninstall-project-nav-20260907`）。
- profile `node_modules/@dsh-external/project-nav` 链接：已删。
- profile 顶层 `@deepseek-ai/{dsh-tools,cordis,dsh-llm,dsh-client-locale}`：已从「指向本插件拷贝的 symlink」改为 **junction → dsh 核心安装副本**（单实例恢复）。
- 本插件 `node_modules/@deepseek-ai/` 下的 4 份依赖拷贝：改名保留为 `*.local-bak-20260907`，原位换成 junction → 核心副本。
- dsh-web 已重启验证：3080 正常、token 303 通过。

### 重新上架前的修复清单（对照官方 free-search 模式）

1. **删除本插件 node_modules 里的整套 dsh 闭包拷贝**（`.local-bak-20260907` 目录可顺手清掉），`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 等一律走 peerDependencies，由宿主 profile 解析——插件源码目录不应有 `node_modules/@deepseek-ai/`。
2. `package.json` 的 peerDependencies 已写对（保持）；**不要在插件目录内 `npm install` 产出自包含闭包**。
3. 重装走官方通道：`dsh plugin --profile web add D:\FF\project-nav`（或 pnpm add 后核对 profile 顶层 `@deepseek-ai/*` 链接没有指回本插件目录）。
4. 装完先验证：① `dsh --profile web --dump-config` 无报错；② 发一条触发工具调用的消息（如让 agent 跑 `pwsh`），回合正常结束；③ 工具清单里 nav_* 出现且 `pwsh` 等原生工具不崩。
5. 补丁文件格式注意：`host/cordis.patch.yml` 必须是**顶层 YAML 数组**（`- insert: [{id, name}]`），自创 `host:/client:` 映射格式会 fail-loud 拒启（当晚已修）。

---

## 十二、2026-09-07 深夜 · 重装方案复核（对照 DSH 官方文档，待执行）

> **依据**：① 官方文档 `deepseek-ai/deepseek-harness@master` `docs/user/develop/basic/`（第一个插件）与 `docs/user/develop/practice/`（能力三角色）；② 本机 dsh 0.1.2-rc.1 加载器源码（`cordis-plugin-loader` 用标准 ESM `import()`，**无 @deepseek-ai 重定向钩子**——单实例全靠物理拓扑保证）；③ 官方 free-search 0.4.24 的 package.json 形态；④ 本机正常工作的 `dsh-motion`（link: 形态，但其 host 侧不 import dsh-tools，故未踩 Symbol 雷）。

### 复核发现（当前状态）

| # | 项 | 状态 | 风险 |
|---|----|------|------|
| 1 | profile 顶层去污染 | ✅ 4 链接 junction→核心副本，lock 无残留 | 无 |
| 2 | 插件本地 node_modules | ❌ **190+ 个 dsh-* 物理拷贝整包仍在**（19:05 npm install 产物），仅 4 包换 junction、4 包 .local-bak | **高**：重装即复发 |
| 3 | peerDeps 裸名 `schemastery` | ❌ 代码实际 import `@deepseek-ai/schemastery`，声明与使用不符 | 中 |
| 4 | peerDeps 4 个未使用的包（client-locale/runtime/llm/cordis） | ❌ 代码零 import | **当晚污染的直接放大器** |
| 5 | `types: ./shared/types.d.ts` | ❌ 文件不存在 | 低 |
| 6 | 无 `exports` 字段 | ⚠ 对照 free-search/dsh-motion 均有 | 低 |
| 7 | dist/ 双轨 | ⚠ main 指 host/ 源码，dist 无人引用 | 低 |
| 8 | host/cordis.patch.yml | ✅ 顶层数组，符合官方格式 | 无 |

### 关键机制结论

free-search（registry 形态）之所以安全：其 peer `@deepseek-ai/dsh-tools` 被 pnpm 复用解析到 profile 顶层链接 → junction → **dsh 核心安装副本**，全进程单实例。**凡 import dsh-tools 的工具插件（defineTool 的 Symbol 调度器），dsh-tools 必须与核心同物理实例**；link: 形态 + 本地物理拷贝 = 事故形态。

### 重装执行方案（推荐 A 路线，B 为回退）

**A（主推）：tgz 包形式** —— profile 中已有成功先例（dsh-super-injector 即 file:.tgz）：
1. 修正 package.json（见下）后，在插件目录 `pnpm pack` 出 tgz（files 只含 host/shared/package.json，体积小）。
2. `dsh plugin --profile web add <tgz绝对路径>`。pnpm 解包入 profile store，peer dsh-tools 复用顶层 junction→core。
3. **装入后核对**：profile 顶层 `@deepseek-ai/*` 链接仍指核心副本、未被 pnpm 改写成 store 拷贝（若被改写，重新指回 junction）。

**B（回退）：link: 源码直连** —— 仅当需要改码即生效时用；插件本地 node_modules 只保留手工 junction（dsh-tools → 核心副本），且每次 `npm install` 后必须复查 junction 未被覆盖。

**package.json 修正清单（A/B 共用前置）**：
- `dependencies` 增加 `"@deepseek-ai/schemastery": "^3.18.1"`（对齐 free-search）；删除裸名 `schemastery` peer。
- `peerDependencies` 裁剪到仅 `"@deepseek-ai/dsh-tools": ">=0.0.1-rc <2"`（4 个未用 peer 全删——少一个 peer 就少一条污染路径）。
- 删除 `types` 字段（或补文件）；增加 `exports`；`files` 去掉空 `assets`。

**通用清理（执行前需确认）**：
- 删除插件目录整个 `node_modules/`（190+ 拷贝 + 4 个 .local-bak，均可由 npm install 重建，且是事故源头）。
- 删除 `dist/`（双轨冗余，build.mjs 可重建）。

**装入后四步验证**（同第十一节）：`--dump-config` 无报错 → 触发工具调用回合正常结束 → nav_* 出现且 pwsh 不崩 → 真实调用一次 `nav_status`。

---

## 十三、2026-09-07 深夜 · 架构与方向审查（源码级，结合官方文档）

> **审查范围**：host/index.js、shared/index.js、shared/tools/*（5 个实现）、build.mjs、package.json，对照官方 `docs/user/develop/basic`（插件契约）与 `practice`（三角色设计）。

### 13.1 设计初衷与方向判定：成立，但价值重心需调整

- **定位成立**：机器可查的双向映射 + 主线向量，补 PROJECT.md 静态文档之不足；与 pmg「不融合、数据互通」边界清晰。
- **官方形态吻合**：本插件是纯 Consumer（只 `inject: ['tools']`），简单工具插件无需拆包——符合官方「不要预防性拆分」。patch 格式、工具 DSL（parameters/output.render）均与官方一致。
- **方向再锚定（lk 明确，2026-09-07）**：本插件是**项目开发过程中 agent 自己维护治理的工具**——索引的读者和写者都是 agent。工作循环 = 开工前 `nav_status`/`nav_set_vector` 定主线 → 改动前 `nav_query` 查影响面并对照主线 → 改动后 `nav_add_feature`/`nav_update` 自登记 → 阶段切换更新向量。由此推论：① 写路径必须完整（agent 写不进去的表就是死数据）→ nav_add_module、files 更新、metadata 自动重算升为必要件；② 「不在主线 → ⚠ 警告」从卖点升级为**核心机制**——agent 是唯一读者，这个警告就是插件的治理手段；③ 数据可靠性（原子写/损坏不清空）权重更高——高频 agent 写入下，静默清空等于让 agent 毁掉自己的地图；④ nav_scan 降级为「存量项目的一次性引导」辅助，不再是第一优先级。

### 13.2 架构问题清单（按严重度排序）

| # | 严重度 | 问题 | 位置 | 说明 |
|---|--------|------|------|------|
| 1 | 🔴 高 | **host 内联复制了整个 shared 层** | host/index.js:11 注释自认 "duplicated ... to avoid import resolution issues" | 相对路径 import（`'../shared/index.js'`）不存在解析问题，那条注释只对裸包名成立。复制已产生漂移：见 #2 |
| 2 | 🔴 高 | **复制漂移 bug：路径归一化写错** | host/index.js:68 `target.replace(/\\/g, '')` | 把 `\` 全删而不是换成 `/`（shared 版本是对的）。Windows 反斜杠路径查询永远 miss。这是复制架构的必然代价 |
| 3 | 🔴 高 | **损坏即清空的数据丢失路径** | host/index.js:19-21 | 索引 JSON 损坏时 loadIndex 静默返回空索引；下一次任何写操作就把真索引覆盖成空的。应 fail-loud 或拒绝写入 |
| 4 | 🟡 中 | **vector 读写不闭环（双层 bug）** | host/index.js:147-149, 312-319 | ① vector 来自启动时的 Config 快照，`nav_set_vector` 写 vector.json 但**没有任何代码读它**——重启后回退到 config 值；② 同一会话内 set_vector 后内存 `vector` 变量不更新，后续 nav_query 显示旧向量 |
| 5 | 🟡 中 | **HANDOFF §4.1 承诺的「不在主线内 → ⚠ 警告」未实现** | host/index.js:173 | result.vector 赋值后无任何比对逻辑，formatTextResult 只打印 |
| 6 | 🟡 中 | **写入非原子 + 不建目录** | host/index.js:45-50 | writeFileSync 直写（崩溃可截断 JSON）；`.internal` 不存在时 saveIndex 直接 ENOENT 崩。官方有 dsh-atomic-write 先例：临时文件 + rename + mkdirSync(recursive) |
| 7 | 🟡 中 | **config.root 默认 process.cwd()** | host/index.js:137 | web profile 是常驻守护，cwd ≠ 用户意图的 D:\FF。应显式默认或跟随会话 workspace |
| 8 | 🟠 低 | metadata 统计不完整 | add_feature | 只更新 featureToFiles/fileToFeature 计数，modules/projects 表无工具可维护，coverage 硬编码 'partial' |
| 9 | 🟠 低 | nav_update 不能改文件清单 | update 实现 | feature 的 files 只能在 add_feature 时定死 |
| 10 | 🟠 低 | 杂项 | — | test 脚本指向不存在的 test/；`autoReload` 配置项无实现；client 面板仅存在于 ARCHITECTURE 图（实际无代码）；dist/ 双轨无人引用 |

### 13.3 梳理方案（三档，建议按序执行）

**P0 — 修正确性（重装前置，1 次提交）**
1. 去重：host/index.js 删掉内联复制，改 `import { ... } from '../shared/index.js'`；shared/tools/* 四个实现文件目前是死代码（host 没引用），决定去留——建议保留但让 host 复用，或直接删除。
2. 修 #3/#6：loadIndex 解析失败 → 抛错（工具返回明确错误）；save 前置 `mkdirSync(recursive)` + 临时文件 rename 原子写。
3. 修 #4：vector.json 为唯一事实源——apply 启动 loadVector(root)，nav_set_vector 更新内存 + 写盘，nav_query/nav_status 均读内存态；Config 删掉 vector 段。
4. 修 #2 随 #1 自动消除。
5. package.json 修正（见第十二节清单）。

**P1 — 补全 agent 自治理闭环（重装验证通过后；agent 是唯一读者/写者，写路径完整性优先）**
6. 实现 #5：nav_query 命中结果与 vector.doing/next 比对，不在主线 → 输出 ⚠ 提示（agent 的治理开关）。
7. 写路径补全：nav_add_module 落地 + nav_update 支持 files 字段更新文件清单 + metadata 全量自动重算（agent 写哪张表都要能落盘）。
8. AGENTS.md 纪律条款与工具对齐：把「开工三查 / 收工两更」写成 D:\FF\AGENTS.md 的强制节拍（查 status/query → 改 → add/update + set_vector），让自维护有章可循。
9. nav_scan 半自动引导（降级项）：仅用于给存量项目（D:\FF 四项目）做一次性索引种子，之后以 agent 自维护为准。

**P2 — 视需要**
9. client 面板：先不做（官方：不要预防性拆分）。将来做时按 dsh-motion 的 `dsh.client.inject` 约定走。
10. 去掉 dist 双轨与 build.mjs（或改为仅 client 打包时启用）。

---

## 十四、设计核心定稿：防漂移治理循环（lk 明确，2026-09-07）

> **核心命题**：本插件的存在意义 = **保证项目开发不出错、不漂移**。agent 在处理任何涉及项目改动的任务前，必须先依据本插件的结构/模块信息理解指令的影响范围；执行上遵循「治理先行」的事务节拍。

### 14.1 治理循环（每次改动的标准节拍）

```
① 理解范围   用户指令 → nav_query（按文件/功能/模块展开影响面）+ nav_status（主线对照）
② 制定方案   基于治理信息产出改动方案（动哪些 feature / 哪些文件、是否在主线上）
③ 治理先行   nav_plan 登记动作（scope + plan 入账，状态 planned）——先改治理账本，再动代码
④ 标记开工   nav_mark begin（in_progress）
⑤ 实际执行   改代码
⑥ 标记完结   nav_mark done（done）→ 索引若受影响（新增文件/功能）顺手 nav_update
```

**防漂移的三个闸门**：
- **范围闸**：nav_query 发现目标文件/功能不在任何 open 动作的 scope 内、且存在未完结动作 → ⚠ 提示「先 nav_plan 或完结手头动作」。
- **主线闸**：nav_plan 时方案 scope 与 vector.notDoing 冲突 → 拒绝登记（exitCondition/next 供 agent 自查）。
- **完结闸**：nav_status 常显 open 动作清单——没 done 的动作就是漂移信号。

### 14.2 数据模型：动作账本 `.internal/nav-actions.json`

```jsonc
{
  "version": "1.0",
  "actions": [
    {
      "id": "ACT-001",
      "task": "一句话任务描述",
      "plan": "改动方案要点（基于治理信息制定）",
      "scope": { "features": ["PE-F07"], "modules": ["voice"], "files": ["src/..."] },
      "status": "planned | in_progress | done | aborted",
      "createdAt": "...", "startedAt": "...", "completedAt": "..."
    }
  ]
}
```

账本独立于 nav-index.json（静态地图 vs 动态动作，沿用「不混装」原则）。追加式历史，保留 aborted，供事后复盘漂移。

### 14.3 工具集调整（合计 8 个）

| 工具 | 状态 | 说明 |
|------|------|------|
| nav_query / nav_update / nav_add_feature / nav_status / nav_set_vector | 已有 | nav_query 增加「open 动作范围闸」输出；nav_status 增加 open 动作清单 |
| **nav_plan** | **新增（设计核心）** | 登记动作：task + plan + scope；主线闸校验；返回 ACT-id |
| **nav_mark** | **新增** | begin / done / abort 三态流转；done 时提示索引同步 |
| nav_add_module | 待做（P1） | 补全写路径 |

### 14.4 执行顺序（合并为一次安装）

P0 正确性修复 + 第十四节动作账本/新工具 **一并实现 → 清理 node_modules/dist → tgz 重装 → 四步验证**（验证用例增加：nav_plan → nav_mark begin → 触发改动 → nav_mark done 全流程）。

### 14.5 执行记录（2026-09-07 21:16–21:25，已完成）

| 步骤 | 结果 |
|------|------|
| 重写 shared/index.js（唯一事实源：fail-loud + 原子写 + 动作账本 + metadata 自动重算） | ✅ |
| 重写 host/index.js（8 工具：query/plan/mark/update/add_feature/add_module/status/set_vector；范围闸/主线闸/完结闸全部落地） | ✅ |
| package.json 修正（peer 裁到仅 dsh-tools；schemastery 转 dependencies；补 exports；删 types/双轨） | ✅ v0.2.0 |
| 清理：删 node_modules（190+ 拷贝）、dist、scripts、shared/tools、空 assets | ✅ |
| 语法检查 node --check ×2 | ✅ |
| pnpm pack（tgz 含 host/index.js、shared/index.js、package.json、cordis.patch.yml） | ✅ |
| `dsh plugin --profile web add <tgz>` 官方通道安装（6.7s，supply-chain 校验通过） | ✅ |
| **关键核对：顶层 @deepseek-ai/* 4 链接未被 pnpm 改写，仍 junction → 核心副本；插件无本地 node_modules，import 沿 profile 顶层解析到核心实例（单实例成立）** | ✅ |
| profile package.json：deps + bundles 均含 @dsh-external/project-nav | ✅ |
| `--dump-config` 无报错，patch 层正常挂载 | ✅ |
| dsh-web 重启，3080 监听，token 303 通过 | ✅ |

**待用户 UI 实测**：① 发一条触发工具调用的消息（回合正常结束、pwsh 不崩）；② nav_status 出现在工具清单且能执行；③ 治理循环全流程：nav_plan → nav_mark begin → 改动 → nav_mark done。
**新访问地址**：`http://127.0.0.1:3080/?token=<redacted>`

---

## 十五、2026-09-07 21:45 · v0.2.1 参考文档库（与治理地图同级）

> **lk 需求**：插件内置「项目文档参考」，作用与治理地图同级——方案确认时参考。用户把参考文档放到约定位置，插件知道在哪、登记了哪些、**什么任务该参考哪些文档**；agent 自己检索阅读。

### 设计

- **存放约定**：`D:\FF\refs\<项目>\`（用户自由放 md/pdf/链接清单；也接受任意绝对路径与 URL——登记时 path 是显式的）。
- **登记库**：`.internal/nav-docs.json`，条目 `{id: DOC-xxx, title, path, when, project, tags, addedAt}`。**`when` 是路由规则**——描述「哪类任务需要查这份文档」的关键词短语，是方案确认时匹配的依据。
- **工具 +2（合计 10 个）**：
  - `nav_add_doc`：登记文档（查重按 path）。
  - `nav_docs`：列全库 / 按 project、tag 过滤 / 按任务描述排序推荐。
- **方案确认挂载**：`nav_plan` 登记动作后自动输出「Reference docs to consult」——按 task 文本 + scope modules 与 `when`/tags/项目匹配打分，Top 5；agent 必须先读这些文档再 begin。
- `nav_status` 显示登记数量。

### 执行记录

- shared/index.js +loadDocs/saveDocs/nextDocId/suggestDocs（打分匹配纯函数）；host +2 工具、nav_plan 挂建议、nav_status 加计数；语法检查过。
- 首批种子 3 条已直写 `nav-docs.json`（DSH 基础文档 / 三角色实战 / HANDOFF），refs 目录 + README 已建。
- v0.2.1 打包重装。**踩坑**：旧 tgz 删除后 profile 里的 0.2.0 file: 依赖 ENOENT——用别名语法 `add "@dsh-external/project-nav@file:<新tgz>"` 覆盖，**不要先 remove 再 add**。装入后核对：0.2.1 在位、dsh-tools junction→核心未变、dump-config 通过、dsh-web 重启 3080 + token 303。
- 新 token：`http://127.0.0.1:3080/?token=<redacted>`

### 版本核实与 pin 修正（v0.2.2，2026-09-07 21:52）

- **核实**：dsh CLI 本机 0.1.2-rc.1 = 官方 npm `latest`/`next` 最新稳定版（更新线仅 0.1.3-alpha.2 预发布）；核心内带 dsh-tools = **0.1.2-rc.1**（非旧 peerDeps 写的 0.1.0-rc.6）。
- **修正**：peer pin 由 0.1.0-rc.6 → **0.1.2-rc.1**，v0.2.2 重装核对通过。
- `pnpm peers check` 中本项目仅以「与其他插件范围不一致」列出，peer 实际满足；警告组其余为其他插件历史遗留（auto-memory 缺 @deepseek-ai/cordis、session-archive/auto-continue 缺 react），与本项目无关。
- 新 token：`http://127.0.0.1:3080/?token=<redacted>`

### 版本错位审查（v0.2.3，2026-09-07 21:58）

8 项核对全过：安装副本与源码 diff 一致、profile 依赖指向 0.2.3、pin=core=0.1.2-rc.1、dsh 官方 latest 无待升、`.internal` 数据形态与新代码兼容（旧索引键为正斜杠、moduleMeta 已有）、单实例拓扑 4 链接完好、tgz 无残留、nav-actions.json 缺失时自动建空账本（设计内）。修复一个潜在 TypeError：`nav_update` 的 moduleMeta/descriptions 分支加缺字段兜底（防手工编辑/更老索引）。
最新 token：`http://127.0.0.1:3080/?token=<redacted>`

---

## 十六、2026-09-07 23:30 · v0.2.4 nav_map 可视化 + 数据真身归位

> **lk 需求**：治理地图的表现形式优化（渐进展开思维导图 vs 说明文档 vs 逻辑图）。检索结论（C4 模型 / Aider repo-map / markmap）：双受众分层——agent 保持结构化查询（已是正确形态），人侧补**渐进展开思维导图**，从索引自动生成、永不手工维护。

### 新增（纯增量，0 改动既有路径）

- **工具 `nav_map`（第 11 个）**：`format=text` → 缩进树（项目→模块→功能→文件，open 动作标注）；`format=html` → 自包含离线 HTML 思维导图写入 `.internal/map-*.html`（`<details>` 渐进展开、🔴 标红 open 动作、vector 头部摘要、无 CDN 依赖）。
- shared 新增纯函数：buildTree / renderTreeText / renderMapHtml。

### 重要修正：数据真身归位（两份索引错位）

发现 `D:\FF\.internal\`（运营真身：prompt-enhancer/shoucang/pmg/dsh-dev-docs）与插件仓 `project-nav\.internal\`（PN 自治理 + nav-docs + vector）**分裂**。运行时插件只读工作区那份 → PN 数据和文档种子插件看不见。已修正为**单一事实源 = `D:\FF\.internal\`**：PN 数据已合并（现 5 项目/9 模块/20 功能/35 文件）、nav-docs.json 与 vector.json 已迁移、插件仓旧数据归档至 `.internal-bak-20260907/`。地图 HTML 一律生成到 `D:\FF\.internal\`。

### 顺带暴露的漂移信号（留给 dsh agent 实战验证）

PN 存量映射仍引用已删除的 `shared/tools/*.js` —— 正好让 agent 用 `nav_update --field files` 修，作为治理循环的第一次实战。

### 执行记录

v0.2.4 打包重装、dsh-web 重启 3080 + token 303 通过；合并后全工作区文本树/HTML 渲染本地验证通过。最新 token：`http://127.0.0.1:3080/?token=<redacted>`

---

## 十七、2026-09-07 23:47 · v0.2.5 文档自动对齐（Once-Only 落地）

> **lk 原则**：尽量减少维护难度，维护一份核心文档，其他自动对齐。先检索理论/开源再动手（lk 要求）。

### 检索结论（支撑设计）

- **理论**：Once-Only/SSOT（docs-as-code 基石）+ Marker 模式（doctoc `<!-- toc -->` 先例）+ Agents/Humans DRY RFC（signpost 而非 copy）。
- **开源**：Cline Memory Bank（稳定→易变分层；反模式=文件互相矛盾/高频污染低频）；**OpenSpec（23.7k★，与本项目几乎同构**：specs/=索引、changes/=动作账本、propose→apply→archive ≈ plan→begin/done→同步）；GitHub Spec Kit（63k★，SDD 主流化验证）。

### 新增

- **工具 `nav_sync_docs`（第 12 个）**：从索引重新生成 PROJECT.md 的 `<!-- nav:auto:start/end -->` 标记区（功能地图+主线向量，bullet 式），标记外手写内容零触碰；原子写。
- **nav_mark done 升级 delta 收口**（对齐 OpenSpec archive 语义）：done 时自动对比 scope 与索引，列出「未登记功能 / 索引外文件」缺口清单，修完才叫同步完成。

### 首次对齐结果与遗留数据卫生问题

PROJECT.md 146→226 行（手写区未动）。暴露三处数据卫生问题（漂移信号实战素材，留给 dsh agent）：① 4 个存量项目模块下 0 功能；② PN 编号跨模块重复（PN-F01 同时挂在 M01/M02）；③ stale 引用 shared/tools/*.js。

### 执行记录

v0.2.5 打包重装（12 工具）、dsh-web 重启 3080+token 303、本地跑通首次对齐。最新 token：`http://127.0.0.1:3080/?token=<redacted>`

---

## 十八、2026-09-07 23:57 · v0.2.6 逻辑循环关键点审查 + 四项修复

> **lk 要求**：审查插件各逻辑循环的关键点。6 条循环（治理事务/索引写入/向量/文档对齐/地图渲染/动作账本）逐条过，发现 1 结构性缺口 + 3 闸门缺陷，已全部修复。

### 修复清单

| # | 严重度 | 问题 | 修复 |
|---|--------|------|------|
| F1 | 🔴 | **孤儿功能不可见**：nav_add_feature 不挂模块 → buildTree 只沿 模块→功能 链渲染，未挂模块的功能在地图/PROJECT.md 自动区完全隐身（治理盲区） | buildTree 返回 orphanFeatures；三渲染器（文本树/HTML/文档自动区）末尾追加「⚠️ orphan features」区并提示 nav_add_module 挂载；add_feature 成功回复加挂模块引导 |
| F2 | 🟡 | 「单 in_progress」纪律与工具不对齐：AGENTS.md 铁律禁止，nav_plan 只警告不拒绝 | nav_plan 遇 in_progress 直接 ERROR 拒绝 |
| F3 | 🟡 | 范围闸 targetInScope 双向 endsWith 过宽：scope 登记 `index.js` 会匹配全仓任何 index.js（误放行） | 改为：精确相等，或目标在 scope 目录下（scope 含 `/` 时前缀匹配），裸文件名只精确匹配 |
| F4 | 🟡 | 主线闸误报噪音：拿功能编号去 doing/next 文本找子串，人写主线不含编号 → 每次功能查询必告警，噪音会让 agent 学会忽略闸门 | 只用模块名匹配；纯功能编号查询不触发主线闸（范围闸仍覆盖） |

### 审查确认健康的部分

索引写入（fail-loud/原子写/双向一致/metadata 重算）、向量循环（现读不缓存）、文档对齐（marker 自愈/原子写/手写区隔离）、动作账本（ID 单调/状态机封闭/损坏 fail-loud）、HTML 全字段转义。杂项接受：tmp 固定名（单进程）、nav_sync_docs path 参数自由（agent 自用）。

### 执行记录

v0.2.6 打包重装、dsh-web 重启 3080+token 303、孤儿功能渲染本地验证通过（当前数据无孤儿，机制就绪）。最新 token：`http://127.0.0.1:3080/?token=<redacted>`

_本文件应随项目推进持续更新。最后更新：2026-09-07_

## 十九、2026-09-08 00:25 · v0.2.7 功能循环链闭环审查 + 四项修复（B1–B4）

### 审查结论
| 循环链 | 状态 |
|--------|------|
| 治理事务链 plan→begin→done→delta | ✅ 闭环（v0.2.6 单 in_progress 强制） |
| 写路径 feature/module/doc | ⚠ B2/B3 破口（见下） |
| 向量链 set_vector→plan 门禁 | ✅ 闭环 |
| 状态链 status→drift 信号 | ❌ B1 破口：staleEntries/unmappedFiles 是死字段，磁盘漂移不可见 |
| 计划链 plan→scope 校验 | ⚠ B4 弱闭环：scope 不与 index 对照，指错目标无感知 |

### 修复内容
- **B1**：shared 新增 `findStaleFiles(index, rootPath)`（经 projectPaths 解析各项目目录，existsSync 逐一探测 feature 文件）；nav_status 接入，输出 STALE Files 段（探测失败不阻塞 status）。
- **B2**：nav_add_module 挂载前检测该模块是否已挂在其他项目下 → 返回双挂载警告（不阻塞，保持透明）。
- **B3**：nav_add_doc 本地路径 existsSync 校验，不存在则拒绝注册（死链比没有更糟——plan 时路由会把 agent 指向不存在的文件）；http(s) URL 放行。
- **B4**：nav_plan 注册时将 scope 与 index 对照，未命中项输出"不在索引内"提示（新建合法 / 改存量则标识可能错，引导 nav_query 复核）。
- 前置：nav-index.json 注入 `projectPaths` 映射（项目→相对目录）。

### 部署
- pnpm pack → `@dsh-external/project-nav@file:...0.2.7.tgz` 官方通道安装；插件无本地 node_modules（单实例拓扑 ✅）；dump-config 无重复 id。
- dsh-web 重启验证：3080 LISTENING、token URL 303、err 日志无插件报错。

## 二十、2026-09-08 00:55 · pmg 整合方案（轻维护原则收敛）

### 核心约束（lk 定调）
1. 治理维护成本必须 < 项目开发成本——治理不能比开发还费精力
2. 以 project-nav 为主，不做完整整合，只看有没有必要吸收
3. 维护太繁琐的项目可以废弃（pmg 正是这类：TS 构建链 + 依赖 DSH_CHECKOUT + 每项目 governance.json 配置）

### 吸收判定矩阵（轻维护过滤器：每项先问"要不要每项目多养一份配置/文档"）
| pmg 功能 | 判定 | 理由 |
|----------|------|------|
| docs/map/{tree,root,index} 每项目文档 | ❌ 不吸收（重复建设） | nav 索引 + nav_sync_docs 自动对齐已覆盖；再养一份 = 双份维护 |
| check 规则门禁（dead-links/changelog/semantics） | ❌ 暂不吸收 | 需每项目 governance.json 配置 + 规则调优，重维护；nav_status 的 findStaleFiles 已覆盖死文件探测 |
| pre-commit hook | ❌ 不吸收 | 每项目装 hook、跨项目行为不一致，维护摩擦大 |
| reconcile 文档卫生 | ❌ 不吸收 | nav_status + STALE Files 已是同职能的零配置版 |
| ADR 决策记录 | ⏸ 列入 backlog（暂不写码） | 目前 HANDOFF.md 承担决策记录；真实需求出现时给 nav 加 nav_adr（约 50 行，写入项目 docs/adr/ 并登记 nav-docs），届时一并评估 |

### pmg 处置（隐藏而非删除）
- 源仓库 D:/FF/dsh-project-map-governance-plugin 原样保留；3 个项目已落地的 docs/map 产物不动；engine skill 副本（~/.dsh/skills/project-map-governance）保留
- 唯一动作：清 profile 孤儿残留（node_modules 里带重复 dsh-tools 的副本）——待 lk 确认后执行

### nav 轻维护红线（固化）
- 不引入任何"每项目必配"的治理配置；数据单真身 D:/FF/.internal/，其余全部自动派生
- 新工具准入标准：零配置 + 自动对齐，否则不上
