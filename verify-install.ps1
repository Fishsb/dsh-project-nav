# verify-install.ps1 — 独立校验安装面（**只读**，重启前就能跑）
#
# ⚠ 版本无关：版本号与产物名都从本仓 package.json 派生 —— 不再"每版一份脚本"。
#
# 与 install.ps1 的自证**不重复**：那份在装的过程中顺带验，这份是事后独立复核，
# 而且刻意不依赖安装脚本的任何中间状态 —— 只读磁盘现状。
#
# 校验五件事（⚠ 真跑输出是**六段** —— 见下方 ④b）：
#   ① 声明面：profile 的 dependencies 指向本版产物
#   ② 实体面：node_modules 里那份的版本与结构正确
#   ③ 一致面：树 = 包 = 装（仓库源码 / tarball 内清单 / 安装实体 三方对得上）
#   ④ 架构面：当前架构的能力锚点在位、已删机制确实不在位
#   ④b 同源面（**④ 的元判据，不是第六类**）：install.ps1 与 verify-install.ps1 的进包面派生式
#      必须逐字同源 —— ④ 判「能力在不在位」，④b 判「两处判据有没有各自漂移」。
#      ⚠ 它比 ①–⑤ 晚一步补上，故标题仍写"五件事"（①–⑤ 是对外口径，不重编号）；
#        但**核验时请按输出段数（六段）对照，不要只数 ①–⑤** —— 漏掉 ④b 就漏掉了
#        「两处脚本分叉」这个唯一会静默的失效面。
#   ⑤ 运行时面：对安装实体做加载 + 真跑（verify-runtime.mjs）
#      —— 为什么要有这一级：静态校验只能证明**字节对得上**。打包错误、缺依赖、
#         导出被改名、语法在目标 Node 上不合法 —— 静态全看不见。静态对得上 ≠ 能加载。
#
# ⚠ 本脚本与 verify-runtime.mjs **都不进 tgz**（package.json 的 files 只有
#   host/core/三份契约），所以改它们不产生"树 ≠ 装"漂移、不需要重打包。
#   反过来：**任何进包的文件（core/ host/ *.md）在安装后被改，③ 就会报红** ——
#   那是设计内信号（提示重新 pack+install），不是故障。实测抓到过一次。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File D:\FF\project-nav\verify-install.ps1
#      （可加 -ProfileDir <路径>；默认 web）

param(
  [string]$ProfileDir = 'C:\Users\lk\.dsh\profiles\web'
)

$ErrorActionPreference = 'Stop'

$RepoDir    = 'D:\FF\project-nav'
$ProfilePkg = Join-Path $ProfileDir 'package.json'
$Dest       = Join-Path $ProfileDir 'node_modules\@dsh-external\project-nav'

$script:problems = 0
function Ok($msg)   { Write-Host "  [ OK ] $msg" -ForegroundColor Green }
function Bad($msg)  { Write-Host "  [FAIL] $msg" -ForegroundColor Red; $script:problems++ }
function Note($msg) { Write-Host "         $msg" -ForegroundColor DarkGray }

function ReadUtf8($p) { [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) }
function Sha256($p)   { (Get-FileHash $p -Algorithm SHA256).Hash }

# ---- 版本：单一来源（package.json） ----
$repoJson = ReadUtf8 (Join-Path $RepoDir 'package.json') | ConvertFrom-Json
$WantVer  = $repoJson.version
$Tgz      = Join-Path $RepoDir "dsh-external-project-nav-$WantVer.tgz"

Write-Host ''
Write-Host "verify-install — profile: $ProfileDir   目标版本: v$WantVer" -ForegroundColor Cyan

