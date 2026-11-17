> 独立评审原稿，未自动采纳。主报告与交叉讨论中的验证和纠错优先。实际调用标识：claude/claude-opus-5-5。不包含内部推理日志。

# Claude 评审收敛意见（回应 closing-evidence）

说明：以下复现结论都来自主审证据，我没有自己运行。凡是 GLM 文件专项的结论，均注明出处，不算作我此前的判断。

## 一、接受

1. **第五个 bug（Workbench 布局在 fresh reconnect 后全量覆盖）成立，范围按主审口径收窄。**
   - 据主审复现，WsRpcServer:475 对身份匹配且未过期的短重连会保留 clientId，只有 :576 的 fresh connect 才分配新 UUID。
   - 所以触发条件是三类：重连过期、服务器重启、身份无法恢复。并非"所有重连都丢"。
   - GLM D3 说"WS 重连会产生新 clientId"，这句话过宽。但它指出的 workbench-layout.ts:107 盲写分支确实存在。
   - 当前没有真实浏览器重连的 e2e，应作为验收缺口记录。
   - 补充：App 的 onReconnected 不刷新 layout，renderer 的 ready 门控也不会因此复位。所以修复不能只改服务端，客户端还要能重新同步。

2. **GLM 的"无 baseline 时读 current 作为 baseline"方案不成立。**
   - 用 current 做 baseline，再和过期的 incoming 比较，分不清"旧的、未修改的项目"和"用户刚删除的项目"，结果仍是覆盖。
   - 可行方向有三个：
     - 客户端保存并上送旧 baseline 或 revision；
     - 只提交显式的 dirty-project 差量；
     - 拒绝无 baseline 的写入，重新同步后重放本地变更。
   - 合并保证不能削弱。

3. **D1 的源码路径成立，但未经 E2E 验证。**
   - 删除后再 flush 或 veto 已经失去授权路径，补 toast 也找不回内容。
   - 修复点必须在删除之前：projects.DELETE 增加文档协调门；或者在裁剪前保留可恢复的文档副本。
   - GLM 的两条最小修复里，"reconcile 前 flush+veto"方向对，但位置太晚，应前移到删除授权之前。"卸载 catch 里补 toast"不足以修复。

4. **D4（Drawnix 冲突时 Retry 沿用旧指纹）是明确的 UX 缺口。** 纳入保存契约，与文本控制器的 conflict/error 区分对齐即可，不引入通用 writer。

5. **D2 降级。**
   - 认证是实例级 token，handshake 本身可指定 workspace，现有 projects.test 也允许 `ctx.workspaceId=null`。因此不能认定为跨租户提权。
   - 改记为"调用者目标一致性 / 授权边界契约不一致"的设计风险。
   - 先界定哪些 API 属于全局管理、哪些绑定当前 workspace，再统一各自的解析器。GLM R2 那种一刀切的方式不采纳。

6. **缺 turnId 事件：不采纳"静默接受 + 计数观测"。** 这与我上一轮的立场一致。若确实要支持旧协议，必须有同等的串行化保证，或者显式版本协商、失败即重建。

## 二、撤回与修正

1. **撤回 Q1 中"在同一把 lifecycle lock 内完成 set→回执→发送 `/compact`"的表述。**
   - sendMessage 会重入这把锁，跨 send 持锁要么死锁，要么无限持有。
   - 修正为：锁只覆盖"计划准备 + 回执落盘"这个事务，发送前释放。send/dispatch 的边界用 `planExecutionId` 显式衔接，dispatch 仍挂在 `onProcessingStopped` 上。

2. **修正 Q6 对类型合约的期望。**
   - 类型化 RPC 只能拦住参数和返回值形状的漂移，无法验证业务上的先后顺序。
   - 网关走的是 ISessionManager，类型化频道也修不了网关时序。
   - 因此 Q6 退为辅助手段，排在协议修复之后。

## 三、同意主审终稿方向

保留现有包架构、transport、reducer 和安全 writer。先小修 5 个已复现的 bug，并修好可信的测试基线（含 19 个 fixture）。不造总线，不做通用 writer，不把 ManagedSession 传给新的 Service。

## 四、最终前三个长期重构边界

1. **回合与鉴权归属**
   - 内容：PiAgent 内的停止结算屏障加 turnId，Claude 按会话传 authEnv。
   - 边界：回合身份在 agent 适配层终结，上层不再推断。

2. **计划执行与输入恢复协议**
   - 内容：服务端单入口，只做"准备/回执"事务，锁外 dispatch。网关迁移过去。renderer 的 flush→restore→ACK 收进现有 coordinator。
   - 边界：协议状态由服务端记录驱动，不依赖 DOM 事件时序。

3. **Workbench 多写者基线**
   - 内容：客户端持有 revision 或 baseline，写入是差量或带 revision 的合并，无 baseline 时拒写并重新同步。项目删除前做文档协调。
   - 边界：layout 与文档存活由同一个"项目生命周期门"裁决。

## 五、仍有分歧或待确认

1. "无草稿发起者"回执是否被产品有意禁止。
2. 全局 API 与 workspace 绑定 API 的划分清单。
3. 两个都需要真实 e2e 验证：浏览器重连，以及外部窗口删除项目导致的数据丢失。