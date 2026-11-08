/**
 * Mnemosyne 中文同义词表 (v3.3-B)
 *
 * 纯规则、零依赖、零内存常驻。补齐 BM25 + CJK bigram 唯一补不了的缺口：
 * 字面完全不同但语义相同的查询（"他喜欢啥" vs 存储里的"偏好"）。
 *
 * 表是扁平分组：同组任意词命中即把整组作为扩展词加入检索 token 集。
 * 只用于「查询侧」扩展，不改存储、不改原文。
 */

// 每组是一簇可互换的口语/书面表达。刻意保持小而精，避免扩展噪声。
export const SYNONYM_GROUPS = [
  // 偏好 / 习惯
  ['偏好', '喜欢', '喜好', '习惯', '癖好', '钟爱', '爱好', '爱', '中意', '倾向', '口味'],
  // 天气 / 气象
  ['天气', '气象', '预报', '气温', '降雨', '下雨', '晴朗'],
  // 推送 / 发送
  ['推送', '发送', '发', '通知', '提醒', '播报', '推'],
  // 模型 / 大模型
  ['模型', '大模型', 'llm', '主力模型', '降级链', '模型链'],
  // 部署 / 上线
  ['部署', '上线', '发布', '安装', '搭建', '配置', '落地', 'run'],
  // 服务器 / 主机 / 网关
  ['服务器', '主机', '机器', '节点', '网关', 'gateway', 'service', '服务'],
  // 重启 / 重载
  ['重启', '重载', 'restart', 'reload', '刷新'],
  // 错误 / 失败 / 修复
  ['错误', '失败', '报错', '异常', '故障', 'error', 'fail', '修复', '解决', '排查'],
  // 密钥 / 凭据 / 账号
  ['密码', '口令', '密钥', '凭据', '凭证', '账号', '账户', 'token', 'key', '认证', '登录', '凭据库'],
  // 语音 / 音色
  ['语音', '声音', '音色', 'tts', '合成', '朗读', '播报'],
  // 投资 / 股票
  ['投资', '股票', 'a股', '炒股', '板块', '仓位', '短线', '长线'],
  // 记忆 / 知识库
  ['记忆', '记忆库', '知识库', 'mnemosyne', '召回', '检索', '查询'],
  // 时间 / 定时
  ['定时', '每天', '早上', '7:20', '计划', 'cron', '周期', '推送时间'],
  // 偏好风格
  ['简短', '简洁', '直给', '强硬', '风格', '语气', '格式'],
  // 用户 / 人
  ['用户', '他', '她', '丁大刀', '大刀哥', 'owner', '账户'],
];

// 建索引：词 -> 组 id
const wordToGroup = new Map();
SYNONYM_GROUPS.forEach((g, i) => g.forEach(w => wordToGroup.set(w.toLowerCase(), i)));

/**
 * 对查询做同义扩展，返回额外的 token 集合。
 * 只扩展「查询里真实出现过的词」所在的组，且每组最多贡献 3 个词，防止膨胀。
 */
export function expandQuery(query) {
  const q = String(query || '').toLowerCase();
  const hits = new Set();
  for (const [w, gid] of wordToGroup) {
    if (q.includes(w)) hits.add(gid);
  }
  const extra = new Set();
  for (const gid of hits) {
    const group = SYNONYM_GROUPS[gid];
    let added = 0;
    for (const w of group) {
      if (added >= 3) break;
      if (!q.includes(w)) { extra.add(w); added++; }
    }
  }
  return [...extra];
}

/**
 * 字符 n-gram 相似度：查询与文档共享的 CJK 二元组 / 英文词比例。
 * 作为「第二个排序器」参与 RRF，和 BM25  genuinely 不同。
 */
export function charNgramSimilarity(query, text) {
  const grams = (s) => {
    const out = new Set();
    const cjk = (s.toLowerCase().match(/[\u4e00-\u9fff]/g) || []).join('');
    for (let i = 0; i < cjk.length - 1; i++) out.add(cjk.slice(i, i + 2));
    for (const w of s.toLowerCase().match(/[a-z0-9_-]{2,}/g) || []) out.add(w);
    return out;
  };
  const a = grams(query), b = grams(text);
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / a.size;
}
