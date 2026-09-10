# [项目事实] reference · 沙箱改造 vs 文件锁冲突

- 卡类型：reference
- 溯源：HANDOFF.md §30.6
- 源会话：session-5634c6bb-93f1-4994-9c26-7f124dedee72
- 工作区：D:\FF\project-nav

docs/devref 沙箱兼容改造要求 shared/index.js 改用 ctx.get('fs')，而账本文件锁与指纹快照重度依赖 node:fs（openSync/rmSync/statSync/readFileSync/readdirSync/node:crypto）：目标不冲突、载体冲突。建议先做 fs 能力注入；若拿不到独占创建能力，锁必须显式降级告警（进程内锁 + 陈旧检测），禁止静默退化。scope 之外的 git 写操作串行化属元冲突，待单独决策。
