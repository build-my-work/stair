# Claude / GLM 交叉讨论与主审裁决

本轮不是把两个模型的建议合并成清单。流程为独立专项阅读、整库架构阅读、交换双方结论与主审复现、对错误方案继续反驳、再收敛。最终依据是当前源码和受控实验；模型数量、语气和“达成共识”不增加事实置信度。

调用通过本地 Pi CLI / magpie 路由完成。Claude 标识为 `claude/claude-opus-5-5`，GLM 标识为 `zcode/GLM-5.3`。读取阶段限制为 read/grep/find/ls，后续讨论无工具。所有原稿都声明未执行产品实验；五个复现由主审运行。

**讨论后的决策**

| 议题 | 初始意见与分歧 | 主审验证及最终取舍 |
| --- | --- | --- |
| SessionManager 从哪里拆 | Claude 先抽 getOrCreateAgent 的装配；GLM 先抽四个协作服务，首先搬计划状态机 | 已复现问题在协议与归属。先封住鉴权、回合与计划业务入口；暂不搬数百行，更不向新 Service 传整个 ManagedSession。Claude 已将装配拆分降级 |
| 前端 Draft/Plan 事件 | GLM 架构稿先建 DraftUiEventBus、PlanApprovalCoordinator；Claude 倾向复用现有 coordinator | 类型化消息不解决顺序。保留 sessionId 寻址的多面板 UI 广播，把提交/恢复步骤收进已有可测试逻辑；服务端拥有计划执行权威状态，不新造总线框架 |
| Text/Drawnix 保存 | GLM 架构稿建议通用 writer，GLM 文件专项则明确反对合并控制器 | 这是两个独立调用之间的真实分歧。Text autosave 已复现；先修故障、明确 flush/conflict/retry/close 行为，以共享场景验收，暂缓通用 writer |
| Workbench 重连 | GLM 找到无 baseline 盲写，但将“重连都会换 clientId”说得过宽 | 短重连可恢复身份。主审复现的是 fresh reconnect 后多窗口布局覆盖。把新读磁盘当旧 baseline 的修复建议被否决；需恢复旧基线/显式差量/重放本地变更 |
| Project 删除与未保存内容 | GLM 建议 reconcile 前 flush/veto 或卸载报错 toast | 源码链成立，未 E2E。删除已落盘后再 flush 可能已无有效项目身份；toast 也不能恢复内容。需要删除前协调，或保留可恢复文档内容 |
| Projects workspace 参数 | GLM 文件稿称授权缺陷，建议所有 handler 统一绑定 ctx | 现有认证是实例级，handshake 可选择 workspace，管理测试允许空 ctx。记录为目标一致性/边界契约问题，未定性为跨租户提权。先区分全局管理与 workspace 绑定 API |
| Pi 缺 turnId 兼容 | 一份中间回复建议缺 id 先接受并计数；Claude 要停止屏障和身份 | 中间建议保留了已复现故障，不采纳。旧协议如必须支持，也须具备同等结算串行保证；否则显式版本协商或重建。后台事件不能盲目贴当前 prompt id |
| 计划单命令的锁范围 | Claude 第一轮表述为锁内准备、回执、send | 主审指出 send 可能重入锁，Claude 收敛稿撤回原表述。锁内完成一致的准备/回执事务，释放后由 executionId 衔接发送/派发，保持现有幂等与停止约束 |
| RPC 类型能解决什么 | GLM 一度将类型契约等同于阻止网关协议漂移 | 类型约束能检验参数/结果，不能证明业务顺序；gateway 直接调用 ISessionManager。必须有完整业务入口和真实宿主契约测试 |
| shared 循环与 WebUI shims | Claude 认为环不值得大改；GLM 建议大改 config 导出 | 环本身未证实崩溃，但浏览器与测试的依赖负担可见。先切 browser-safe 叶子导入和小范围 guard，暂不全量重组 exports。shim 实际混合 throw/no-op/fallback，不能说全部 throw |
| BrowserPaneManager | GLM 将 Toolbar/Telemetry 拆分排得较高 | 已有 CDP/router/ownership 边界可复用。优先级低于已复现问题，后续按功能需要拆完整职责；原生截图与窗口生命周期先保留 |
| legacy 删除 | Claude 提议删除 session-mcp-server | 仓内可达性线索不足以证明外部不调用。仅记录待核实，不做删除，也不列首批重构 |

