#!/bin/bash
# T1-A：CLI 生态全覆盖 G1-G9（伪端点驱动，零模型零网络）
set -u
COV=/tmp/cov-t1; HOME_D=$COV/home; HOME2=$COV/home2; WS=$COV/ws; LOG=$COV/logs
PASS=0; FAIL=0; declare -a FAILED
ok(){ echo "PASS $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL $1 —— $2"; FAIL=$((FAIL+1)); FAILED+=("$1"); }
BI="bun /home/yupeng/bi/bin/bi.ts"

rm -rf $HOME_D $HOME2; mkdir -p $HOME_D/.bi $HOME2 $WS
mkdir -p $HOME_D/.bi
cat > $HOME_D/.bi/config.toml << 'CFG'
[providers.entries.fake]
api_key_env = "BI_COV_KEY"
base_url = "PLACEHOLDER"
kind = "anthropic"
models = ["fake-1"]

[providers]
default = "fake"

[models]
default = "main"

[models.entries.main]
provider = "fake"
model = "fake-1"

[ptc]
enabled = true
CFG
export HOME=$HOME_D
export BI_COV_KEY=dummy
cd $WS || exit 9

# 伪端点守护
nohup bun $COV/fake-daemon.ts 46531 > $LOG/fake-daemon.log 2>&1 &
FAKE_PID=$!
echo $FAKE_PID > $COV/fake.pid
for i in $(seq 1 20); do [ -s $LOG/fake-url ] && break; sleep 0.3; done
FAKE_URL=$(cat $LOG/fake-url 2>/dev/null)
[ -z "$FAKE_URL" ] && { echo "FATAL fake endpoint not up"; kill -9 $FAKE_PID; exit 9; }
sed -i "s|PLACEHOLDER|$FAKE_URL|" $HOME_D/.bi/config.toml
echo "fake=$FAKE_URL pid=$FAKE_PID"

# G1 help/version 面
H="$($BI --help 2>&1)"; MISS=""
for c in init session fork export transfer acp upgrade doctor vis config copy query a2a plugins worktree dag; do
  echo "$H" | grep -q " $c " || MISS="$MISS $c"
done
[ -z "$MISS" ] && ok "G1a --help 含 16 子命令" || bad "G1a" "help 缺:$MISS"
V="$($BI --version 2>&1 | tail -1 | grep -o '[0-9][0-9.]*$')"
PKG=$(grep '"version"' /home/yupeng/bi/package.json | head -1 | grep -o '[0-9][0-9.]*')
[ "$V" = "$PKG" ] && ok "G1b --version=$V 与 package.json 一致" || bad "G1b" "version=$V pkg=$PKG"

# G2 init
cd $COV && mkdir -p fresh-ws && cd fresh-ws
$BI init > $LOG/init.log 2>&1; E=$?
[ $E -eq 0 ] && [ -f .bi/local.toml ] && [ -f BI.md ] && ok "G2a init 产 local.toml+BI.md" || bad "G2a" "exit=$E"
$BI init >> $LOG/init.log 2>&1; E=$?
[ $E -eq 0 ] && ok "G2b init 重跑幂等" || bad "G2b" "exit=$E"
cd $WS

# G3 造 2 个伪会话 + session list + fork
$BI --prompt "hello alpha" > $LOG/s1.json 2>$LOG/s1.err; E1=$?
$BI --prompt "hello beta"  > $LOG/s2.json 2>$LOG/s2.err; E2=$?
[ $E1 -eq 0 ] && [ $E2 -eq 0 ] && ok "G3a 伪端点两连会话 exit=0" || bad "G3a" "exit=$E1/$E2"
SLIST="$($BI session 2>&1)"
N=$(echo "$SLIST" | grep -c '"sessionId"\|session_')
[ "$N" -ge 2 ] && ok "G3b session list ≥2 行" || bad "G3b" "list=$N 行"
SID=$(echo "$SLIST" | head -1 | grep -o '[0-9a-f-]\{36\}' | head -1)
NID=$($BI export "$SID" --format json --out $LOG/fork-src.json > /dev/null 2>&1; grep -o '"nodeId": "[^"]*"' $LOG/fork-src.json 2>/dev/null | head -1 | cut -d'"' -f4)
if [ -z "$NID" ]; then NID=$(grep -o '"id": "[^"]*"' $LOG/fork-src.json 2>/dev/null | head -1 | cut -d'"' -f4); fi
#echo "DBG SID=[$SID] NID=[$NID] json_exists=$(ls -la $LOG/fork-src.json 2>&1 | awk '{print $5}')"
#echo "DBG first-id=$(grep -o '"id": "[^"]*"' $LOG/fork-src.json 2>/dev/null | head -1)"
FORK_OUT="$($BI fork "$SID" "$NID" 2>&1)"; E=$?
echo "$FORK_OUT" | grep -q '[0-9a-f-]\{36\}' && [ $E -eq 0 ] && ok "G3c fork $SID@$NID 出新会话" || bad "G3c" "exit=$E nid=$NID out=$(echo "$FORK_OUT" | tail -1 | head -c 80)"

