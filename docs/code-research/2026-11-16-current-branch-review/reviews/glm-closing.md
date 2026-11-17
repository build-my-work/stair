> 独立评审收敛稿。实际调用标识：zcode/GLM-5.3。主报告的源码与实验裁决优先；不包含内部推理日志。

# 收敛回应（GLM，文件专项评审者）

**角色更正**：我是 GLM。上一轮我误用了“Claude回应GLM”的标题与第一人称，此处更正；Claude 的前五项排序与候选编号是 Claude 的结论，不作为我的立场。我未自行运行任何复现，以下接受/撤回均基于主审 closing-evidence 与我自己的静态读取。

## 接受与撤回

1. **D3（workbench-layout，即第五个已复现 bug）**：接受范围修正——WsRpcServer:475 保留身份匹配且未过期的短重连，仅 :576 fresh connect 发新 UUID；我此前“重连即新 clientId”表述过宽，成立的是过期/服务器重启/身份不可恢复的 fresh reconnect 路径。复现同时证实三分合并本体正确，缺口只在无 baseline 分支。**撤回**“无 baseline 时读 current 作 baseline 再合并”的修复：stale incoming 与 current 的差异无法区分“旧项目未修改”与“用户刚删除”，仍会覆盖。接受替代方向：客户端保留/传递旧 baseline 或 revision、显式 dirty-project 差量，或拒写无 baseline 请求、在 fresh reconnect 后重跑 restore（现 ready 门控不清、onReconnected 不刷 layout）再重放本地变更；验收需补真实浏览器重连 e2e。
2. **D1**：源码路径维持（未复现），但**撤回**“reconcile 裁剪前 flush+veto”作为删除场景的修复——项目已被权威删除，事后 veto 无法恢复授权路径。接受：在 projects.DELETE 增加 Document flush gate（删除前协调）或保留可恢复文档副本；toast 只提示、不恢复内容。
3. **D2**：**撤回**“跨租户提权”定性。实例级 token、handshake 可指定 workspace、现有测试允许 ctx.workspaceId=null，故按“调用者目标一致性/授权边界契约不一致”记录；先界定哪些 API 属全局管理、哪些绑定当前 workspace，再统一对应解析器，不一刀切。
4. **D4**：维持——冲突态 Retry 持旧指纹必再冲突；纳入保存契约测试即可。**撤回**按同构比例抽通用 writer 的提议。
5. **撤回**“缺 turnId 先静默接受+计数”的兼容方案（保留已复现故障）；接受 settling 屏障或显式版本协商/失败重建，兼容旧协议须有同等串行化。另接受：lifecycle lock 内不可重入 sendMessage，计划“准备/回执”事务与 send/dispatch 边界须显式；类型化 RPC 只拦形状漂移、不保业务次序，网关走 ISessionManager 不受益。**撤回** SessionManager 四服务拆分与 DraftUiEventBus 作为第一步。

## 最终前三个长期重构边界

1. **回合与鉴权归属**：PiAgent settling 屏障 + turnId；Claude authEnv 按会话传 env，覆盖全部受管键；不动传输层。
2. **计划+输入恢复协议**：acceptPlanWithCompaction 服务端单入口，lock 内只做 set+回执事务，/compact 发送与 dispatch 在明确的非重入边界外执行；草稿 flush/restore/ACK 收进现有 coordinator；未来搬移只用窄 host（withLifecycleLock / get-setPlanRecord / persist / dispatch）。
3. **Workbench 多写者基线**：客户端 baseline/revision 或 dirty 差量协议，无 baseline 拒写+重同步+重放；与 D1 的删除前文档 gate 同属“多写者/权威变更协调”，一并定义。不造总线、不建通用 writer、不把 ManagedSession 传给新 Service。

## 与 Claude 的剩余分歧

仅一处程度差异：DOM 事件常量+类型联合，Claude 认为可有可无，我认为随 coordinator 收口落地时必须一并落（防再度散落），但仍非独立步骤。“无草稿发起者”回执是否被有意禁止，同意待产品确认。其余（不按行数拆文件、不动 FFI 与回执机制、浏览器依赖用导入 guard 治理）与主审终稿方向一致。