# ---------- ① 声明面 ----------
Write-Host '① 声明面'
if (-not (Test-Path $ProfilePkg)) { Bad "找不到 profile 声明: $ProfilePkg" }
else {
  $decl = [regex]::Match((ReadUtf8 $ProfilePkg), '"@dsh-external/project-nav"\s*:\s*"([^"]*)"')
  if (-not $decl.Success) { Bad '声明里没有 @dsh-external/project-nav' }
  else {
    Note "声明 = $($decl.Groups[1].Value)"
    if ($decl.Groups[1].Value -match [regex]::Escape($WantVer)) { Ok "声明指向 v$WantVer" }
    else { Bad "声明不是 v$WantVer —— 重启后仍会加载旧版" }
  }
}

# ---------- ② 实体面 ----------
Write-Host '② 实体面'
if (-not (Test-Path (Join-Path $Dest 'package.json'))) { Bad "实体不存在: $Dest（先跑 install.ps1）" }
else {
  $ip = ReadUtf8 (Join-Path $Dest 'package.json') | ConvertFrom-Json
  if ($ip.version -eq $WantVer) { Ok "实体版本 = v$WantVer" } else { Bad "实体版本 = $($ip.version)，期望 $WantVer" }

  # ⚠ 进包面 = package.json 的 files[] 展开 + npm 的「始终包含」成员。后者按 npm 规则
  # **结构性发现**（package.json 自身 · 声明里的 main 文件 · 包根的 README* / LICENSE* / LICENCE*），
  # 不写死名字 —— 这类文件无视 files[] 一律进包，实测本仓产物 16 个成员 = files[] 的 14 + README.md + LICENSE。
  # 派生式与 install.ps1 **逐字同源**（那段被下面的 PACK-FACE 标记包住；
  # 本文件末段有机检：两段的规范化文本必须一致 —— 改一处不改另一处立刻红）。
  # <<<PACK-FACE-DERIVATION>>>
  $pkgDecl   = [System.IO.File]::ReadAllText((Join-Path $RepoDir 'package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $wantFiles = @()
  foreach ($top in @($pkgDecl.files)) {
    $src = Join-Path $RepoDir $top
    if (-not (Test-Path $src)) { continue }
    if (Test-Path $src -PathType Container) {
      foreach ($f in (Get-ChildItem $src -Recurse -File)) { $wantFiles += ($f.FullName.Substring($RepoDir.Length + 1) -replace '\\','/') }
    } elseif ($wantFiles -notcontains ($top -replace '\\','/')) { $wantFiles += ($top -replace '\\','/') }
  }
  $impNames = @('package.json')
  if ($pkgDecl.main) { $impNames += ($pkgDecl.main -replace '^\./','') }
  foreach ($imp in $impNames) {
    $impN = $imp -replace '\\','/'
    if ((Test-Path (Join-Path $RepoDir $imp)) -and ($wantFiles -notcontains $impN)) { $wantFiles += $impN }
  }
  foreach ($pat in @('README*','LICENSE*','LICENCE*')) {
    foreach ($f in (Get-ChildItem $RepoDir -File -Filter $pat)) { if ($wantFiles -notcontains $f.Name) { $wantFiles += $f.Name } }
  }
  $wantFiles = @($wantFiles | Sort-Object -Unique)
  # <<<END-PACK-FACE-DERIVATION>>>
  $missing = @()
  foreach ($f in $wantFiles) {
    if (-not (Test-Path (Join-Path $Dest $f))) { $missing += $f }
  }
  if ($missing.Count -eq 0) { Ok "实体结构完整（进包面派生出的 $($wantFiles.Count) 个文件全在）" }
  else { Bad ('实体缺: ' + ($missing -join ', ')) }
}

# ---------- ③ 一致面：树 = 包 = 装 ----------
Write-Host '③ 一致面（树 = 包 = 装）'
if (-not (Test-Path $Tgz)) { Bad "找不到产物: $Tgz" }
else {
  Note "产物 SHA256 = $(Sha256 $Tgz)"

  # 包 vs 装：整包解一次到临时目录再逐文件比（Windows tar 逐成员取件不可靠，别用）
  $listed = & tar -tzf $Tgz
  if ($LASTEXITCODE -ne 0) { Bad "tar 读取产物失败（退出码 $LASTEXITCODE）" }
  else {
    $members = $listed | Where-Object { $_ -like 'package/*' } | Where-Object { $_ -ne 'package/' }
    $tmp = Join-Path $env:TEMP ("pnverify-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    & tar -xzf $Tgz -C $tmp 2>$null
    $pkgRoot = Join-Path $tmp 'package'
    if (-not (Test-Path $pkgRoot)) { Bad "解包后找不到 package/"; Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    else {
      $diff = @(); $diffSrc = @()
      foreach ($member in $members) {
        $rel = $member.Substring(8)
        $a = Join-Path $pkgRoot ($rel -replace '/','\')
        $b = Join-Path $Dest ($rel -replace '/','\')
        $s = Join-Path $RepoDir ($rel -replace '/','\')
        if (-not (Test-Path $a)) { $diff += "包缺 $rel"; continue }
        if (-not (Test-Path $b)) { $diff += "实体缺 $rel"; continue }
        if ((Sha256 $a) -ne (Sha256 $b)) { $diff += "内容不一致 $rel" }
        if (Test-Path $s) { if ((Sha256 $s) -ne (Sha256 $a)) { $diffSrc += $rel } }
      }
      if ($diffSrc.Count -eq 0) { Ok '树 = 包（仓库源码与产物逐字节一致）' }
      else { Bad ('仓库与产物不一致（忘了 repack？）: ' + ($diffSrc -join ', ')) }
      if ($diff.Count -eq 0) { Ok "包 = 装（$($members.Count) 个文件逐字节一致）" } else { Bad ('包与装不一致: ' + ($diff -join '; ')) }
      Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
  }
}

# ---------- ④ 架构面（能力锚点 + 已删机制） ----------
Write-Host '④ 架构面（能力锚点 + 已删机制）'

# ⚠ 去注释：本节**唯一**口径 —— 三处判据共用同一份结果，不各写各的
#   （各写各的正是"两处判据各自飘移"：本节三处曾各带一份 -replace，措辞还不一致）。
#   ① 块注释 /* … */（可跨行）→ 空格
#   ② **任何位置**的 `//` 到行尾 → 删
#      ⚠ 旧版是 `(?m)^\s*//.*$`（**只吃整行注释**），而 ④ 的能力锚点判据更彻底：它打在
#        `ReadUtf8 $p` **原文**上、连注释都不剥 ⇒ 一行注释就能把已删能力"签收"成在位。
#        本仓 core/scope.js 的 stripComments 早有正确形态（任何位置 `//`，但保留 `:` 后的 URL），此处对齐它。
#   ③ 保留 `:` 之后的 `//`（URL，如 https://）
# ⚠ **口径声明**（供 test/ 侧对齐，那一侧归另一席）：本侧 = 「**任意位置** `//`」，不是「只整行 `//`」。
$StripComments = {
  param([string]$t)
  $t = [regex]::Replace($t, '(?s)/\*.*?\*/', ' ')
  [regex]::Replace($t, '([^:]|^)//[^\n]*', '$1')
}

# 进包源码清单 —— **派生**（不写死文件名）：实体 core/ 下全部 .js + host/index.js。
# 旧版把文件写死在每一条 `@{ f=… }` 里 ⇒ 新增模块默认不在判定面内（同族残留）。
$packedSources = @()
$coreJsDir = Join-Path $Dest 'core'
if (Test-Path $coreJsDir) {
  foreach ($f in (Get-ChildItem $coreJsDir -File -Filter *.js -ErrorAction SilentlyContinue)) { $packedSources += $f.FullName }
}
if (Test-Path (Join-Path $Dest 'host\index.js')) { $packedSources += (Join-Path $Dest 'host\index.js') }

# 去注释后的代码按路径缓存 —— 下面所有判据都打在这上面（不再有第二份剥注释实现）
$codeOf = @{}
foreach ($f in $packedSources) { $codeOf[$f] = & $StripComments (ReadUtf8 $f) }

# ── 派生集合 ①定义面：实体里 export 出来的名字（含 `export const X = (…) => …`，如 nodeId）
$defNames = @()
foreach ($f in $packedSources) {
  $c = $codeOf[$f]
  foreach ($m in [regex]::Matches($c, 'export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)')) { $defNames += $m.Groups[1].Value }
  foreach ($m in [regex]::Matches($c, 'export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)')) { $defNames += $m.Groups[1].Value }
  foreach ($m in [regex]::Matches($c, 'export\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)')) { $defNames += $m.Groups[1].Value }
}
$defNames = @($defNames | Sort-Object -Unique)

# ── 派生集合 ②消费面：**相对 import** 的具名绑定（去 `as` 别名）
#   ⚠ 只收 `from './…'` / `from '../…'` —— 外部包（node:fs、@deepseek-ai/…）的具名绑定
#     本来就不在本包导出面里，收进来会造出一堆**假红**（实测踩到：19 个 node: 内建名被误报悬空）。
$imported = @()
foreach ($f in $packedSources) {
  foreach ($m in [regex]::Matches($codeOf[$f], "import\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\s*,\s*)?\{([^}]*)\}\s*from\s*'(\.\.?/[^']+)'")) {
    foreach ($piece in ($m.Groups[1].Value -split ',')) {
      $t = $piece.Trim()
      if (-not $t) { continue }
      if ($t -match '^(.+?)\s+as\s+.+$') { $imported += $Matches[1].Trim() }
      elseif ($t -match '^[A-Za-z_$][A-Za-z0-9_$]*$') { $imported += $t }
    }
  }
}
$imported = @($imported | Sort-Object -Unique)

# ── 全解析落空 ⇒ 必须报 FAIL（空集与空集比较**恒真** —— 本仓判例「空扫不得判绿」）
if ($packedSources.Count -eq 0) {
  Bad '进包源码面为空（实体里既无 core/*.js 也无 host/index.js）—— ④ 的判定面无从派生，不许静默通过'
} elseif ($defNames.Count -eq 0) {
  Bad '导出面解析出空集 —— 判据无从生效（空集与空集比较恒真），不许静默通过'
} else {
  # B1 悬空引用：import 了却没人 export（**改名不改 import 必红**）
  $dangling = @($imported | Where-Object { $defNames -notcontains $_ })
  if ($dangling.Count -eq 0) { Ok "导出面自洽：$($defNames.Count) 个导出 · $($imported.Count) 个具名 import 全部有定义（无悬空引用）" }
  else { Bad ('悬空引用（import 了却没有该导出）: ' + ($dangling -join ', ')) }

  # B2 只读信号（**不判红**）：从未被 import 消费的导出 —— 新增能力在输出里可见（同 ARCHITECTURE §10 手法）
  $unconsumed = @($defNames | Where-Object { $imported -notcontains $_ })
  Note "只读信号 · 未被 import 消费的导出 $($unconsumed.Count) 个（含仅模块内调用者，不判红）: $($unconsumed -join ', ')"

  # ── C 对外能力锚点（8 条）：**只给名字** —— 文件归属与 `export function` 前缀都交给派生面判，
  #     所以「注释里留名」与「换文件」都骗不过它（旧版打在原文上，前者必骗过）。
  $capExport = @(
    @{ n='scanImports';    msg='scanImports 在位（依赖图数据源）' },
    @{ n='isTestPath';     msg='isTestPath 在位（告警闸纪律）' },
    @{ n='impactOf';       msg='impactOf 在位（文件精度影响面）' },
    @{ n='impactGate';     msg='impactGate 在位（第七闸）' },
    @{ n='filePressure';   msg='filePressure 在位（文件职责只读信号）' },
    @{ n='foldOnly';       msg='foldOnly 在位（在场层廉价路径：纯事件流折叠）' },
    @{ n='renderPresence'; msg='renderPresence 在位（在场层文本成形）' },
    @{ n='renderTreeText'; msg='renderTreeText 在位（按需渲染保留）' }
  )
  foreach ($c in $capExport) {
    if ($defNames -notcontains $c.n) { Bad "对外能力缺失：$($c.n)（派生导出面里没有这个名字）" }
    else { Ok $c.msg }
  }

  # ── D 私有实现 / 装配片段**留痕**（6 条）
  #     ⚠ **分辨力声明**：这一档不是"机检能力面"。它只证明「去注释后的代码里还有这个名字」；
  #     私有实现改名后若同步改了这里，判据**不会自己发现** —— 其同步性来自**人工维护**，不假装是机检。
  #     之所以仍去注释后判：旧版打在原文上，一行注释就能把它签收（红队实测）。
  $capPrivate = @(
    @{ f='core\scope.js'; s='function isCodeFile';            msg='isCodeFile 留痕（.d.ts 排除）' },
    @{ f='core\model.js'; s='function buildEdges';            msg='buildEdges 留痕（磁盘实况层）' },
    @{ f='core\model.js'; s='function projectDirsOf';         msg='projectDirsOf 留痕（扫描边界）' },
    @{ f='core\model.js'; s='function isPatchRecord';         msg='isPatchRecord 留痕（计数闸只数真补丁）' },
    @{ f='host\index.js'; s='systemPrompt.section(';          msg='在场层装配片段留痕（治理每轮注入）' },
    @{ f='core\model.js'; s='const direct = model.nodes.get'; msg='锚点归一完整节点 id 片段留痕（0.10.2 修）' }
  )
  foreach ($c in $capPrivate) {
    $p = Join-Path $Dest $c.f
    if (-not (Test-Path $p)) { Bad "缺文件 $($c.f)"; continue }
    if ($codeOf[$p] -match [regex]::Escape($c.s)) { Ok ($c.msg + '（分辨力=人工同步）') }
    else { Bad ("留痕缺失：$($c.s) —— $($c.msg)") }
  }
}
foreach ($gone in @('core\legacy.js')) {
  if (Test-Path (Join-Path $Dest $gone)) { Bad "$gone 仍在 —— 已删机制不该存在" } else { Ok "$gone 已消失（迁移器随换代删除）" }
}
if (Test-Path (Join-Path $Dest 'core\render.js')) {
  if ((ReadUtf8 (Join-Path $Dest 'core\render.js')) -match 'stampArchDoc|listArchDocs|parseArchCache') { Bad 'core/render.js 仍带架构档指纹机制' }
  else { Ok '架构档指纹/新鲜度机制已移除（§2 降级为投影）' }
  # 0.12.0 换代：落盘投影出口必须不在位（留存即回退 —— "先落盘再注入"等于把删掉的投影换个名字加回来）
  # ⚠ 同样先去注释：render.js 的头注会点名这些出口（说明它们为何退场）。
  # ⚠ 剥注释走**本节唯一口径** $codeOf（上面 $StripComments），不在此另写一份。
  $renderCode = $codeOf[(Join-Path $Dest 'core\render.js')]
  $fallen = @('renderAll','renderModelDoc','renderMapHtml','writeProjectSection','MARK_START') | Where-Object { $renderCode -match [regex]::Escape($_) }
  if ($fallen.Count -eq 0) { Ok '落盘投影出口已退场（render.js 零写盘）' } else { Bad ('落盘投影出口仍在: ' + ($fallen -join ', ')) }
}
if (Test-Path (Join-Path $Dest 'host\index.js')) {
  # ⚠ 去注释后判：host 头注与在场层注释会提到 nav_render（历史叙述）。
  $hostCode = $codeOf[(Join-Path $Dest 'host\index.js')]
  if ($hostCode -match "name: 'nav_render'") { Bad 'host 仍注册 nav_render —— 工具面应为 5' }
  else { Ok 'nav_render 已退场（工具面 = 5）' }
}
if (Test-Path (Join-Path $Dest 'core\paths.js')) {
  # ⚠ 判据必须是**结构派生的**，不能是名字名单（2026-09-25 修 · 本项根因）。
  # 旧版写的是 `-match 'PROJECT_DOC|MODEL_DOC'` —— 它只能守住写它那一刻想到的两个名字：
  # 任何**别的**平面常量（新增的、残留的、改名的）它一律看不见，而那两个名字一旦不在，
  # 它反而恒绿。实测（2026-09-25）：往 core/paths.js 注入 `PLANE.LEGACY` 后旧判据照样报 OK
  # —— 一道"数据面 = 2 层"的判据，在数据面真的变成 3 层时给不出任何信号。
  # 现判据 = **三个派生集合两两求差**，不含任何平面常量名、也不写死层数：
  #   ① 定义面：core/paths.js 里 PLANE 字面量的顶层键（怎么增删都跟着动）
  #   ② 消费面：安装实体内**全部**打包源码里出现的 `PLANE.<键>`（不写死文件名）
  #   ③ 契约面：ARCHITECTURE §3 表格列出的层路径（去尾斜杠后比）
  # 三个集合**必须同时逐键相等**：这才同时说明「每个常量都被真的消费」（不留永不再写的承诺，
  # 也拦住悬空引用）与「层数与契约一致」。层数不写死在判据里 —— 它由契约 §3 的表格行数**派生**，
  # 所以换代（3 层 → 2 层）时改的是契约，判据自己跟着动，不需要人记得来改这里。
  # ⚠ 去注释后再判 —— 头注里写着这些常量名（说明它们为何退场），
  # 直接 grep 整份源码会打到注释 ⇒ 假红。判据要打在**代码**上，不能打在说明文字上。
  # ⚠ 剥注释走**本节唯一口径** $StripComments（与上面 $codeOf 同一份实现，不另写一份）。
  $pathsCode = & $StripComments (ReadUtf8 (Join-Path $Dest 'core\paths.js'))
  $pLines = $pathsCode -split "`n"
  $pStart = -1
  for ($i = 0; $i -lt $pLines.Count; $i++) { if ($pLines[$i] -match 'export const PLANE\s*=\s*\{') { $pStart = $i; break } }
  $defKeys = @(); $defVals = @()
  if ($pStart -ge 0) {
    for ($i = $pStart + 1; $i -lt $pLines.Count; $i++) {
      if ($pLines[$i] -match '^\s*\}') { break }
      $km = [regex]::Match($pLines[$i], "^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'([^']*)'")
      if ($km.Success) { $defKeys += $km.Groups[1].Value; $defVals += $km.Groups[2].Value.TrimEnd('/') }
    }
  }
  $defKeys = @($defKeys | Sort-Object -Unique)
  $defVals = @($defVals | Sort-Object -Unique)

  $consumed = @()
  $packedSrc = @()
  $packedSrc += (Get-ChildItem (Join-Path $Dest 'core') -File -Filter *.js -ErrorAction SilentlyContinue)
  if (Test-Path (Join-Path $Dest 'host\index.js')) { $packedSrc += (Get-Item (Join-Path $Dest 'host\index.js')) }
  foreach ($f in $packedSrc) {
    # ⚠ 剥注释同样走本节唯一口径 $StripComments（无第二份实现 —— 分叉正是本处要修的）
    $c = & $StripComments (ReadUtf8 $f.FullName)
    foreach ($mm in [regex]::Matches($c, 'PLANE\.([A-Za-z_][A-Za-z0-9_]*)')) { $consumed += $mm.Groups[1].Value }
  }
  $consumed = @($consumed | Sort-Object -Unique)

  $archSrc = ReadUtf8 (Join-Path $Dest 'ARCHITECTURE.md')
  $sec3 = ($archSrc -split "\n(?=## )") | Where-Object { $_ -match '^## 3\.' } | Select-Object -First 1
  $contract = @()
  if ($sec3) {
    foreach ($r in [regex]::Matches($sec3, '(?m)^\|\s*\*\*[^|]+\*\*\s*\|\s*`([^`]+)`')) { $contract += $r.Groups[1].Value.TrimEnd('/') }
  }
  $contract = @($contract | Sort-Object -Unique)

  # ⚠ 三层解析任一落空都报 FAIL（解析失败必须响，不许静默通过 —— 静默通过正是本项要修的病）。
  if ($defKeys.Count -eq 0) {
    Bad 'core/paths.js 解析不出 PLANE 平面常量 —— 判据无从派生（解析失败必须报错，不许静默通过）'
  } elseif (-not $sec3) {
    Bad 'ARCHITECTURE §3 解析不出数据面表格 —— 契约面判据无从派生'
  } elseif ($contract.Count -eq 0) {
    Bad 'ARCHITECTURE §3 表格里解析不出层路径 —— 契约面判据无从派生'
  } else {
    # 层数从契约 §3 **派生**（不写死）—— 换代时改契约，判据自己跟着动
    $want = $contract.Count
    $unconsumed = @($defKeys | Where-Object { $consumed -notcontains $_ })
    $dangling   = @($consumed | Where-Object { $defKeys -notcontains $_ })
    $miss       = @($contract | Where-Object { $defVals -notcontains $_ })
    $extra      = @($defVals | Where-Object { $contract -notcontains $_ })
    $okKeys = ($unconsumed.Count -eq 0) -and ($dangling.Count -eq 0)
    $okVals = ($miss.Count -eq 0) -and ($extra.Count -eq 0)
    $okCount = ($defKeys.Count -eq $want) -and ($defVals.Count -eq $want)
    if ($okKeys -and $okVals -and $okCount) {
      Ok "数据面 = $want 层：定义面/消费面/契约 §3 三集合逐键相等（$($defKeys -join ' / ')）"
    } else {
      if (-not $okKeys) {
        Bad ("平面常量 定义面 ≠ 消费面：定义了却零消费 [$($unconsumed -join ', ')]；被引用却未定义 [$($dangling -join ', ')]（不留永不再写的承诺，也不许悬空引用）")
      }
      if (-not $okVals) {
        Bad ("契约 §3 与 PLANE 取值不一致：契约有而 PLANE 无 [$($miss -join ', ')]；PLANE 有而契约无 [$($extra -join ', ')]")
      }
      if (-not $okCount) {
        Bad ("层数不一致：契约 §3 列出 $want 层，PLANE 定义 $($defKeys.Count) 个常量 / $($defVals.Count) 个取值 —— 数据面层数必须由契约与源码同时给出同一个答案")
      }
    }
  }
}

# ---------- ④b 同源面：进包面派生式必须两处逐字一致 ----------
#
# ⚠ 为什么这条本身也要机检（2026-09-25）：② 与 install.ps1 的自证**都**从进包面派生，
# 而「两处从同一来源派生」如果只靠人记得同步改，就是**同一根因换个地方复现** ——
# 实测本项的病正是如此：verify-install 侧 16 个、install 侧 14 个，差 README/LICENSE，
# 于是 install.ps1 宣布「安装完成且自证通过」而 verify-install.ps1 同状态报红。
# 判据 = 把两份脚本里被标记包住的那段代码**规范化后逐字比对**（不写任何文件名）。
Write-Host '④b 同源面（install.ps1 与 verify-install.ps1 的进包面派生式必须同源）'
$selfSrc = ReadUtf8 $PSCommandPath
$instSrc = ReadUtf8 (Join-Path $RepoDir 'install.ps1')
function DerivationBlock($text) {
  # ⚠ 匹配前先清掉**注释行**：说明文字里可能出现标记字样（本文件上方就解释过它），
  # 那会让非贪婪匹配从错误的位置起跳 —— 实测踩到（两侧行数 20 vs 23）。
  # ⚠ 但标记行本身也是 `#` 注释 ⇒ 含标记的行必须留下，否则标记被剥掉、判据反而不生效（实测踩到）。
  $code = ($text -split "`n" | Where-Object { ($_.Trim() -notmatch '^#') -or ($_.Trim() -match 'PACK-FACE') }) -join "`n"
  $m = [regex]::Match($code, '(?s)<<<PACK-FACE-DERIVATION>>>(.*?)<<<END-PACK-FACE-DERIVATION>>>')
  if (-not $m.Success) { return $null }
  # 规范化：去掉行首缩进、空行与标记行 —— 同一段代码在两个脚本里处于不同嵌套深度
  $lines = $m.Groups[1].Value -split "`n" | ForEach-Object { $_.Trim() } |
    Where-Object { $_ -ne '' -and $_ -notmatch 'PACK-FACE' }
  return ($lines -join "`n")
}
$bSelf = DerivationBlock $selfSrc
$bInst = DerivationBlock $instSrc
if (-not ($bSelf -and $bInst)) {
  Bad '进包面派生式未同时出现在两个脚本里（标记 <<<PACK-FACE-DERIVATION>>> 缺失）—— 同源判据无从生效，不许静默通过'
} elseif ($bSelf -ne $bInst) {
  Bad 'install.ps1 与 verify-install.ps1 的进包面派生式**已分叉** —— 两处必须逐字同源（改一处就得改另一处，否则自证面与校验面各说各话）'
} else {
  Ok "进包面派生式两处同源（$((($bSelf -split "`n").Count)) 行规范化文本逐字一致）"
}

# ---------- ⑤ 运行时面（静态对得上 ≠ 能加载） ----------
Write-Host '⑤ 运行时面（对安装实体做加载 + 真跑）'
$runtime = Join-Path $RepoDir 'verify-runtime.mjs'
if (-not (Test-Path $runtime)) { Bad "找不到运行时校验: $runtime" }
else {
  # ⚠ ⑤ 必须**自足**：本机 node 不在 PATH 上（实测裸 "& node" => CommandNotFoundException），
  # 那样这一级会**死在起点** —— 唯一能判"能不能加载"的一级永远给不出结论。
  # 三级解析；全都落空就报 FAIL（静默跳过 = 假绿，本仓记过的形态）。
  $NodeExe = $null
  # (1) 显式指定：$env:NODE_EXE
  if ($env:NODE_EXE -and (Test-Path $env:NODE_EXE)) { $NodeExe = $env:NODE_EXE }
  # (2) 本机已知路径
  if (-not $NodeExe) {
    foreach ($cand in @('C:\Users\lk\.dsh-win\node\node.exe')) {
      if (-not $NodeExe -and $cand -and (Test-Path $cand)) { $NodeExe = $cand }
    }
  }
  # (3) 退回 PATH 上的 node
  if (-not $NodeExe) {
    $cmdNode = Get-Command node -ErrorAction SilentlyContinue
    if ($cmdNode) { $NodeExe = $cmdNode.Source }
  }

  if (-not $NodeExe) {
    Bad '找不到 node —— ⑤ 运行时面**未验**（不是通过）：本机 node 不在 PATH，已知路径也没有'
    Note '办法：设 $env:NODE_EXE=<node.exe 绝对路径>（本机 = C:\Users\lk\.dsh-win\node\node.exe）后重跑'
  }
  else {
    Note "node = $NodeExe"
    & $NodeExe $runtime $Dest
    if ($LASTEXITCODE -eq 0) { Ok '运行时冒烟通过（安装实体可加载、可运行、契约完整）' }
    else { Bad "运行时冒烟未通过（退出码 $LASTEXITCODE）—— 见上方明细" }
  }
}

# ---------- 汇总 ----------
Write-Host ''
if ($script:problems -eq 0) {
  Write-Host "=== 全部通过（v$WantVer）：重启 dsh-web 即生效 ===" -ForegroundColor Green
  Write-Host '  重启后自检：nav_graph mode=health 不应出现「架构档」段；' -ForegroundColor DarkGray
  Write-Host '              nav_graph mode=impact target=core/model.js 应给出「我引用谁 / 谁引用我」。' -ForegroundColor DarkGray
  exit 0
} else {
  Write-Host "=== $($script:problems) 项未通过：**先别重启** ===" -ForegroundColor Red
  exit 1
}
