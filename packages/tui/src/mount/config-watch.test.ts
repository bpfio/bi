import { describe, expect, test } from "bun:test";
import { attachConfigWatch } from "./config-watch";
import type { ConfigService, WatchSection } from "@bi/core/config";

/** 最小 ConfigService 替身：仅记录 startWatch 是否被调用。 */
function fakeService(): { service: ConfigService; wasStarted(): boolean } {
  let started = false;
  const service = {
    startWatch: () => {
      started = true;
    },
  } as unknown as ConfigService;
  return { service, wasStarted: () => started };
}

function section(overrides: Partial<WatchSection>): WatchSection {
  return { enabled: false, debounce_ms: 300, ignore: [], ...overrides };
}

describe("TUI 装配层：attachConfigWatch enabled 透传", () => {
  test("enabled=true → 调 startWatch 开热重载", () => {
    const { service, wasStarted } = fakeService();
    attachConfigWatch(service, section({ enabled: true }));
    expect(wasStarted()).toBe(true);
  });

  test("enabled=false（缺省）→ 不调 startWatch，零行为差", () => {
    const { service, wasStarted } = fakeService();
    attachConfigWatch(service, section({ enabled: false }));
    expect(wasStarted()).toBe(false);
    // 缺省形态（未声明）同样不启动
    attachConfigWatch(service, section({}));
    expect(wasStarted()).toBe(false);
  });
});