# G4 export 三格式
for f in markdown json html; do
  $BI export "$SID" --format $f --out $LOG/exp.$f > $LOG/exp-$f.log 2>&1; E=$?
  [ $E -eq 0 ] && [ -s $LOG/exp.$f ] && ok "G4 export $f 非空" || bad "G4-$f" "exit=$E size=$(stat -c%s $LOG/exp.$f 2>/dev/null)"
done

# G5 transfer 导出→新 HOME 导入
$BI transfer export --sanitize "$SID" --out $LOG/arch.json > $LOG/tr.log 2>&1; E=$?
[ $E -eq 0 ] && [ -s $LOG/arch.json ] && ok "G5a transfer export 脱敏归档非空" || bad "G5a" "exit=$E"
HOME=$HOME2 $BI transfer import $LOG/arch.json > $LOG/ti.log 2>&1; E=$?
N2=$(HOME=$HOME2 $BI session 2>/dev/null | grep -c '"sessionId"\|session_')
[ $E -eq 0 ] && [ "$N2" -ge 1 ] && ok "G5b import 到新 HOME 会话可见($N2)" || bad "G5b" "exit=$E n2=$N2"
SAME="$($BI transfer import $LOG/arch.json 2>&1)"; E=$?
[ $E -ne 0 ] && ok "G5c 同 HOME 重复导入结构化拒(exit=$E)" || bad "G5c" "重复导入未拒 exit=$E"

# G6 copy（stdout 降级面）
COUT="$($BI copy "$SID" --field title 2>&1)"; E=$?
[ $E -eq 0 ] && [ -n "$COUT" ] && ok "G6 copy 字段出 stdout" || bad "G6" "exit=$E out=$(echo "$COUT" | head -c 60)"

# G7 query 检索 + 坏过滤
Q="$($BI query "contains:hello" --limit 5 2>/dev/null)"; E=$?
NH=$(echo "$Q" | grep -c '"sessionId"\|nodeId')
[ $E -eq 0 ] && [ "$NH" -ge 2 ] && ok "G7a query 命中 $NH 行" || bad "G7a" "exit=$E hits=$NH"
$BI query "bogus~~~ &&&" --limit 5 > /dev/null 2>&1; E=$?
[ $E -eq 2 ] && ok "G7b 坏过滤表达式 exit=2" || bad "G7b" "exit=$E（期望 2）"

# G8 config 往返
$BI config set session.max_rounds 16 > /dev/null 2>&1
GV="$($BI config get session.max_rounds 2>/dev/null | tail -1)"
[ "$GV" = "16" ] && ok "G8a config set/get session.max_rounds=16" || bad "G8a" "get=$GV"
$BI config set nope.key 1 > /dev/null 2>&1; E=$?
[ $E -ne 0 ] && ok "G8b 未知键结构化拒" || bad "G8b" "未知键未拒"
NK=$($BI config list 2>/dev/null | grep -c "=")
[ "$NK" = "70" ] && ok "G8c config list 70 键" || bad "G8c" "list=$NK"

# G9 doctor（结构化、无栈）
$BI doctor > $LOG/doctor.log 2>&1; E=$?
if grep -q "    at " $LOG/doctor.log; then bad "G9 doctor" "出现原始栈"; else ok "G9 doctor 结构化收场 exit=$E"; fi

kill -9 $FAKE_PID 2>/dev/null
echo "==== T1-A 总结: PASS=$PASS FAIL=$FAIL ${FAILED[*]:-}"
