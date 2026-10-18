#!/usr/bin/env bun
/**
 * bi 可执行入口（BI-23.1：替换 build-bin.ts 的临时 VERSION 占位 entry）。
 */
import { runBi } from "../packages/core/src/cli/main";

process.exitCode = await runBi(process.argv.slice(2));
