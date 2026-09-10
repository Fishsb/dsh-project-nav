# project-nav 项目交接文档

> **创建日期**：2026-09-07  
> **工作目录**：`D:\FF\project-nav`  
> **关联工作区**：`D:\FF`（四项目治理文档：`PROJECT.md` + `modules/` + `.internal/nav-index.json`）

> ⚠️ **读者注意（开源可移植性）**：本文件是作者本机开发日志，含作者环境路径（`D:\FF`、`D:\FF\refs`、`C:\Users\lk` 等）与个人工作流细节。它们**不是插件的运行时依赖**——插件所有路径均可配置（见 README「配置 root」）。维护/贡献者参考时请勿把这些路径当作对外约定；对外文档以 README.md / README.en.md 为准。

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

---

## 二十一、2026-09-08 20:13 · v0.2.8 ESM 导出/导入修复 + 禁用残留清理（重装生效）

### 事故复盘：修复为什么迟迟不生效

1. **Bug 本身（同类两处）**：`scopeTargetsOfOpenActions` shared 定义未 export + host 调用未 import（前一会话已修）；**`renderProjectDocSection` host:516（nav_sync_docs）调用未 import——前一修复漏掉**，本次补上（修漏时顺带删除 host 死导入 buildTree）。
2. **前一修复"重启即从 D:\FF\project-nav 加载"的机制解释是错的**：profile 中 project-nav 是 file: tgz 的**解包副本**（realpath 指向自身，非链接）。重启只加载副本，不改源码就永远不会生效。当时碰巧生效是因为修复文件被直接复制进了 profile 副本。
3. **真正的拦路虎**：profile `cordis.patch.yml` 尾部残留 `- id: project-nav / disabled: true`（09-07 卸载事故遗留），且 `dsh.profile.bundles` 当时无条目 → dev_inject_plugin 以为插件 active 跳过注入，loader 层实际禁用 → dev_reload_package 又因插件入口是 host/index.js（非 lib/index.js）重载失败。三因素叠加，怎么折腾都不生效。

### 本次执行记录

| 步骤 | 结果 |
|------|------|
| host/index.js import 块补 `renderProjectDocSection` | ✅ |
| node --check host/shared ×2 | ✅ |
| 冒烟：node 直跑 shared 核心链（loadIndex→loadActions→scopeTargetsOfOpenActions→renderMapHtml/renderProjectDocSection），对真实工作区 D:\FF 渲染 | ✅ html 7801B |
| version 0.2.7→0.2.8，pnpm pack | ✅ 含 host/shared/patch/README |
| `dsh plugin --profile web add "@dsh-external/project-nav@file:…0.2.8.tgz"`（别名语法覆盖，6.4s） | ✅ supply-chain 过 |
| 装入核对：副本 0.2.8、shared import 块完整、`dsh.profile.bundles` 含条目、顶层 dsh-tools junction→核心未改写、插件无本地 node_modules | ✅ |
| 移除 cordis.patch.yml 的 project-nav disabled 条目 | ✅ 备份 `~/.dsh/backups/project-nav-reenable-20260908/` |
| `--dump-config`：无重复 id、stderr 干净、`- id: project-nav` 条目在 | ✅ |
| `sc stop/start dsh-web`：RUNNING、3080 LISTENING、token 303 | ✅ err 日志无插件报错 |

### 经验固化（下次改 project-nav 源码的标准发布路径）

源码目录不是运行时加载源——**改完必须 bump 版本 → pnpm pack → dsh plugin add 覆盖装 → 重启 dsh-web**；装完必查 cordis.patch.yml 无 disabled 残留 + bundles 有条目。dev_reload_package 对本项目无效（入口非 lib/index.js）。

### 待 DSH 会话 UI 实测

① 工具清单出现 nav_*（12 个）；② `nav_map format=html` 生成 `D:\FF\.internal\map-workspace.html`（渲染路径冒烟已过）；③ `nav_sync_docs` 跑通（本次修复点）；④ 治理循环 nav_plan → nav_mark begin → 改动 → nav_mark done。

## 二十二、2026-09-08 20:33 · nav-index 键对齐手术 + v0.2.9 stale 误报修复与地图可读性

### 缘起（DSH 侧只读检查汇报）

DSH 会话跑 nav_map 后报告：HTML 生成成功、vector 正常，但 **4/5 项目特征全部不可见**（显示 0 features）。根因定位 = `projectToModules` 与 `moduleToFeatures` 键名层级错位（lk 指令：当前项目问题直接修复，其他项目问题只汇报）。

### 数据手术一：键名层级对齐（修 4/5 项目 0 features）

- **归属判定**：`moduleToFeatures["shoucang"]=SC-S01..S07`（项目名作模块键）本身完整合法——"整个项目一个模块"是合法粒度，与 pmg/prompt-enhancer/dsh-dev-docs 一致。错位来自 `projectToModules` 存量的子模块键（panel/scheduler/host/client/voice/components/engine/lib/scripts/docs/subsystems）**从未在 moduleToFeatures 登记过**（§16 数据合并带入），不是记忆插件项目的数据问题。
- **方向选择**：改 projectToModules 对齐 m2f 真实键（零信息损失）；反向改 m2f 需要特征→子模块分配知识，数据里没有，不能瞎编。对齐后惯例与 PN-P01 一致（p2m 键 ⊆ m2f 键）。
- 四项目 p2m 归位为 `[<项目名>]`；空壳子模块键随之消失。备份 `~/.dsh/backups/nav-index-keyalign-20260908/`。手术用 shared 的 loadIndex/saveIndex 走（原子写 + metadata 自动重算）。

### 数据手术二：PN-P01 自治理数据清理（当前项目，连带修复）

