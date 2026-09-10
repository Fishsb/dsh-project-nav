# [项目事实] how-to · project-nav 沙箱兼容改造

- 卡类型：how-to
- 溯源：project-nav 审查 seq37326
- 源会话：session-471aca03-3da2-4078-8dc1-3493071f0953
- 工作区：D:\FF\project-nav

1. shared/index.js 将 node:fs 替换为 ctx.get('fs')；2. host/index.js 移除硬编码 root，改为配置传入；3. 合并 host 与 shared 重复逻辑为单一来源；4. 清理 node_modules 中完整 DSH 副本。
