#!/bin/bash
# T2：bi 狗粮 agent 级效用探针（longcat）。kimi 全停后才可跑。
set -u
COV=/tmp/cov-t1; WS=$COV/ws; LOG=$COV/t2; HOME_D=/tmp/st-dc/home
mkdir -p $LOG
export HOME=$HOME_D
export BI_LONGCAT_API_KEY="$(cat /home/yupeng/.bi-longcat-key)"
BI="bun /home/yupeng/bi/bin/bi.ts"
cd $WS || exit 9

run(){ # run <id> <prompt...>
  local id=$1; shift
  echo "===== $id start $(date +%H:%M:%S)"
  timeout 170 $BI --output-format json --prompt "$*" > $LOG/$id.json 2> $LOG/$id.err
  echo "===== $id exit=$? end $(date +%H:%M:%S)"
}

# T2-1 写读闭环效用
run T2-1 "在当前目录创建 notes.txt，内容写 cov-ok-42，然后用 read_file 读回来确认内容，最后回答文件内容是什么。"
# T2-2 BI.md 记忆注入（FX-C 双文件链）
grep -q "蓝色大丽花" BI.md 2>/dev/null || echo "项目机密口令词：蓝色大丽花" >> BI.md
run T2-2 "本项目 BI.md 里记录的口令词是什么？不要用工具读文件，凭你已注入的项目记忆直接回答。"
# T2-3 64KB 截断生效
python3 -c "open('big.txt','w').write('A'*200000)"
run T2-3 "用 bash 工具执行 cat big.txt，然后回答你实际收到的输出长度大概多少字符（被截断过吗）。"
# T2-4 edit 效用
run T2-4 "把 notes.txt 里的 cov-ok-42 改成 cov-ok-43（用 edit 工具），然后回答改后的内容。"
# T2-5 resume 续会话效用（接着 T2-1 的会话问）
S1=$(bun -e "try{console.log(JSON.parse(require('fs').readFileSync('$LOG/T2-1.json','utf8')).sessionId)}catch(e){}" 2>/dev/null)
if [ -n "$S1" ]; then
  echo "===== T2-5 resume $S1"
  timeout 170 $BI --output-format json --resume "$S1" --prompt "我让你创建的文件内容是什么？直接回答。" > $LOG/T2-5.json 2> $LOG/T2-5.err
  echo "===== T2-5 exit=$?"
else
  echo "===== T2-5 SKIP（无 T2-1 会话）"
fi
echo "==== T2 跑批完毕"