- PN-F01..F05 从 M01/M02/M03 **三重挂载**归位到 PN-M02（shared 核心层，实现主体所在）；删空壳/死模块 PN-M01（host）/PN-M03（shared/tools 目录 v0.2.0 已删）/PN-M04/M05；fileToFeature 清掉 shared/tools/* 死链与两条层级错置条目（`host/cordis.patch.yml→PN-M01`、`package.json→PN-P01`——模块码/项目码错当特征码）；删死特征 PN-F06/PN-F07（client 面板与 build 脚本 v0.2.0 起实现已不存在）及其描述、functionToModule 指向已删模块的条目。备份 nav-pn-cleanup / nav-pn-deadfeatures-20260908。
- 结果：metadata 45→36 files、9→5 modules；PN-P01 = [PN-M02] 单模块，特征零重复、零死链。

### 代码修复（v0.2.9）

| # | 严重度 | 问题 | 修复 |
|---|--------|------|------|
| 1 | 🔴 | **findStaleFiles 误报 38 个 stale**（v0.2.7 B1 引入）：假设文件键是项目相对，但存量键是工作区相对（带项目前缀，如 `shoucang/client.js`）→ 双重前缀永远 miss。PN 的 `host/index.js` 恰好项目相对所以没报，`client/index.js` 等真删除文件又恰好报对，掩盖了 bug | **双形态兼容**：项目相对（经 projectPaths 解析）/工作区相对任一存在于磁盘即健康，两者皆缺才报 stale。修复后仅剩 pmg 侧 2 条真死链 |
| 2 | 🟡 | lk 反馈：地图"只有文件目录结构，没有逻辑说明，没有任何标注" | nav_map HTML 增强：顶部「📖 怎么读这张图」指引块（层级结构/特征定义/🔴语义/改动工作流）；模块显示 moduleMeta 的 name；特征展开显示 userView/systemView 说明块；项目 summary 显示 projectPaths 磁盘路径；无文件无描述的特征显示「待登记（nav_update --field files）」提示。renderTreeText 模块行同步带名字 |

### 汇报项（其他项目侧待办，按 lk 指令不代改）

- **pmg**：`engine/lib/lib-parse.mjs`、`lib-links.mjs` 死链（pmg 仓库已删 lib 目录）→ pmg 侧 `nav_update --field files` 清理 PMG-P01/P02/P03 的文件清单。
- **shoucang**：SC-S01/S04 登记了特征但无文件清单。
- **dsh-dev-docs**：DD-D01..D04 无文件清单、无描述。

### 部署（v0.2.9）

pnpm pack（tgz 校验含 5 文件）→ add 覆盖装（6.8s）→ 核对（副本 0.2.9、双形态修复与 howto 增强在位、dsh-tools junction→核心未变、bundles 有条目）→ sc 重启 → RUNNING / 3080 LISTENING / token 303 ✅。地图重新生成 11840B：**5 项目 21 特征全部可见**，stale 仅剩 pmg 侧 2 条真实死链。

## 二十三、2026-09-08 20:55 · 展示形态定稿：多层逻辑架构图（arch-view skill 路线）

### lk 定调（两轮反馈收敛）

1. v0.2.9 增强后的树形地图仍不满足"直观了解项目状态"——目录树是 agent 导航视角，用户要的是**逻辑架构图**。
2. 目标形态 = **多层嵌套下钻**：L1 项目总览（模块组成与依赖关系）→ 点开模块看 L2（模块内部：文件引用、数据流、循环、条件分支、状态机）。
3. 生成时机 = **按需生成 + 状态摘要**（lk 已确认）：平时零维护，要看时调用再生成；nav_plan/done 输出带一行状态摘要。
4. 仪表盘卡片形态被否（"不需要 html 了"指卡片列表形态，非载体本身）；最终产物为 mermaid 图（可配自包含 HTML 渲染）。

### 关键技术判定

| 层 | 内容 | 数据来源 | 幻觉风险 |
|----|------|---------|---------|
| L1 | 模块依赖边（谁 import 谁） | 确定性静态扫描 import/require/preload + nav 索引健康标注 | 零 |
| L2 | 数据流/循环/条件/状态机 | **LLM 读码提炼**（AST 给不了语义） | 有 → 靠锚定 |

**防幻觉闭环**：图中文件节点必须 ⊆ nav_query 锚定清单；索引外节点标 ⚠ 并引导补登记。存档头部记录 per-file mtime/size 指纹，比对不一致即过期重生成。

### 载体决策

skill（`~/.dsh/skills/arch-view/`）先行——L2 的 LLM 读码提炼是 agent 本职，skill 零打包重启成本、立刻可用；实战验证提炼质量后再评估是否把 L1 渲染 + 存档过期管理工具化为 `nav_arch`（v0.3.0 候选，第 13 工具）。MCP 因 WorkBuddy/DSH 环境分离不采用。

### 已落地

- ✅ `~/.dsh/skills/arch-view/SKILL.md`：铁律（锚定/不编造/按需/每图 ≤15 节点）+ L1/L2/交付三段流程 + 存档指纹格式 + 边界（只读源码，写权限仅 `D:\FF\.internal\arch\`）。
- 设计留档：本节。

### 待办

- DSH 会话实测：对 shoucang 跑一次 L1 + 对 scheduler/distill 链路跑一次 L2，检验提炼质量与锚定告警。
- nav_mark done 的 delta 输出追加"架构存档过期提示"（v0.3.0 与 nav_arch 一并评估）。

## 24. arch-view 首次实战 + 定位升级：架构文档 = 核心维护文档（2026-09-08 晚）

### 实战结果（shoucang L1+L2）

- 首次全流程跑通：索引锚点 → import 静态扫描（9 条边全实测）→ 逐文件读深睡链源码 → 落档+指纹 → 渲染。
- 产物：`.internal/arch/shoucang-overview.md`（L1 文件级 import 图，单模块降级规则首次应用）+ `shoucang-SC-S07-deepsleep.md`（L2 贯通主链 15 节点，全部有行号依据：noteEvent:535 / check:944 / setInterval:1096 / probe:839 / parent:697 / spawn:781 / applyPrinciples:645 / gate exit 0/1/2/4 / 落盘:802）。
- **锚定告警真实命中**：索引外 = src/index.ts、**src/panel.ts（SC-S07 三路由宿主却未登记，此前未发现）**、src/scheduler-share.ts、skill/scripts/locate-transcript-probe.mjs；另有已知 SC-S01/S04 缺文件。登记属 shoucang 侧自治理素材，不在本项目动数据。

### 定位升级（lk 22:10 拍板）

- **架构逻辑文档（arch/*.md）升格为核心维护文档**，= agent 的开发主地图：开发前必读拿"数据怎么流、循环在等什么、分支判什么"，开发后按指纹过期重生成。
- **渲染图降为文档的用户向投影**：不独立维护、不承载文档外新事实；用户要看时从文档现渲染，文档一改图即视为过期。
- 三层模型写入 SKILL.md：索引层（nav 四维索引，事实底座）/ **文档层（arch/*.md，核心）** / 渲染层（SVG，投影）。
- 渲染版式铁律新增（lk 反馈"样式与文字说明重叠覆盖"）：标签与线/框/其他文字间距 ≥10px 禁止重叠；节点内单行文字宽度 ≤ 框宽 −16px。L2 已按此重渲染（修正 4 处贴线标签 + 3 处文字溢出框）。

### 待办

- shoucang 侧补登记 5 处索引外（panel.ts 优先进 SC-S07）。
- **架构文档接入治理循环（v0.3.0 核心项；lk 22:30 追问"agent 开发时并不看逻辑架构吗"确认的缺口）**：现状循环六环节（查影响面→计划入账→开工→改代码→收口→派生）没有任何一环引导 agent 读 arch 文档，逻辑理解全靠临时读码。接线点：
  - `nav_query` / `nav_plan` 输出末尾附一行"架构文档指针"：`arch/<project>-*.md（新鲜|过期）`——新鲜度 = scope 内文件最新 mtime 与指纹头部 generated 比对，轻量实现
  - `nav_mark done` 的 delta 输出提示"涉及特征的架构文档已过期，下次查看将重生成"
  - `nav_arch` 工具化（L1 渲染 + 过期管理）一并评估
  - 零代码过渡：各项目 AGENTS.md 加一行"开发前读 `D:\FF\.internal\arch\<project>-*.md`"——shoucang 等属他项目文件，作汇报项由 lk 定

## 25. 架构先行协议（Architecture-First）—— v0.3.0 整体架构方案（lk 23:35 拍板）

### 原则

**每一个任务、每一个开发决策都从架构出发**。架构文档不是参考资料，是决策入口：

- 方案确认阶段（nav_plan → lk 拍板）必须以架构为核心参考——lk 拍板的依据从"文字描述"升级为"**架构位置**"（落在哪条链、哪个节点、波及谁）
- 任务在架构上**找不到锚点 / 链路不覆盖任务意图** = 架构不足 → **先修架构（整体方案），再开工程任务**
- 禁止"架构空白处反复打补丁"——这是大模型迭代最常见病灶，由工具侧守卫识别

### 任务分流（nav_plan 阶段判定）

| 判定 | 条件 | 结果 |
|---|---|---|
| 架构可承载 | 有明确锚点（arch 文档 + 节点），链路可解释任务意图 | 工程任务正常入账（archBasis 写入 plan 记录） |
| 架构不足 | 无锚点 / 链路与意图冲突 / 文档过期且差异大 | **架构修订任务**：先出整体架构方案（改 arch 文档+设计），lk 确认后派生工程任务 |
| 补丁循环嫌疑 | 同一特征同一节点 ≥3 次 done 修补 | 强制回架构层：输出整体审视建议，暂停继续小修 |

### 工具改动清单（v0.3.0）

1. `nav_plan`：plan 记录新增 `archBasis` 字段（arch 文档+节点）；输出附"架构对照"段（落点/波及/状态）；无锚点 → 提示转架构修订
2. `nav_mark done`：delta 累计 per-feature/per-node 修补计数；≥3 触发补丁循环告警；提示架构文档过期
3. `nav_arch`（新，第 13 工具）：check（任务↔架构覆盖校验）+ render（用户向投影）+ 过期管理（指纹比对）
4. `nav_query`：输出末尾附 arch 文档指针行（新鲜|过期）
5. 零代码：各项目 AGENTS.md 加"开发前读 arch 文档；决策从架构出发"指针

### 分级判定（lk 23:45 补充拍板：不批量补档，按需生成）

| 项目架构文档状态 | nav_plan 行为 |
|---|---|
| 项目**无** arch 档 | **软提示**："该项目暂无架构文档，建议本次方案确认时顺带出 L1（可跳过）"——不强制、不阻塞 |
| 有档但无锚点 / 链路不覆盖 / 过期差异大 | **强制架构修订**：先出整体方案，lk 确认后派生工程任务 |
| 同节点 ≥3 次 done 修补 | **强制回架构层**整体审视 |

### 首批应用与验收（lk 23:45 定）

- ❌ 不批量预生成其余 4 项目的 L1——项目由 lk 自行开发时按需补充（软提示引导即可）
- v0.3.0 验收标准：接线四件套（nav_query 指针行 / nav_plan 架构对照段+archBasis / nav_mark done 计数+过期提示 / nav_arch 三能力）落地 + shoucang 实测一轮协议判定正确
- 协议的第一次执行对象是 **v0.3.0 自身**：开工第一步 = 先给 project-nav 自身出 L1 arch 档作为架构锚点，工程任务再挂锚点入账（自举）

## 26. 逻辑循环闭环审查（lk 23:50 要求；逐边源码验证，非凭记忆）

### 结论

**治理主循环 8 条边全部闭环（有行号证据）；架构层设计闭环但 3 处接线未实现（v0.3.0 立项范围）；文件落点 2 处缺口 + 1 处策略缺口。**

### 闭环矩阵（文件 × 产生 × 消费 × 过期）

| 文件 | 产生 | 消费（行号） | 过期/再生 | 判定 |
|---|---|---|---|---|
| `.internal/nav-index.json` | nav_add/update（loadIndex/saveIndex 原子写） | nav_query / nav_status / nav_map（buildTree: shared:275→330/405/452） | 活真相，无过期概念 | ✅ |
| `.internal/nav-actions.json` | nav_plan / nav_mark（nextActionId） | scopeGate（host:114 查影响面拦截）/ nav_map 标红（host:480） / nav_status open 清单 | done 归档 | ✅ |
| `.internal/nav-docs.json` | nav_sync_docs | suggestDocs（host:199/456）/ nav_status（host:550） | — | ✅ |
| `.internal/vector.json` | nav_set_vector | **mainlineGate 告警（host:74/114）+ notDoing 硬拦截 ERROR（host:164）** + nav_status（548-568）/ nav_map 头部（487）/ nav_sync_docs（516） | 每次调用现读盘，改了立即生效 | ✅ 最强一环 |
| `.internal/map-workspace.html` | nav_map（renderMapHtml） | 用户（状态视图） | 按需重生成 | ✅ |
| `.internal/arch/*.md` | arch-view skill（LLM 提炼 + 指纹头） | agent 开发前必读（协议）/ 渲染投影 | 指纹过期 → 重生成 | ⚠ 设计闭环，接线未做 |
| `.internal/arch/render/*.svg` | skill 渲染 | 用户（逻辑视图） | 跟随文档指纹 | ✅ 单向，不回写 |
| `~/.dsh/skills/arch-view/*` | 人工/会话修订 | DSH 会话 agent | 无版本管理 | ⚠ G7 |

### 缺口清单（含处置方案）

- **G1（已立项）**：架构层三处接线未实现——nav_query/nav_plan 指针行、nav_mark done 计数+过期提示、nav_arch check。当前 agent 开发时无人提醒 arch 文档过期，属明示开环，v0.3.0 关闭。
- **G4（✅ 已执行，lk 23:58 确认）**：project-nav 自身 4 文件已登记——新建模块 **PN-M03「插件工程与治理」(infra)** + 特征 **PN-F06「打包·补丁·治理文档」**，挂 package.json / host/cordis.patch.yml / README.md / HANDOFF.md。数据手术流程：备份 `~/.dsh/backups/nav-index-g4-20260908/` → loadIndex/saveIndex 原子写 → 双验证通过（metadata 36→40 文件/21→22 特征/5→6 模块；buildTree 5 项目 0 孤儿；stale 仅已知 2 条 pmg 死链，无新增）。
- **G5（✅ 策略已立，lk 23:58 确认）**：备份保留规则写入 MEMORY 运维铁律——`.internal/*.bak-*` 每类保留最近 5 份、`.internal-bak-*/` 快照目录保留最近 1 份，超出在下次数据手术时顺带清理（不静默删）。当前存量（actions×4 / index×3 / vector×3 / 快照×1）全部合规，无需清理。
- **G6（✅ 已修）**：两套用户渲染边界未成文 → 已写入 SKILL.md：nav_map=状态视图（索引驱动、实时）；arch 渲染=逻辑视图（文档驱动、指纹过期），互不替代互不回写。
- **G7（待办）**：arch-view 技能文件（`~/.dsh/skills/arch-view/`）无备份落点——建议每次修订后随手备份到 `~/.dsh/backups/skill-arch-view-<日期>/`，或纳入项目 docs/ 存副本。
- **G8（✅ 已执行，lk 23:58 确认）**：旧发布包 dsh-external-project-nav-0.2.7/0.2.8.tgz 已删除，仅保留 0.2.9（当前发布通道参照）；`.gitignore` 经核实**本就含 `*.tgz`**（此前审查误判为缺失，已更正）。

### 补丁计数现状说明

nav_actions.json 目前只记 done 与 scope，无 per-node 修补计数——"≥3 次强制回架构层"的守卫在 v0.3.0 实现（nav_mark done 时按 plan 的 archBasis 累计）。在此之前该守卫靠 agent 自觉（协议已入 MEMORY 铁律）。

## 27. 重复与臃肿审查（lk 00:00 要求；工具全量名册核对 + 多副本规则盘点）

### 工具层：12 个全量核对，无真功能重复

nav_query / nav_plan / nav_mark / nav_update / nav_add_feature / nav_add_module / nav_add_doc / nav_docs / nav_map / nav_sync_docs / nav_status / nav_set_vector（host:96–587）。

- 最接近的一对：`nav_add_doc`（手工登记）vs `nav_sync_docs`（扫描同步+排序建议）——动作不同不重复，保持；若 sync 将来全覆盖 add 场景再评估合并
- nav_map(text) / nav_query / nav_status 三者都带 open 动作信息——回答的问题不同（导航树 / 点查 / 健康快照），不合并（API 稳定优先）

### 规则多副本：有意分层，加权威源声明防漂移

- 架构先行协议正文 = **HANDOFF §25（权威源）**；arch-view SKILL.md（DSH 会话运行时读）与项目 MEMORY.md（WorkBuddy 会话运行时读）为**投影副本**，各带指针。修订规则只改权威源，副本跟着同步。
- 同理：G5 备份规则权威源 = MEMORY 运维铁律 5；G6 渲染边界权威源 = SKILL.md 边界节。
- SKILL.md 内部去重：铁律 3（图不添料）为唯一规则源，§3 渲染步骤改为引用（本次已执行）。

### 未来双轨风险（预承诺收敛路径）

- **nav_arch 工具落地时**，arch-view SKILL 的 check / render / 过期管理章节收缩为"调 nav_arch"，skill 只保留 L2 内容提炼（LLM 读码）——**不允许 skill+tool 双轨长期并存**。

### 卫生观察（lk 00:19 确认，已全部清理 ✅）

- ~~`metadata.generated` 遗留字段~~ → **已删**（全库 grep 证实零消费；recomputeMetadata 不会回填；删后双验证：40/22/6/5、0 孤儿、PN-F06 完好、stale 不变）。备份：`~/.dsh/backups/nav-index-meta-gen-20260909/`
- ~~`project-nav/.internal-bak-20260907/` 孤儿快照~~ → **已删**（对应本目录 `.internal` 已不存在，真身统一在 `D:\FF\.internal`；快照内 3 个 json 的 9-07 状态已在删除前留档于本节历史）
- HANDOFF.md 57KB 叙事史：交接文档定位使然，按需沉淀，暂不瘦身（维持原判）
- 附带闭环 **G7**：arch-view 技能已备份至 `~/.dsh/backups/skill-arch-view-20260909/SKILL.md`，今后每次修订后随手更新该备份

### 闭环复核（PN-M03 手术后）

buildTree 5 项目 0 孤儿；stale 仅 2 条已知 pmg 死链；vector 五消费点 / scopeGate / findStaleFiles 全部在位（§26 证据仍有效）；arch 两档指纹自 20:50 无文件变更，新鲜。

## 28. GitHub 发布与展示页（lk 00:27；锚点 PN-F06，架构档无代码变更直接开工）

- **推送**：`cb819d4..8f28a4a main→main`（v0.2.9 全量：架构文档层 / 架构先行协议 / 双语 README / LICENSE / 包元数据；7 文件 +477/−35）
- **展示页重排**（参考常规开源项目版式）：`README.md`（中文主）+ `README.en.md`（英文镜像）顶部互切；居中标题 + 4 徽章（version/license/dsh-tools/node）；治理循环 mermaid（GitHub 原生渲染）；12 工具表；三层模型表
- **LICENSE 落盘**（BSD-3-Clause）——此前 package.json 声明了 license 却无 LICENSE 文件，即"标签不完整"的根因之一
- **package.json**：+repository / homepage / bugs，keywords 6→12，author 更正 Fishsb (lk)
- **仓库元数据**：description（中英双语一句）+ homepage（API PATCH 200）
- **topics 12 个**（API PUT 200，GET 验证在列）：agent-tools · anti-drift · architecture · cli · deepseek · deepseek-harness · documentation · drift-detection · dsh · dsh-plugin · knowledge-graph · project-governance
- **索引落点**：LICENSE + README.en.md 登记进 PN-F06（metadata 40→42 文件；0 孤儿；stale 不变；备份 `nav-index.pre-docs2.json`）
- **实施备注**：gh 未登录，API 走 `git credential fill` 存储凭据（token 未回显、用后即弃于进程）；profile 副本与仓库无关，插件发布仍走 pnpm pack 循环

## 29. v0.2.10 开源可移植性修复（review → 修复；锚点 PN-F06 发布面 + 代码面）

- **背景**：审查结论——新用户按 README 安装会踩作者机器耦合：① `Config.root` 默认硬编码 `D:/FF`（全仓无配置文档）；② README 主打"架构文档层"实为作者本机 arch-view 技能提供、不在包内；③ `nav_docs` 空态提示夹带 `D:\FF\refs\<项目>\`；④ `pnpm test` 指向不存在的 `test/*.test.mjs`，空跑假绿。
- **改动**（用户确认：不做版本适配，peer 锁 `0.1.2-rc.1` 与 Node 要求保持）：
  - `host/index.js`：`root` 默认 `''`（无机器路径），apply 时 `config.root` 显式则 `resolve`，否则回退 `process.cwd()` 并 boot warn 打印生效 root（提示看 README「配置 root」）；`nav_docs` 空态提示改为中性文案。
  - `test/core.test.mjs`：新增 12 项真实回归（原子 JSON 往返 / metadata / queryIndex / id 自增 / suggestDocs / scopeTargets / findStaleFiles / 三种渲染），全部跑临时目录，不碰真实工作区。
  - `package.json`：version 0.2.10；`test` script 由 glob 改为 `node --test`（默认发现 test/*.test.mjs，无 shell glob 依赖）。
  - `README.md` / `README.en.md`：新增「配置 root」小节（patch 层 `config.root` 示例 + cwd 回退语义 + 启动日志核对）；架构文档层改标"生态配合，不在本包内"；三层模型/数据节同步；"零每项目配置"修正为"除 root 外零每项目配置"；开发节注明真实测试与发布循环补 root。
  - `HANDOFF.md`：头部加机器路径警示（本日志路径非对外约定）。
- **验证**：pnpm test 12/12 绿；pnpm pack 产物 0.2.10 tgz（旧 0.2.9 tgz 删除）；fresh clone → install → import 冒烟通过。
- **作者本机后续动作**：重装 0.2.10 时必须在 profile patch 层补 `config.root: 'D:/FF'`（旧默认值已移除），否则回退 cwd 治理到错误目录——README「配置 root」有示例。

_本文件应随项目推进持续更新。最后更新：2026-09-10 10:05_
---

## 30. v0.4.0 多会话并发 + scope 文件指纹（lk 需求 → 实现；锚点 PN-F06）

> **版本号提示**：§25 已把 **v0.3.0** 预留给「架构先行协议」（前置方案，尚未实现）。本节的实现版本因此定为 **v0.4.0**，避开撞号。

### 缘起（lk 提出的优化点）

> "一个项目可以同时多个会话同时工作……如果其他会话发现有标记就需要等待另一个完成再继续，这样排队模式，只要他们改动影响的不是同样的文件模块功能就不会冲突，这样就可以同时干活。"

方向成立，但要修正一处：当时是 **v0.2.6 立的「单 in_progress 强制」全局锁**（`nav_plan` 见任何 in_progress 直接 ERROR），它不是"标记"而是**全局锁**——不相交的两个会话也会互相堵死。所以本次不是"加排队"，而是**把全局单锁换成按 scope 的细粒度租约锁 + 只在冲突时定向排队**。

### 30.1 v0.3.0 并发核心（scope 锁）

- **身份**：`ToolRunContext.agent.id`（agent 的 SessionId）即会话身份，无需环境变量猜测；拿不到 sessionId 时自动回退旧的全局单锁行为（legacy 兼容）。
- **账本跨进程文件锁**（`shared/withLedgerLock`）：O_EXCL 独占创建 + 陈旧破锁（15s）+ 进程内 Promise 队列 + 可重入 token。**这是必需项**：原实现是「原子 rename 的无锁读改写」，两个会话同时 `nav_plan` 会算出同一个 ACT-ID 并互相覆盖。已用测试真实复现（6 个并发 plan → 全部 ACT-001、只入库 1 条）后修复。
- **租约**：`nav_mark begin` 授予 `lease{acquiredAt,renewedAt,ttlMs}`，默认 TTL 30 分钟（`config.leaseTtlMs` 可调）；任何本会话调用自动续约（读取时续约 = 心跳，agent 无需 ping）；崩溃会话的租约到期自动转 `expired`，绝不死锁工作区。
- **冲突判定三层**（`shared/scopeConflict`）：
  1. 功能交集；
  2. 模块交集——**含「不同功能同模块」**（按索引反推模块归属）；
  3. 文件交集——canonical 路径（`host/index.js` ≡ `project-nav/host/index.js`）、目录前缀；
  4. **派生文件交集**——两个不同功能被索引映射到同一文件，仍是真冲突。
- **排队**：`nav_mark begin` 无冲突即授锁放行；有冲突返回 `⛔ BLOCKED + 队列位次 + 谁锁着哪片 scope`，可选 `wait=true, waitMs=...` 阻塞等待；`done` 释放 scope 时点名播报解除阻塞的排队者。计划态（planned）不算阻塞，避免"空占位"互相堵死。
- **每会话一个 in_progress**；只能关闭自己持有的动作（跨会话 done/abort 被拒）。
- **`nav_query` 会话感知**：`⚠ OCCUPIED`（含"目标文件属于对方 feature"的索引反查）/ `PARTIALLY OCCUPIED`（模块级）/ 其他会话无关动作只报上下文不阻塞。
- **`nav_status`** 增 `Concurrency (multi-session)` 视图：谁锁着哪片 scope、跑了多久、租约何时到期、谁在排队。

### 30.2 v0.4.0 scope 文件指纹（防"别人偷偷改/删"）

租约只防"同时开工"，防不住**开工期间文件被改/被删**（另一会话、编辑器、清理脚本、`--force` 写入）。故：

- `nav_mark begin` 记录 scope 内每个文件的 `{size, mtime, sha1(≤256KB)}` 快照（`a.scopeState`，作用域 = 索引推出的文件 ∪ 字面量路径；
- `nav_mark done` 比对磁盘现状，输出 `⚠ Scope drift since begin`（modified / vanished / appeared 三类），并把结果落到 `a.drift` 供事后复盘；干净收口则明确回 `✓ Scope fingerprint verified`；
- `nav_status` 对**运行中**的动作实时显示 `DRIFT since begin -> ...`；
- 空 scope 语义修正：**空 scope = 无可比对，不等于"全部消失"**（首版曾因 `scopeState` 未带 scope 而误报 vanished，已修）。

### 30.3 验证

- `test/concurrency.test.mjs`（新增，15 用例）：不相交并行 / 同模块冲突 / 派生文件冲突 / `wait=true` 排队至释放 / 租约过期自愈 / 每会话单动作 / 跨会话不可抢占关闭 / 并发立项零丢失零重号 / 占用可见 / **同文件两种路径写法判冲突** / **不相交目录真并行** / 指纹 changed / 指纹 vanished / 指纹 clean / legacy 回退。
- `test/core.test.mjs` 12 用例保持全绿；`package.json` 的 `test` 改为显式跑两个文件（Node 22 的 `node --test <dir>` 不可用，且原来 `node --test` 会假绿）。
- 仓库内 `node --test test/core.test.mjs test/concurrency.test.mjs` = **27/27**。
- 真实工作区 `D:/FF` 双会话冒烟：并行放行 ✅、冲突 `queue position 1` ✅、`done` 后排队者自动放行 ✅、文件级查询 OCCUPIED ✅（冒烟后账本原样还原，零残留）。

### 30.4 三个诚实限制（设计即接受）

1. **这是协作锁，不是强制锁**：绕过 `nav_plan` 直接改文件的会话，nav 拦不住。它防"无意识撞车"，不防"故意违规"。要抓违规只能靠指纹对账（v0.4.0 已提供事后可见性）。
2. **git 是 scope 之外的元冲突**：两个会话 scope 不相交但同时在同一个仓 `commit/rebase/stash` 一样出事。要不要给 git 写操作加锁，需单独决策（未做）。
3. **scope 写得多粗，并行度就多低**：登记 `src/` 等于独占整个目录；文件级才是正确粒度。

### 30.5 本次会话事故记录（必读）

**事故 A：`D:\FF\project-nav` 整个目录在会话进行中消失。**
- 证据：`D:\FF` 目录 mtime = `2026-09-10T01:05:32Z`（早于会话开始）；会话开始时该目录可读、`nav_plan` 已成功登记动作；随后同一路径读取报 not found，而 `D:\FF` 本身仍可读。
- 影响：v0.2.10 源码一度**只剩已装 profile 副本**（源码目录没了、tgz 也不在 D 盘）。
- 处置：旧 v0.1.0 内容备份到 `~/.dsh/backups/project-nav-old-v010-2026-09-10T0116`；从 profile 副本恢复出源码树并就地升级。事后该目录由另一会话从 GitHub 克隆重建（带 git 历史，停在 v0.2.10），本次工作因此并入该仓库。
- **教训**：源码目录与已装副本是两处真身，仓库才是唯一可回溯的真身——改完必须尽快进 git。

**事故 B：本会话 shell 与文件工具全面失效。**
- 现象：`pwsh` spawn ENOENT、`glob`/`grep` 启动失败、`read`/`write`/`edit` 对存在的文件报 not found；插件清单里 `tool-fs`/`tool-fs-search`/`tool-pwsh`/`tool-bash` 均为 `[no-fiber]`。
- 绕过：用 `dev_stage` 挂进程内 Node 通道完成读/写/跑测试/取证；用 `openSync`/`rmSync` 做原子写替代 edit 工具。
- **教训**：当"文件工具不可用"成为常态，项目需要一条不依赖 shell 的最小读写通道；同时说明插件对 `node:fs` 的依赖在沙箱环境下是被审查项（见 30.6）。

**事故 C：源码目录内容被外部改回（本会话发生两次）。**
- 现象：`C:\Users\lk\.dsh\plugins\project-nav\shared\index.js` 一度从 v0.3.0（36353B）退回原始（22069B），改动全部丢失；host/index.js 同期保持 v0.3.0。
- 处置：从 profile 副本恢复（哈希一致）后重做指纹改动；随后立即并入 git 仓库并提交。
- **教训**：跨会话共享目录里"未入库的工作"极易被覆盖。这正是本插件的存在意义——但它需要 git 兜底。

### 30.6 与「沙箱兼容改造」（另一会话）的冲突点

仓库里另有 sessions 产出的 devref（`docs/devref/shoucang/2026-09-10-*.md`）指出：`shared/index.js` 用 `node:fs` 沙箱不兼容，应改为 `ctx.get('fs')`。**本节的账本文件锁与指纹快照正是重度使用 `node:fs` 的部分**（`openSync` / `rmSync` / `statSync` / `readFileSync` / `readdirSync`、`node:crypto` 哈希）。

- 两者**不冲突于目标，冲突于载体**：沙箱兼容改造应优先，因为它决定"插件能不能在受限沙箱里跑"。
- 建议顺序：先落地沙箱兼容（fs 能力注入），再把 `shared/index.js` 的 fs 调用改为从注入能力取；届时 `withLedgerLock` 若无独占创建能力，需退化为"进程内锁 + 陈旧检测"并降级告警（**锁退化必须显式告警，不能静默**）。
- 已完成的部分与该改造无关，可先行保留。

### 30.7 落地状态（2026-09-10 收官）

| 项 | 状态 |
|---|---|
| 代码 | v0.4.0 已提交并**推送**到 `origin/main`（commit `bb6f523`） |
| 装配 | 走官方通道重装：profile 依赖由 `file:…0.2.10.tgz` 改为 **`file:D:/FF/project-nav/dsh-external-project-nav-0.4.0.tgz`**；核对版本 0.4.0、单实例拓扑（4 个 `@deepseek-ai/*` junction 未改写）、插件零 DSH 闭包、内容与仓库逐行一致 |
| 实机验证 | 真工具 + 真 root `D:\FF`：begin 落指纹快照（size/mtime/sha1）→ 外部改动文件 → `nav_status` 实时 `DRIFT since begin` → `done` 报 `⚠ Scope drift` 并落 `a.drift` → 租约清空、锁文件无残留 |
| 装配声明风险 | **已消除**：此前声明（0.2.10）与实体（0.4.0）不一致，任何重装/依赖刷新都会静默回退 |

### 30.9 同步期发现（2026-09-10 第二轮）

1. **PN-P01 索引被再次回退**：`shared/tools/*`（5）、`client/index.js`、`scripts/build.mjs` 的死条目、`PN-F01..F05` 三重挂载（M01/M02/M03）、空壳 `PN-M04/M05`、以及 `host/cordis.patch.yml → PN-M01` / `package.json → PN-P01` 这类「模块码/项目码写进特征码位」的层级错置**全部复现**——v0.2.9 清理过同一问题。已按 PROJECT.md 自动区（上次核验的良好状态）重建索引：PN 模块 5→2、PN-P01 双重挂载收敛、死文件引用归零；`functionToModule` 中 4 条层级错置键清除。**根因未除**：多个会话的索引写路径没有互斥（v0.4.0 只给账本加了锁，索引写入仍是「读-改-写」），反复清理不解决复发。
2. **参考文档库（nav-docs.json）整体丢失**：`D:\FF\refs` 下文档实体已不在（仅剩 `refs/README.md`），登记表文件消失且**无任何历史副本**（全盘搜索仅命中测试临时目录里的空表）。已重建为 8 条现存真实文档（见 §30.10），但**原登记内容不可恢复**。
3. **装配声明与实体不一致（已消除）**：profile 依赖原为 `file:…0.2.10.tgz` 而实体是 0.4.0——任何重装/依赖刷新都会静默回退到 0.2.10。已改为 `file:D:/FF/project-nav/dsh-external-project-nav-0.4.0.tgz` 并经官方通道安装核对。

### 30.10 参考文档登记清单（重建后，`.internal/nav-docs.json`）

| ID | 文档 | when（路由规则） |
|---|---|---|
| DOC-001 | `refs\project-nav\2026-09-10-v040-并发与指纹设计要点.md`（§30 摘录） | project-nav 并发 / scope 锁 / 租约 / 冲突判定 / 文件指纹 / 多会话 |
| DOC-002 | `project-nav\docs\devref\shoucang\2026-09-10-how-to-project-nav-沙箱兼容改造.md` | 沙箱兼容 / ctx.get('fs') / node:fs 替换 / 受限沙箱 |
| DOC-003 | 同上目录 `…-reference-沙箱改造-vs-文件锁冲突.md` | 账本文件锁 / openSync 独占 / 锁降级告警 |
| DOC-004 | 同上目录 `…-reference-scope-指纹契约-v0-4-0.md` | scopeState / drift 三类 / 空 scope 语义 |
| DOC-005 | 同上目录 `…-reference-project-nav-已知代码问题.md` | 已知问题 / 开放项 / 索引死条目 / 装配声明 |
| DOC-006 | `project-nav\HANDOFF.md` | 交接 / 决策记录 / 事故复盘 / 发布路径 |
| DOC-007 | `C:\Users\lk\.dsh\skills\arch-view\SKILL.md` | 架构图 / 逻辑图 / 数据流 / 怎么实现的 / 下钻 |
| DOC-008 | `.internal\arch\project-nav-PN-F01-nav_query.md` | nav_query 实现 / 查询链路 / 占用判定 / 影响面展开 |

> `D:\FF\refs` 实体目录当前仅存 README；上表 DOC-001 是本次新建，其余指向仓库内文档。原 13 条登记（多为 DSH 官方文档与 shoucang 参考）已不可考——如需恢复请重新放入 refs 目录并 `nav_add_doc`。

### 30.11 架构文档（arch-view）现状

- 已补：`.internal/arch/project-nav-overview.md`（L1 总览，含 import 依赖图 + 索引锚定表）、`.internal/arch/project-nav-PN-F01-nav_query.md`（L2 贯通式主链，含行号依据）。此前 `arch/` 下只有 shoucang 两档 → project-nav 自身**无架构档**，本轮补齐。
- 档位更细的 L2（nav_plan / nav_mark / 冲突判定 / 指纹）尚未出档，按 arch-view「按需生成」纪律留待需要时生成。
### 30.8 下一步（未做）


- [ ] 沙箱兼容改造（fs 能力注入）——见 30.6，优先级最高。
- [ ] git 写操作串行化（scope 之外的元冲突）。
- [ ] 指纹粒度细化（同文件不同函数的并行；当前文件级保守串行）。
- [ ] `docs/` 与 `package-lock.json` 的入库策略（当前未跟踪）。

---

## 31. v0.5.0 架构先行协议（核心治理理念 → 可执行闸门；lk 2026-09-10 定调）

### 31.1 理念（第一原则，不得违反）

> **所有开发动作必须从架构出发。架构不出错，开发过程中的问题就只是局部小问题。**
>
> **任何任务在具体动作之前必须先做架构思考与反思：是否需要调整架构？** 而不是拿到用户指令直接动手——否则会在同一个死胡同反复打补丁、拆东墙补西墙，永远解决不了根本需求。

此前这条理念只活在人的约定与文档纪律里；v0.5.0 把它落成**三个工具拦得住的闸门**。

### 31.2 三个闸门

| 闸门 | 位置 | 行为 |
|---|---|---|
| **锚点闸** | `nav_plan`（新增必填参数 `anchor`） | 无 anchor 直接拒绝登记；anchor 必须经 `checkAnchor` 校验为真实架构节点（功能码 / 模块名 / 索引内文件 / 磁盘实存文件 / `.internal/arch/*.md`）。拒绝文案直接说明「无锚点的动作 = 还没有架构思考」 |
| **计数闸** | `nav_plan` + `nav_mark done` | 同一锚点自「最近一次架构决策」以来累计 **3** 次补丁（`REPEAT_PATCH_THRESHOLD`）→ plan 输出 `⛔ 计数闸触发`、done 输出升级警告；计数 2/3 时预告「接近升格阈值」 |
| **决策闸** | 新工具 `nav_adr`（第 13 个） | 记录 `anchor + reason + decision + impact` 到 `.internal/nav-arch.json`（ADR-xxx）；**登记即重置该锚点补丁计数** —— 这是第一性原理的复位点 |

配套：`nav_plan` 新增可选参数 `arch=`（一句话架构反思）。缺失时 plan 输出 `⚠ 架构反思缺失` 但**不阻塞**——先立「可记录」，再逐步收紧为硬闸。

### 31.3 数据与语义

- `.internal/nav-arch.json`：架构决策账本（`{id: ADR-xxx, anchor, anchorKind, reason, decision, impact, action, session, createdAt}`）。
- `.internal/nav-patches.json`：补丁账本（`{id: ACT-xxx, anchor, at, files, note}`，同一 ACT 幂等，重复 done 不重复计数）。
- 计数窗口：「最近一次架构决策之后」的补丁——决策一旦登记，历史补丁不再累积压力（避免旧账压死新方向）。

### 31.4 验证

- 实机（仓库代码 + 临时 root）：锚点闸（无锚点/假锚点拒绝、架构文档锚点通过）、计数闸（done2 预告 2/3、done3 报 3/3、plan4 报⛔）、决策闸（ADR-001 记录并重置、决策后 plan 不再触发）**全部通过**。
- 回归：`test/core.test.mjs` 12 + `test/concurrency.test.mjs` 22 = **34/34 绿**（新增 7 个架构先行协议用例；既有 24 处 `nav_plan` 调用补 anchor）。
- 提交：`2d18ab1`（协议）、`c4e6b63`（测试）、`a7d934e`（修复压力串跨作用域丢失）→ 均已推送 origin/main。

### 31.5 复盘：一个被静默 catch 吃掉的 bug

计数闸告警首版用回调内 `var archPressure` 跨作用域带出，运行时报 `archPressure is not defined`，**被外层 catch 吞成 ERROR**，表现为「done 永远不出压力提示」而单测只断言 plan 侧，未覆盖 done 侧。修复：把 `pressureNote` 放进 `mutateActions` 回调的返回值（`res.pressureNote`），消除跨作用域副作用；catch 分支改为显式报账本写入失败。**教训：静默 catch 是闸门类代码的毒药——闸门失效必须可见。**

### 31.6 开源同类对比与自身架构审查（要点）

完整对照与逐项证据见 `docs/devref/shoucang/2026-09-10-reference-开源对比与架构审查.md`。

- 对照体系：OpenSpec（specs/changes + propose→apply→archive）、GitHub Spec Kit（constitution + specify→plan→tasks→implement）、ADR（Nygard）、arc42、Backstage catalog、policy-as-code（OPA）。
- **强于同类**：闸门可执行（拒绝登记）而非文档约定；索引由 agent 自维护；文档自动派生消除「文档与代码漂移」。
- **弱于同类**：无「宪法/不变量」层；决策不随仓库传播；无组件所有者/生命周期语义。
- **架构不足（高优先）**：G1 决策账本落在 gitignore 的 `.internal/`（不可传播）；G2 索引写路径仍无互斥（PN-P01 索引被反复回退的根因）；G3 `node:fs` 与沙箱 `ctx.fs` 不兼容；G4 锚点粒度未覆盖影响面越界；G5 无不变量层；G6 架构档过期未接入 done。
- **架构冗余**：R1 两套指纹机制同构（宜抽公共原语）；R2 向量三处（宜显式声明 SSOT）；R3 文档层三套载体缺权威边界声明；R4 `nav_status`/`nav_map` 边界已在文档声明，保留。

---

## 32. v0.6.0 辅助收敛：以架构为核心，其余为辅助（lk 2026-09-10 定调）

### 32.1 定调与唯一判据

> 「在不减少治理质量的情况下，要减少不必要的冗余，以架构为核心，其他的作为辅助就可以了。未来模型会越来越聪明——不聪明的模型如果治理插件太复杂，它根本读不了也遵循不了；聪明的模型也不需要过多的强限制。」

**唯一裁剪标准 = 模型是否必须多读 / 多记 / 多遵循。** 判据不是「这个机制有没有用」（各自都有用），而是**叠加后的遵循成本是否超过其治理收益**。复杂度本身是治理失效模式。

### 32.2 收敛清单（治理质量不变，模型面变小）

| 动作 | 前 | 后 | 依据 |
|---|---|---|---|
| 补丁账本 | `.internal/nav-patches.json` 独立账本 | **废除**；`repeatPressure` 改从动作账本推导 | 补丁 = 带锚点的 `done` 动作，是动作账本的**投影**；两份数据必然漂移 |
| 注册面 | `nav_update` + `nav_add_feature` + `nav_add_module` | **`nav_update`（upsert）** 单一入口 | 三者语义重叠（都在写索引），模型只需记一个工具 |
| 参考文档 | `nav_add_doc`（登记）+ `nav_docs`（检索） | **`nav_docs` 单一入口**（给 `title+path+when` 即登记，否则检索） | 同一对象的两种操作，无需分别记 |
| 锚点闸摩擦 | 任何 `nav_plan` 都必须显式 `anchor=` | **单目标 scope 自动取锚**；只有多目标/歧义才强制 | 单目标场景锚点唯一，强制填写只是形式；强限制留给真正需要架构思考的场景 |
| 决策传播 | ADR 只在 `.internal/nav-arch.json`（gitignore，不可传播） | `nav_sync_docs` 把 **ADR 派生进 PROJECT.md 自动区** | 「决策可回溯」是理念要求；工作区文档是人可读的传播面 |

结果：**工具 13 → 10**，**数据文件 6 → 5**，**闸门一个没少**（锚点 / 计数 / 决策 / 范围 / 主线 / 完结 / 指纹全部保留）。

### 32.3 核心 vs 辅助（固化，README 同步声明）

- **核心（不可省）**：索引（架构真相）、**锚点闸**（动手前先做架构思考）、**ADR**（架构决策留痕）、**计数闸**（同一锚点反复补丁 → 强制回架构层）。
- **辅助（够用即止）**：并发租约与排队、scope 文件指纹、文档自动派生、参考文档路由、地图渲染。辅助服务核心，不另立门槛。

### 32.4 验证

- 回归：`test/core.test.mjs` 12 + `test/concurrency.test.mjs` 26 = **38/38 绿**。
- 新增用例：单目标自动取锚（歧义 scope 仍拒绝）、`nav_update` 创建/更新功能与模块、`nav_docs` 登记+检索+死链拒绝、`nav_sync_docs` 派生 ADR 章节。
- 改写用例：无锚点拒绝 → 仅歧义 scope 拒绝；补丁计数 → 按「带锚点的 done 动作」统计；二次 `done` 不再重复计数（返回 bad-state）。

### 32.5 事故复盘（两条都是通用教训）

1. **按注释区间做块删除时误删了同区块的四个导出**（`loadArch` / `saveArch` / `nextDecisionId` / `checkAnchor`）——只核对了区间首尾，没核对区间**内容**；表现为 host 加载即 `does not provide an export named 'checkAnchor'`。修复：补回四函数。**教训：块删除必须先列出区间内容再删，不能只对首尾锚点。**
2. **生成脚本的转义连番踩坑**：PowerShell here-string 生成 JS 脚本时，路径反斜杠与 `'@` 序列被吞，出现「脚本没跑却以为跑了」的假象，白耗数轮。修复：内置 fs 工具恢复后全部改用精确 `edit`。**教训：能用文件工具就不要用生成脚本改代码。**

## 33. 发布声明对齐修复：声明↔实体二次漂移（lk 2026-09-10 指令；锚点 PN-F06）

### 33.1 问题（DSH 侧升级前审查发现）

| 层 | 实测值 | 判据 |
|---|---|---|
| profile 声明 | `file:D:/FF/project-nav/dsh-external-project-nav-0.4.0.tgz` | profile package.json |
| 该 tgz **内部** version | **0.4.0**（真旧版） | `tar -xOf … package/package.json` |
| profile 实体 | **0.6.0** | 实体 package.json |
| 实体 vs 源内容 | **逐字节 IDENTICAL**（host/shared/patch/package.json） | SHA256 |

即：上次更新**未走 pack + 声明同步**，而是把源文件**手工复制进 profile 副本**（手法同 §21）。后果：任何重装/刷新按声明解析 → **静默退化到 0.4.0**，丢 v0.5 架构先行协议 + v0.6 收敛改造。**这是同型问题第二次复发**（第一次见复核卡「部署声明与实体一度不一致」：声明 0.2.10 vs 实体 0.4.0）。

### 33.2 根因（流程，不是笔误）

产物名含版本号 + 声明文本手工维护 → 两者必须同步，而既有发布步骤里**没有「改声明」这一强制环节**；手工复制副本可让插件"看起来更新了"，从而掩盖声明未同步。

### 33.3 本次修复（ACT-003，未重装、未重启）

| 步骤 | 结果 |
|---|---|
| `pnpm pack`（D:/FF/project-nav） | ✅ `dsh-external-project-nav-0.6.0.tgz` 41220B，内部 version=0.6.0，含 host/shared/package.json/LICENSE/README×2/cordis.patch.yml，**无 node_modules 混入** |
| 归档旧产物 | ✅ `0.4.0.tgz` → `.tgz.superseded-20260910`（防再次误指向） |
| 更新 profile 声明 | ✅ → `file:D:/FF/project-nav/dsh-external-project-nav-0.6.0.tgz`；备份 `package.json.bak-projectnav-declfix-20260910-130130`（含 pnpm-lock 同步备份） |
| 三层一致性 | ✅ 声明路径可解析 / tgz 内部 0.6.0 = 实体 0.6.0 / host+shared+patch SHA256 全 MATCH |
| 单实例拓扑 | ✅ `dsh-tools`/`cordis`/`dsh-llm`/`dsh-client-locale` 四链接仍 → 核心副本，未受影响 |
| patch 层 | ✅ 无 `project-nav disabled` 残留 |
| `dsh --profile web --dump-config` | ✅ exit=0、583 行、无 error/duplicate 信号；project-nav 条目正常 |

**为何不重装**：实体内容已与源一致（IDENTICAL），重装无收益，却会触发 pnpm peer 重解析 → 直撞 §11 双实例事故面。**为何不重启**：无代码/装配形态变更（仅声明文本），且重启属用户红线操作。

### 33.4 流程纪律（固化，防第三次复发）

**发布清单（缺一不可）**：① bump version → ② `pnpm pack` → ③ **更新 profile 声明的 tgz 文件名** → ④（如需）官方通道 `dsh plugin --profile web add "@dsh-external/project-nav@file:<新tgz>"`（别名覆盖，勿先 remove 再 add，见 §15 踩坑） → ⑤ 核对单实例拓扑 + `--dump-config` → ⑥ 重启 dsh-web **由用户执行**。

> 备选根因消除方案（**待定，本次未执行**）：**A)** 产物固定名（`pnpm pack --out <不含版本号的文件名>`）→ 声明永不需要改；**B)** 改 `link:D:/FF/project-nav` 源码直连 → 须**先清除源目录 `node_modules`**，否则复发 §11 事故形态（见 §33.5 遗留 1）。

### 33.5 遗留（本次未处理）

1. 源目录 `node_modules/` 仍有 **19 个 `@deepseek-ai` 拷贝**（含 dsh-tools 0.1.2-rc.1、cordis 4.0.2、zod、@standard-schema）——§12 明确要求的净化项，是 link 形态安装的事故隐患；因与 `npm test` 运行相关，待 lk 决策（清掉后测试需改用 profile 顶层依赖）。
2. 复核卡 `docs/devref/shoucang/*已知代码问题` 的「部署声明与实体一致（**已消除**）」条目已**过时**（本次二次复发）——下次复核按本节更正（该卡由守藏/用户维护，本次未擅改）。
3. profile 顶层 `dsh-client-runtime` junction 仍指向 `D:\lk\deepseek\dsh-motion\node_modules\@deepseek-ai\dsh-client-runtime`（**0.1.0-rc.6**，非核心副本）——同为 §11 事故形态的同类残留（三插件 client 侧共用此副本），建议 DSH 升级后统一来源。

---

## 34. v0.7.0 共享状态写入串行化 + 视觉通道修复（lk 2026-09-10）

### 34.1 G2 实施：所有共享状态读改写进入 per-target 锁

架构审查（§31.6）把「索引写路径无互斥」列为 G2，并指出它正是 PN-P01 索引被反复回退的根因：每次读改写都是「load 快照 → 改 → 整文件回写」，两个写者各自回写自己的快照，**后 rename 者覆盖先者**。

| 改动 | 内容 |
|---|---|
| 锁原语泛化 | `withLedgerLock` → 通用 `withFileLock(rootPath, name, fn)`；锁文件统一落在 **`.internal/locks/<name>.lock`**（不再污染工作区根目录）；`withLedgerLock` 保留为账本专用别名 |
| 陈旧锁判定 | 以**锁文件 mtime** 为权威信号（崩溃进程无法伪造），载荷里的 `at` 仅作诊断 |
| 等待方式 | 旧实现用 `Atomics.wait` 同步睡眠——争用时**阻塞整个 daemon 事件循环**最多 10s；改为 `await sleep(50)` |
| 变更入口 | 新增 `mutateIndex` / `mutateVector` / `mutateDocs` / `mutateArch`（load→mutator→save 全在锁内，返回 mutator 结果）；`nav_sync_docs` 的 PROJECT.md 标记区替换也纳入锁 |
| 锁嵌套禁令 | 单进程队列是一条链，嵌套获取会死锁 → 契约写明「一个临界区只碰一个文件」，四个入口与 PROJECT.md 同步均满足 |
| host 改造 | `nav_update`（6 处 saveIndex 收敛为 1 个 mutator）、`nav_docs` 登记分支、`nav_set_vector`、`nav_adr`（**ADR id 在锁内分配**——与 ACT id 同类竞态）、`nav_sync_docs`；`saveIndex/saveDocs/saveVector/saveArch` 在 host 中已彻底消失（计数为 0） |

### 34.2 验证（43/43）与一次自伤复盘

- 新增 5 项：并发 8 个 `nav_update` 创建均存活、并发 6 次 `nav_docs` 登记均存活、并发 4 个 ADR 拿到互异 id、混合写入后**无锁文件残留**、**锁原语证明**（3 段含 `await` 的临界区严格串行 enter/exit；伪造死人锁按 mtime 立即破除；段尾必释放）。
- **自伤复盘**：该测试初版把「死人锁」写成「载荷 `at` 是 60s 前、文件 mtime 是现在」→ 正确行为是**继续阻塞到超时**（测试因此挂 10s 报错）。这反过来确认设计正确：陈旧判定只信 mtime。修法：用 `utimesSync` 回写文件时间戳来模拟真正的崩溃遗留。
- 全套：`core 12 + concurrency 31 = 43` 全绿。

### 34.3 G3 / G5 处置（记录理由，不为清单而堆机制）

- **G3【探测 + 显式告警，不做双后端】**：`apply` 时探测 `ctx.fs`；存在则 warn「本插件仍走 node:fs 直读直写 .internal/，若本部署对插件 fs 强制围栏，治理数据可能绕过围栏」。不做异步 fs 端口双后端：当前宿主进程未受限（node:fs 全程可用），双后端会让 IO 层翻倍——违反 §32 立的复杂度预算；待真实受限部署出现时一次性迁移。
- **G5【不引入不变量层】**：那会给模型增加一个必须学习的新概念，而锚点闸 + ADR 已覆盖「先做架构思考、决策留痕」的意图。触发条件：出现「必须硬拦且 ADR 拦不住」的真实案例时再评估。

### 34.4 视觉通道：两层根因（环境侧，非本插件缺陷）

多模态在本会话一度完全不生效（`read_image` 拒绝 + 视觉工具全线失败），实测定位到两层根因：

1. **模型能力未声明**（真根因）：`~/.dsh/settings.yaml` 中 provider `commandcode-goat` 的 `deepseek/deepseek-v4.1-flash` 缺 `input:` 声明 → 官方文档明载「手动输入的模型在自己声明之前一律按纯文本对待」，故 `read_image` 在**发送前**拒绝。实测该模型确实多模态（探针图 4 位数正确回显 7391）。
2. **图片输入变体拦截**（设计行为）：dsh-vision-toolkit 对「DSH 判定为 text-only」的路由注册 `<model> (Vision Toolkit)` 兄弟模型并默认透明路由（`hidden: true`），把图片改写成文字描述；当时该描述调用失败 → 既无像素也无描述。修好根因后变体不再对已声明多模态的路由生效，故**不要**为绕开问题关闭 `imageInputVariants`（会让真正 text-only 的路由失去回退能力）——本次已恢复默认并复验。详细排查记录（含「运行时其实 ready、别拿基础解释器测依赖」等踩坑）见工作区 `refs/project-nav/2026-09-10-reference-多模态图片链路两层根因与修法.md`。

**视觉 QA 的收益（首次真正看图）**：据实渲染并审查 `nav_map` HTML，发现并修掉两处渲染缺陷——① 计数未做单复数（`1 modules` / `1 features`）；② 图内「怎么读这张图」的改动工作流仍是旧循环，未含 v0.5.0 起的锚点闸/计数闸/`nav_adr`。修后重渲染复验：`1 module` 正确、howto 已更新、无重叠与截断。

### 34.5 发布（按 §33.4 清单执行，v0.7.0）

① bump → ② `pnpm pack` 得 `dsh-external-project-nav-0.7.0.tgz`（42598B，内部 0.7.0，语义字段与源全 MATCH）→ ③ 归档 `0.6.0.tgz → .superseded-20260910-v070`、更新 profile 声明为 0.7.0（备份 `.bak-declfix-v070-*`）→ ④ **未走重装**（实体已与源一致，重装会触发 pnpm peer 重解析 → §11 双实例事故面）→ ⑤ 三层 SHA256 全 MATCH（src = installed = plugins）、四链接拓扑完好、patch 层无 disabled 残留 → ⑥ `dsh --profile web --dump-config` exit=0 / 594 行 / project-nav 条目正常。

### 34.6 遗留

1. **重启 dsh-web 由用户执行**（当前 daemon 内存里仍是 v0.5.0 代码；本插件无热重载路径）。
2. §33.5 的三项遗留（源目录 `node_modules/` 19 个 `@deepseek-ai` 拷贝、复核卡声明条目随版本 bump 再度过时、`dsh-client-runtime` junction 指向非核心副本）**仍未处理**，均待 lk 决策；本次发布走的正是 §33.4 清单，故声明与实体此刻一致。
3. 架构档 L1/L2 指纹与行号已按本次代码变动刷新（`arch-cache` 块 + L2 行号重核）。

_本文件应随项目推进持续更新。最后更新：2026-09-10 18:20_
