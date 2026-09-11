# 0.9.0 切换手册（重启 → 迁移 → 验收）

> 装已经装好了（`verify-0.9.0-install.ps1` 10/10 全绿：声明 / 实体 / 全部 13 个源文件逐字节一致）。
> 本文只剩**重启之后**的动作。**重启只能你手动做**（agent 在 GUI 进程内，自行重启会连会话一起带走）。

---

## 0. 重启之前：先做那个不可逆动作的备份

迁移会把 5 个旧账本**移走**（挪进 `.internal/legacy/`，不是删除），所以逻辑上可还原；
但为了少一层依赖，重启前先整目录复制一份：

```powershell
Copy-Item -Recurse 'D:\FF\.internal' 'D:\FF\.internal.bak-pre-090' -Force
```

（`D:\FF` 不是 git 仓，没有版本控制兜底 —— 这一步就是兜底。）

## 1. 重启 dsh-web

重启后**验证生效**（这一步不能跳，装 ≠ 生效）：

- 新会话的工具清单里应是 **6 个**：`nav_graph` / `nav_commit` / `nav_decide` / `nav_node` / `nav_render` / `nav_set`
- 旧版是 11 个（含 `nav_query` / `nav_plan` / `nav_mark` / `nav_update` / `nav_docs` / `nav_map` / `nav_sync_docs` / `nav_status` / `nav_set_vector` / `nav_adr` / `nav_arch`）
- **看到 `nav_query` 等旧名 = 没生效**（进程没真重启，或装配仍是旧副本）

## 2. 迁移（三个动作，顺序固定）

```
nav_graph mode=legacy      # 先看清旧账本全貌（只读，不写任何东西）
nav_node layer=migrate     # 一次性折叠成事件流 + 归档旧账本
nav_render                 # 重建全部投影（PROJECT.md / ARCH-MODEL.md / 地图）
```

### 预期输出（基于对你真实数据的干跑，不是估的）

| 项 | 预期 |
|---|---|
| 事件数 | **100** 条（seq 1…100） |
| 节点 | 4 项目 · 5 模块 · 20 功能 · 14 文档工件 |
| 决策 | **17** 条 ADR |
| 落点 | 80 个文件路径（其中 23 个由"项目相对"补成"根相对"） |
| 在途意图 | **0** —— 6 笔旧"在途"动作没有任何 scope 证据，按设计不迁移（否则是永久孤儿） |
| 真 STALE | **7** 个，全部是 `project-nav/shared/index.js`（0.9.0 已删除该目录） |

迁移会打印**警告**，那是设计的一部分（不静默）。应看到两类：

1. `模块 shoucang/dsh-dev-docs 的成员表引用了功能 SC-S01/SC-S04/DD-D0x，索引里没有它的落点` —— 旧索引本身的不一致，如实报出。
2. `6 个"在途"动作没有任何 scope 证据 → 未迁移为在途意图` —— 原始记录仍在归档的 `nav-actions.json` 里。

那 7 个 STALE 清法：改了登记（`nav_node target=<功能码> set=files=<新路径>`）或退役（`nav_node target=<功能码> retire=true`，仅当该功能确实不存在了）。

## 3. 迁移后的第一次体检

```
nav_graph mode=health
```

应看到：`事件流: 100 事件（seq 连续 ✓）`、`STALE 7`、`在途改动 (0)`、`架构决策: 17 条`。

## 4. 回退（如果需要）

迁移把原件挪进了 `.internal/legacy/`，还原就是挪回来，再把插件装回 0.8.6。

安装器 `install-0.9.0.ps1` 里的产物路径与声明都是**硬编码 0.9.0**，回退时用下面这段（手工三步）：