**收敛后的长期重点**

1. 回合和鉴权归属：agent 内明确谁能接受事件、何时允许新回合、凭据属于哪个连接。
2. 计划执行和输入恢复：服务端收口权威操作，前端收口本地提交/恢复步骤，复用现有 coordinator/journal/reducer。
3. Workbench 多写者同步：让基线、离线变更与重连同步形成完整协议，避免缺少前提时退化成覆盖。
4. 平台依赖和契约：逐步减少 Node 假实现进入浏览器，用小范围类型契约连接调用双方。
5. 文档失败恢复：保存冲突、被动卸载和删除都要保住用户内容；先定义行为，再考虑共享实现。

最终两份收敛稿的前三个长期边界一致。仍有一处程度差异：GLM 认为 DOM 事件常量/类型联合应随 coordinator 收口一起做，Claude 认为可按需要处理。主审建议为本次实际迁移的协议补齐类型，不另外发起全局事件系统改造。两项 P1 优先推进，并为 Pi 保留更充分的故障注入验收；各项独立交付，避免把 bug 修复绑到一次大重构上。

**仍需后续证据**

- Claude 实际 SDK 双连接 spawn/keep-alive 恢复的完整验证。
- Pi 初始化 single-flight 的受控阻塞实验，abort 与 pre-tool/tool 桥的结算实验。
- 原生多窗口项目删除时未保存内容的恢复路径；fresh reconnect 的浏览器/WS E2E。
- WebUI 普通 render error 的真实错误恢复验证。
- 全局管理 API 与当前 workspace API 的契约清单；现有代码不足以把二者一刀切。

这些不确定性不会阻止报告中五项受控复现成立，但限制了对产品发生频率和全流程后果的判断。

**原始评审文本**

下面只保存最终答复，不含内部推理日志。原稿可能包含被上表纠正的说法，不能脱离裁决直接执行。

- [Claude 会话与运行时专项](/Users/zhihu/code/m_code/ai/thinking-agent/docs/code-research/2026-11-16-current-branch-review/reviews/claude-runtime.md)
- [GLM 文件与编辑生命周期专项](/Users/zhihu/code/m_code/ai/thinking-agent/docs/code-research/2026-11-16-current-branch-review/reviews/glm-files.md)
- [Claude 整库架构评估](/Users/zhihu/code/m_code/ai/thinking-agent/docs/code-research/2026-11-16-current-branch-review/reviews/claude-architecture.md)
- [GLM 应用层架构评估](/Users/zhihu/code/m_code/ai/thinking-agent/docs/code-research/2026-11-16-current-branch-review/reviews/glm-architecture.md)
- [Claude 交叉讨论](/Users/zhihu/code/m_code/ai/thinking-agent/docs/code-research/2026-11-16-current-branch-review/reviews/claude-discussion.md)
- [Claude 最终纠错与收敛](/Users/zhihu/code/m_code/ai/thinking-agent/docs/code-research/2026-11-16-current-branch-review/reviews/claude-closing.md)
- [GLM 最终纠错与收敛](/Users/zhihu/code/m_code/ai/thinking-agent/docs/code-research/2026-11-16-current-branch-review/reviews/glm-closing.md)

GLM 的一份中间交叉答复误用了 Claude 的自称，已明确指出并要求以 GLM 路由角色重新独立回答；此处采用修正后的收敛稿。模型归属依据实际调用/返回标识，不依据回答中的自称。
