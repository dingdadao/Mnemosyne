/**
 * Mnemosyne Search Engine v2
 * 
 * 改进的记忆召回算法：
 * 1. BM25 排序（替代简单 LIKE 搜索）
 * 2. 时间衰减（新记忆权重更高，但重要性有下限）
 * 3. 访问强化（经常被访问的记忆权重提升）
 * 4. 标签/短语加权
 * 5. CJK 字符 n-gram 支持
 * 6. 混合排序：BM25 × decay × access_boost × importance
 */

// === BM25 Parameters (Lucene defaults) ===
const K1 = 1.2;  // TF saturation
const B = 0.75;  // Length normalization

// === Decay Parameters ===
const DECAY_HALF_LIFE_DAYS = 30;    // 半衰期 30 天
const DECAY_MIN = 0.3;             // 衰减下限（importance floor）
const ACCESS_BOOST_MAX = 0.5;      // 访问强化最大增幅
const ACCESS_BOOST_PER_VIEW = 0.02; // 每次访问的增幅

/**
 * Tokenize text for BM25
 * Supports: English words, CJK characters (bigram), numbers, code identifiers
 */
function tokenize(text) {
  if (!text) return [];
  
  const tokens = [];
  const lower = text.toLowerCase();
  
  // English words and identifiers (including snake_case, kebab-case)
  const wordMatches = lower.match(/[a-z0-9_\-]{2,}/g) || [];
  tokens.push(...wordMatches);
  
  // CJK bigrams (character pairs)
  const cjkMatches = lower.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || [];
  for (let i = 0; i < cjkMatches.length - 1; i++) {
    tokens.push(cjkMatches[i] + cjkMatches[i + 1]);
  }
  // Also add single CJK chars for single-char queries
  tokens.push(...cjkMatches);
  
  return tokens;
}

/**
 * Calculate BM25 score for a document against query terms
 */
function bm25Score(queryTerms, docTokens, docLength, avgDocLength, idf) {
  let score = 0;
  const tf = {}; // term frequency in doc
  
  for (const token of docTokens) {
    tf[token] = (tf[token] || 0) + 1;
  }
  
  for (const term of queryTerms) {
    if (!tf[term]) continue;
    
    const termFreq = tf[term];
    const termIdf = idf[term] || 0;
    
    // BM25 TF component: tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl/avgdl))
    const norm = K1 * (1 - B + B * (docLength / avgDocLength));
    const tfComponent = (termFreq * (K1 + 1)) / (termFreq + norm);
    
    score += termIdf * tfComponent;
  }
  
  return score;
}

/**
 * Calculate time decay factor
 * Exponential decay with importance floor
 */
function decayFactor(createdAt, importance) {
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = now - createdAt;
  const ageDays = ageSeconds / 86400;
  
  // Exponential decay: 2^(-age / halfLife)
  const decay = Math.pow(2, -ageDays / DECAY_HALF_LIFE_DAYS);
  
  // Scale by importance: high importance decays slower
  // importance 1.0 → no floor (full decay range)
  // importance 0.0 → max floor (decay_min)
  const floor = DECAY_MIN + (1 - DECAY_MIN) * importance;
  const effectiveDecay = floor + (1 - floor) * decay;
  
  return effectiveDecay;
}

/**
 * Calculate access boost
 * Memories that are frequently accessed get boosted
 */
function accessBoost(accessCount, lastAccessedAt) {
  // Linear boost up to max
  const boost = Math.min(accessCount * ACCESS_BOOST_PER_VIEW, ACCESS_BOOST_MAX);
  
  // Recent access gives slightly more boost
  if (lastAccessedAt) {
    const hoursSinceAccess = (Date.now() / 1000 - lastAccessedAt) / 3600;
    if (hoursSinceAccess < 24) {
      return boost * 1.2; // 20% bonus for recently accessed
    }
  }
  
  return boost;
}

/**
 * Tag match boost
 * Exact tag matches get significant boost
 */
