/** @bi/a2a —— A2A 域：Agent-to-Agent 协议互通与多智能体协作接入。 */
export const DESCRIPTION = "A2A 域：Agent-to-Agent 协议互通与多智能体协作接入。";

/** BI-15.3 · L2 协议层鉴权面：HMAC-SHA256 封套签名与五步验证。 */
export * from "./auth";

/** BI-15.3 · L3 授权面：角色能力矩阵与高危动作分类。 */
export * from "./permissions";

/** BI-16 · Python 沙箱代码运行即验与 Traceback 自愈（RULE-BI-02 落地门）。 */
export * from "./audit";

/** BI-16.1 · 零依赖内存精算沙箱 CodeMode：node:vm 纯计算运行器（接缝③：零工具注入，工具绑定归 BI-16.2）。 */
export * from "./codemode/vm-runner";

/** BI-16.1 · 精算批量限流顺序池（v1：promise 队列并发上限，真 worker 线程并行归后续卡）。 */
export * from "./codemode/worker-pool";
