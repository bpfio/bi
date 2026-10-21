/**
 * TUI 启动装配面：[watch] 三键接线枢纽。
 *
 * `enabled`（缺省 false）仅作启动开关——为 true 时开启 ConfigService 文件监听
 * 热重载；为 false（缺省）零行为差。startWatch 内部已对 tui.toml 走 reloadTui、
 * 对其余文件走 reload，配置盘改即热生效，无需此处再挂回调。
 *
 * 边界（钉死）：仅管启动开关；启动后增删 [watch] 键经 reload/reloadTui 本身
 * 生效/失效不做。
 */
import type { ConfigService, WatchSection } from "@bi/core/config";

/** 按 [watch].enabled 透传启停配置热重载（enabled=false 时零行为差）。 */
export function attachConfigWatch(service: ConfigService, watch: WatchSection): void {
  if (watch.enabled) service.startWatch();
}