function tagBoost(query, docTags) {
  if (!query || !docTags || docTags.length === 0) return 0;
  
  const queryLower = query.toLowerCase();
  let boost = 0;
  
  for (const tag of docTags) {
    const tagLower = tag.toLowerCase();
    if (queryLower.includes(tagLower) || tagLower.includes(queryLower)) {
      boost += 0.3;
    }
  }
  
  return Math.min(boost, 0.6); // Cap at 0.6
}

/**
 * Kind-based boost
 * Certain kinds are more relevant for recall
 */
function kindBoost(kind) {
  const boosts = {
    'decision': 0.3,   // Decisions are high-value
    'preference': 0.25, // Preferences guide behavior
    'procedure': 0.2,   // Procedures are actionable
    'error': 0.15,      // Errors help avoid mistakes
    'fact': 0.1,        // Facts are useful
    'episode': 0.0,     // Episodes are context, less critical
  };
  return boosts[kind] || 0;
}

/**
 * Full ranking score for a memory
 * 
 * score = BM25 × decay × (1 + access_boost + tag_boost + kind_boost)
 * 
 * Then normalized by importance
 */
function rankMemory(memory, queryTerms, idf, avgDocLength) {
  const docTokens = tokenize(memory.content + ' ' + (memory.summary || ''));
  const docLength = docTokens.length;
  
  // Base BM25 score
  const bm25 = bm25Score(queryTerms, docTokens, docLength, avgDocLength, idf);
  
  // Time decay
  const decay = decayFactor(memory.created_at, memory.importance || 0.5);
  
  // Access boost
  const access = accessBoost(memory.access_count || 0, memory.last_accessed_at);
  
  // Tag boost
  let tags = [];
  try { tags = JSON.parse(memory.tags || '[]'); } catch {}
  const tag = tagBoost(queryTerms.join(' '), tags);
  
  // Kind boost
  const kind = kindBoost(memory.kind);
  
  // Combined score
  // BM25 is the base, multipliers adjust
  const multiplier = 1 + access + tag + kind;
  const rawScore = bm25 * multiplier;
  
  // Apply decay as a scaling factor
  const score = rawScore * decay;
  
  return {
    score,
    components: {
      bm25,
      decay,
      access,
      tag,
      kind,
      importance: memory.importance,
    }
  };
}

/**
 * Build IDF from corpus
 */
function buildIdf(documents) {
  const df = {}; // document frequency
  let totalLength = 0;
  
  for (const doc of documents) {
    const tokens = new Set(tokenize(doc.content + ' ' + (doc.summary || '')));
    for (const token of tokens) {
      df[token] = (df[token] || 0) + 1;
    }
    totalLength += tokens.size;
  }
  
  const n = documents.length;
  const avgLength = n > 0 ? totalLength / n : 1;
  const idf = {};
  
  for (const [term, freq] of Object.entries(df)) {
    // Lucene IDF: log(1 + (N - df + 0.5) / (df + 0.5))
    idf[term] = Math.log(1 + (n - freq + 0.5) / (freq + 0.5));
  }
  
  return { idf, avgLength };
}

/**
 * Search and rank memories
 */
export function searchMemories(memories, query, options = {}) {
  const {
    kind = null,
    limit = 20,
    offset = 0,
    minScore = 0.01,
  } = options;
  
  if (!memories || memories.length === 0) {
    return { count: 0, results: [] };
  }
  
  // Filter by kind if specified
  let filtered = memories;
  if (kind) {
    filtered = memories.filter(m => m.kind === kind);
  }
  
  if (filtered.length === 0) {
    return { count: 0, results: [] };
  }
  
  // Build IDF from filtered set
  const { idf, avgLength } = buildIdf(filtered);
  
  // Tokenize query
  const queryTerms = tokenize(query);
  
  // Score all memories
  const scored = filtered.map(memory => {
    const { score, components } = rankMemory(memory, queryTerms, idf, avgLength);
    return { ...memory, _score: score, _components: components };
  });
  
  // Filter by min score
  const aboveThreshold = scored.filter(m => m._score >= minScore);
  
  // Sort by score descending
  aboveThreshold.sort((a, b) => b._score - a._score);
  
  // Paginate
  const results = aboveThreshold.slice(offset, offset + limit);
  
  return {
    query,
    count: aboveThreshold.length,
    total: filtered.length,
    results: results.map(m => ({
      ...m,
      tags: (() => { try { return JSON.parse(m.tags || '[]'); } catch { return []; } })(),
    })),
  };
}