```powershell
# 4.1 还原旧账本（或用第 0 步的整目录备份直接覆盖 .internal）
Move-Item 'D:\FF\.internal\legacy\nav-index.json'   'D:\FF\.internal\' -Force
Move-Item 'D:\FF\.internal\legacy\vector.json'      'D:\FF\.internal\' -Force
Move-Item 'D:\FF\.internal\legacy\nav-actions.json' 'D:\FF\.internal\' -Force
Move-Item 'D:\FF\.internal\legacy\nav-docs.json'    'D:\FF\.internal\' -Force
Move-Item 'D:\FF\.internal\legacy\nav-arch.json'    'D:\FF\.internal\' -Force

# 4.2 装回 0.8.6（与安装器同法，只是换个产物）
$pd = 'C:\Users\lk\.dsh\profiles\web'
$tgz = 'D:\FF\project-nav\dsh-external-project-nav-0.8.6.tgz'
Move-Item "$pd\node_modules\@dsh-external\project-nav" "$pd\node_modules\@dsh-external\project-nav.0.9.0-off" -Force
$stage = New-Item -ItemType Directory -Path "$pd\node_modules\@dsh-external\stage" -Force
& tar -xzf $tgz -C $stage.FullName
Move-Item "$($stage.FullName)\package" "$pd\node_modules\@dsh-external\project-nav" -Force
Remove-Item -Recurse -Force $stage.FullName
# 4.3 把 profile 声明改回 0.8.6 那条
$pkg = "$pd\package.json"
$t = [System.IO.File]::ReadAllText($pkg, [System.Text.Encoding]::UTF8)
$t = $t -replace 'dsh-external-project-nav-0\.9\.0\.tgz','dsh-external-project-nav-0.8.6.tgz'
[System.IO.File]::WriteAllText($pkg, $t, (New-Object System.Text.UTF8Encoding($false)))
# 4.4 重启
```

⚠ **两版不能混用**：0.9.0 不读旧账本，0.8.6 不读事件流。切换期间以"哪一版在跑"为准。

## 5. 还没做的一件事（不急，但别忘）

`D:\FF\.gitignore` 目前没有三层数据面的规则。`D:\FF` 现在不是 git 仓，所以不影响迁移；
但你哪天在那里 `git init`，就会把 `.internal/runtime/` 一起提交。规则见 `AGENTS.md` §7。

---

**本手册对应的产物**：`dsh-external-project-nav-0.9.0.tgz`
SHA256 `9A7FAF772CD2FC44299746B0EEEBE007DB0E8D41D35CA5F01D420FAF57644385`
（与已装实体逐字节一致 —— 由 `verify-0.9.0-install.ps1` 证明）

---

## 6. 后续版本（0.9.1 起）

`install-0.9.0.ps1` / `verify-0.9.0-install.ps1` 里的产物名与版本判据都是**硬编码 0.9.0** 的，
拿它们装新版会在自证环节报「实体版本 = 0.9.0，不是…」而假失败。每个版本各带一套同名脚本：

| 版本 | 安装 | 校验（只读） |
|---|---|---|
| 0.9.2 | `install-0.9.2.ps1` | `verify-0.9.2-install.ps1` |
| 0.9.1 | `install-0.9.1.ps1` | `verify-0.9.1-install.ps1` |
| 0.9.0 | `install-0.9.0.ps1` | `verify-0.9.0-install.ps1` |

流程不变（与 0.9.0 那套完全同形）：

```powershell
npm pack --cache .npm-cache                                    # 出 tgz
powershell -NoProfile -ExecutionPolicy Bypass -File install-0.9.2.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File verify-0.9.2-install.ps1   # 独立复验，10 项全绿
# 重启 dsh-web（只能你手动做）
```

> ⚠ 两个坑（0.9.1 发布时实测踩到，别再踩）：
> ① 含非 ASCII 的 `.ps1` **必须存成 UTF-8 with BOM**——PS 5.1 读无 BOM 的会按 GBK 解码，
> 全角标点会吃掉字符串终结符，报 `Unexpected token '}'`。
> ② 改脚本里的版本号时，**判据也要一起改**：`($decl -like '*0.9.0*')` 只改文案不改判据 = 永久假失败。

