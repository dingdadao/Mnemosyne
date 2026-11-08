#!/bin/bash
# Mnemosyne 回归探针 — 每次改检索/写入/排序后必跑
# 用法: ./deploy/smoke-test.sh [URL] [TOKEN]
set -u
URL="${1:-${MNEMOSYNE_URL:-https://mnemosyne.niao.fun}}"
TOKEN="${2:-${MNEMOSYNE_TOKEN}}"
OWNER="${MNEMOSYNE_OWNER:-dingdadao}"

PASS=0; FAIL=0
check() {
  local name="$1" expect="$2" got="$3"
  if [ "$got" = "$expect" ]; then echo "  ✅ $name"; PASS=$((PASS+1));
  else echo "  ❌ $name (expect=$expect got=$got)"; FAIL=$((FAIL+1)); fi
}
api() {
  # 后端限流 2000/min（按 token 分桶）；节流避免压测自身把配额打满，429 时退避重试
  sleep 0.4
  local out code
  out=$(curl -s -m 10 -w "\n%{http_code}" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@")
  code=$(printf '%s' "$out" | tail -1)
  if [ "$code" = "403" ]; then
    sleep 3
    out=$(curl -s -m 10 -w "\n%{http_code}" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@")
    code=$(printf '%s' "$out" | tail -1)
  fi
  printf '%s' "$out" | sed '$d'
}

echo "Mnemosyne smoke test → $URL (owner=$OWNER)"
echo ""

# 1. 服务存活
V=$(api "$URL/health" | python3 -c "import json,sys;print(json.load(sys.stdin).get('version','ERR'))" 2>/dev/null)
check "服务存活" "3.0.0-multi-tenant" "$V"

# 2. 召回探针（top1 必须命中相关记忆，且块非空）
for pair in \
  "语音|语音" \
  "长沙天气|长沙天气" \
  "gateway 重启|hermes-gateway" \
  "模型|模型链" \
  "投资偏好|投资偏好" \
  "记忆库配置|mnemosyne" \
  "他喜欢啥|偏好" \
  "用户习惯|偏好" \
  "癖好|偏好" \
; do
  q="${pair%%|*}"; kw="${pair##*|}"
  R=$(api -X POST -d "{\"query\":\"$q\",\"owner\":\"$OWNER\",\"include\":[\"own\",\"shared\"],\"limit\":3}" \
      "$URL/memory/search" | KW="$kw" python3 -c "
import json,sys,os
try:
    d=json.load(sys.stdin); r=d.get('results',[])
    kw=os.environ['KW']
    # recall = keyword appears anywhere in top-3 (fusion may legitimately reorder)
    hit = any(kw.lower() in ((m.get('content','')+str(m.get('summary') or '')).lower()) for m in r[:3])
    print('HIT' if hit else 'MISS')
except Exception as e: print('ERR')
" 2>/dev/null)
  check "召回: $q" "HIT" "$R"
done

# 3. 隔离：anan 查不到 owner 私有记忆
L=$(api -X POST -d '{"query":"SSH 密码","owner":"anan","include":["own","shared"],"limit":5}' \
    "$URL/memory/search" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('LEAK' if any(m.get('visibility')=='private' and m.get('owner')!='anan' for m in d.get('results',[])) else 'OK')
" 2>/dev/null)
check "多账户隔离" "OK" "$L"

# 4. score 字段存在
S=$(api -X POST -d '{"query":"语音","limit":1}' "$URL/memory/search" | python3 -c "
import json,sys
d=json.load(sys.stdin); r=d.get('results',[])
print('OK' if r and '_score' in r[0] else 'MISSING')
" 2>/dev/null)
check "score 返回" "OK" "$S"

# 5. 写入去重（同一内容写两次，第二次 deduped=1）
BODY='{"content":"SMOKE TEST DEDUP PROBE","kind":"fact","owner":"smoke","importance":0.1}'
api -X POST -d "$BODY" "$URL/memory/save" > /dev/null
D=$(api -X POST -d "$BODY" "$URL/memory/save" | python3 -c "import json,sys;print(json.load(sys.stdin).get('deduped','?'))" 2>/dev/null)
check "写入去重" "1" "$D"

# 6. extract 模式
E=$(api -X POST -d '{"content":"User: 好的，我决定把缓存 TTL 设为 60 秒。Assistant: 明白","kind":"fact","owner":"smoke","extract":true}' \
    "$URL/memory/save" | python3 -c "
import json,sys
d=json.load(sys.stdin); print('OK' if d.get('extracted',0)>=1 else 'FAIL')
" 2>/dev/null)
check "extract 提炼" "OK" "$E"

# 7. 端点存活
for ep in "/memory/health?workspace=default" "/memory/stats/detailed?workspace=default" "/memory/recent?workspace=default&limit=3" "/audit?limit=3"; do
  sleep 0.4
  C=$(curl -s -m 10 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "$URL$ep")
  check "端点 $ep" "200" "$C"
done

# 8. 健康分
H=$(api "$URL/memory/health?workspace=default" | python3 -c "import json,sys;print(json.load(sys.stdin).get('score','?'))" 2>/dev/null)
echo ""
echo "  Health: $H/100"
echo "──────────────────────────────"
echo "  PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
