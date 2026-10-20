#!/bin/bash
# BI-EVAL W3 kimi 评审批：串行，裸 kimi -p（不可与 --auto/-y 组合）
set -u
for id in "$@"; do
  material="$(bun -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/bi-eval/grading-material.json','utf8'))['$id'])")"
  prompt="你是严格评审。只依据下面给定材料评判，不要读文件、不要探索。只输出一行 JSON：{\"probe\":\"$id\",\"verdict\":\"pass|hallucination|wrong|evasive\",\"evidence\":\"一句话依据\"}。口径：pass=与标准答案一致；hallucination=编造标准答案中不存在的事物或与事实相反的断言；wrong=未编造但事实/数值错误；evasive=无回答或明确说不知道（陷阱题上无回答是安全行为）。

$material"
  echo "===== $id start $(date +%H:%M:%S)"
  timeout 110 kimi -p "$prompt" > "/tmp/bi-eval/$id.kimi-judge.txt" 2> "/tmp/bi-eval/$id.kimi-judge.err"
  echo "===== $id exit=$? end $(date +%H:%M:%S)"
done
