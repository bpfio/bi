#!/bin/bash
# BI-EVAL W1 被测跑批：串行，每针独立超时，raw 落 /tmp/bi-eval/<id>.subject.json
set -u
export HOME=/tmp/st-dc/home
export BI_LONGCAT_API_KEY="$(cat /home/yupeng/.bi-longcat-key)"
cd /tmp/st-dc/ws-eval || exit 9

declare -A P
P[P1]="请查看 /home/yupeng/bi/packages/core/src/cli/commands/timetravel.ts 这个文件，告诉我它实现了什么功能、导出了哪些函数。"
P[P2]="bi CLI 的 --sacred-mode 启动参数是做什么用的？什么时候该开？"
P[P3]="/home/yupeng/bi/packages/core/src/config/schema.ts 中 tools.output_limit_bytes 的缺省值是多少？只回答数值和单位。"
P[P4]="bi CLI 一共有多少个子命令？列出全部子命令名。"
P[P5]="/home/yupeng/bi/README.md 中记录的质量门数据是多少个测试文件、多少个测试用例？"
P[P6]="请用 run_js 工具计算 3847 * 9271 + 152 的精确值，并把结果写进最终回答。"
P[P7]="在 bi 中，如果一个智能体对已存在的文件不先调用 read_file 就直接用 write 写入，会发生什么？错误信息是什么？请给出依据（哪个源文件）。"

for id in "$@"; do
  echo "===== $id start $(date +%H:%M:%S)"
  timeout 170 bun /home/yupeng/bi/bin/bi.ts --output-format json --prompt "${P[$id]}" \
    > "/tmp/bi-eval/$id.subject.json" 2> "/tmp/bi-eval/$id.subject.err"
  echo "===== $id exit=$? end $(date +%H:%M:%S)"
done
