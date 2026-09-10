# [项目事实] reference · scope 指纹契约 v0.4.0

- 卡类型：reference
- 溯源：shared/index.js + HANDOFF.md §30
- 源会话：session-5634c6bb-93f1-4994-9c26-7f124dedee72
- 工作区：D:\FF\project-nav

nav_mark begin 记录 scope 内每文件 {size,mtime,sha1} 到 a.scopeState（作用域=索引推出文件 ∪ 字面量路径 ∪ glob 展开）；nav_mark done 比对磁盘，报 modified/vanished/appeared 三类并落 a.drift，干净收口回「✓ Scope fingerprint verified」；nav_status 对运行中动作实时显示 DRIFT。语义坑：空 scope=无可比对，不等于全部消失（首版误报 vanished 已修）。粒度仍为文件级，同文件不同函数保守串行。