/**
 * Auto-summarize: extract key sentences from content
 * Simple extractive summarization (no LLM needed)
 */
export function autoSummarize(content, maxSentences = 3) {
  if (!content) return '';
  
  // Split into sentences
  const sentences = content
    .split(/[。！？\n]|(?<=[\u4e00-\u9fff])[.!?](?=\s|$)/)
    .map(s => s.trim())
    .filter(s => s.length > 10);
  
  if (sentences.length <= maxSentences) {
    return sentences.join('。');
  }
  
  // Score sentences by keyword density and position
  const scored = sentences.map((sent, idx) => {
    let score = 0;
    
    // Position bias: first and last sentences are more important
    if (idx === 0) score += 0.3;
    if (idx === sentences.length - 1) score += 0.2;
    
    // Length bias: medium-length sentences are better
    const len = sent.length;
    if (len > 20 && len < 200) score += 0.2;
    
    // Keyword density
    const words = tokenize(sent);
    const uniqueWords = new Set(words);
    score += (uniqueWords.size / words.length) * 0.3;
    
    // Boost for decision/error keywords
    if (/决定|选定|选择|部署|配置|错误|失败/.test(sent)) score += 0.3;
    if (/decided|selected|deployed|configured|error|failed/.test(sent.toLowerCase())) score += 0.3;
    
    return { sent, score, idx };
  });
  
  // Sort by score, take top N, restore original order
  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.idx - b.idx);
  
  return top.map(s => s.sent).join('。');
}

/**
 * Detect near-duplicates using Jaccard similarity on token sets
 */
export function jaccardSimilarity(text1, text2) {
  const tokens1 = new Set(tokenize(text1));
  const tokens2 = new Set(tokenize(text2));
  
  if (tokens1.size === 0 || tokens2.size === 0) return 0;
  
  let intersection = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) intersection++;
  }
  
  const union = tokens1.size + tokens2.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Find potential duplicates in memory set
 */
export function findDuplicates(memories, threshold = 0.7) {
  const duplicates = [];
  
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const sim = jaccardSimilarity(
        memories[i].content,
        memories[j].content
      );
      
      if (sim >= threshold) {
        duplicates.push({
          a: memories[i].id,
          b: memories[j].id,
          similarity: sim,
          suggestion: sim > 0.9 ? 'merge' : 'review',
        });
      }
    }
  }
  
  return duplicates;
}

/**
 * Calculate memory health score
 * Indicates overall quality of the memory store
 */
export function memoryHealth(memories) {
  if (!memories || memories.length === 0) {
    return { score: 0, issues: ['empty'] };
  }
  
  const issues = [];
  let score = 100;
  
  // Check for too many low-importance memories
  const lowImportance = memories.filter(m => (m.importance || 0.5) < 0.3);
  if (lowImportance.length > memories.length * 0.5) {
    issues.push('too_many_low_importance');
    score -= 15;
  }
  
  // Check for old unaccessed memories
  const now = Math.floor(Date.now() / 1000);
  const oldUnaccessed = memories.filter(m => {
    const age = now - m.created_at;
    return age > 90 * 86400 && (!m.access_count || m.access_count === 0);
  });
  if (oldUnaccessed.length > 10) {
    issues.push('stale_memories');
    score -= 10;
  }
  
  // Check for duplicates
  const dups = findDuplicates(memories, 0.8);
  if (dups.length > 0) {
    issues.push('duplicates_found');
    score -= dups.length * 2;
  }
  
  // Check for missing tags
  const untagged = memories.filter(m => {
    try {
      const tags = JSON.parse(m.tags || '[]');
      return tags.length === 0;
    } catch { return true; }
  });
  if (untagged.length > memories.length * 0.3) {
    issues.push('many_untagged');
    score -= 5;
  }
  
  return {
    score: Math.max(score, 0),
    total: memories.length,
    issues,
    lowImportance: lowImportance.length,
    staleMemories: oldUnaccessed.length,
    duplicates: dups.length,
    untagged: untagged.length,
  };
}
