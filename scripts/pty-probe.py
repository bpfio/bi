#!/usr/bin/env python3
"""BI-26.4 —— pty 真人面探针(常驻测试资产)。

在真实伪终端(可设窗口尺寸)里驱动一个命令,发送按键序列,捕获全部输出字节。
由 scripts/pty-repl.test.ts 包装调用(bun test 门控 BI_PTY_E2E=1);也可手动运行:

    python3 scripts/pty-probe.py --rows 40 --cols 100 --keys $'hello\r' -- bun bin/bi.ts

输出:子进程在 pty 中的全部原始字节(含 ANSI 转义)打到 stdout,末尾一行
"---exit=<code>"。无 python3/pty 环境时由包装方跳过。
"""

import argparse
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", type=int, default=40)
    parser.add_argument("--cols", type=int, default=100)
    parser.add_argument("--boot-wait", type=float, default=1.5, help="启动静默窗口秒数")
    parser.add_argument("--key-wait", type=float, default=0.5, help="每批按键后等待秒数")
    parser.add_argument("--tail-wait", type=float, default=1.0, help="收尾等待秒数")
    parser.add_argument("--keys", default="", help="发送的字节序列(支持 \\r \\n \\x1b 转义)")
    parser.add_argument("cmd", nargs=argparse.REMAINDER, help="-- 之后的命令与参数")
    args = parser.parse_args()

    cmd = args.cmd
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        print("no command", file=sys.stderr)
        return 2

    keys = args.keys.encode().decode("unicode_escape").encode("utf-8")

    pid, fd = pty.fork()
    if pid == 0:
        os.environ.setdefault("TERM", "xterm-256color")
        os.execvp(cmd[0], cmd)
        os._exit(127)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", args.rows, args.cols, 0, 0))

    out = b""
    exit_code = None

    def drain(seconds: float) -> None:
        nonlocal out, exit_code
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try:
                    chunk = os.read(fd, 65536)
                    if chunk == b"":
                        break
                    out += chunk
                except OSError:
                    break
            done, status = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                exit_code = os.waitstatus_to_exitcode(status)
                return

    drain(args.boot_wait)
    for i in range(len(keys)):
        os.write(fd, keys[i : i + 1])
        drain(args.key_wait)
    drain(args.tail_wait)

    if exit_code is None:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            _, status = os.waitpid(pid, 0)
            exit_code = os.waitstatus_to_exitcode(status)
        except ChildProcessError:
            exit_code = -1

    sys.stdout.buffer.write(out)
    sys.stdout.buffer.write(f"\n---exit={exit_code}\n".encode())
    return 0


if __name__ == "__main__":
    sys.exit(main())
