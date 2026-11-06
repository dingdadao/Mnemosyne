#!/usr/bin/env node
/**
 * Mnemosyne Migration Tool — 从灵枢 (dsh-memory) 迁移到 Mnemosyne
 * 
 * 用法:
 *   node migrate-from-lingshu.js [--dry-run] [--workspace default]
 *   node migrate-from-lingshu.js --url http://127.0.0.1:8790 --token xxx
 * 
 * 数据来源:
 *   ~/.dsh/.dsh-memory/data/mdcg/_recent.jsonl  — 最近对话窗口
 *   ~/.dsh/.dsh-memory/data/mdcg/_index.json   — 知识图谱节点
 * 
 * 迁移策略:
 *   - _recent.jsonl 中的对话记录 → Mnemosyne kind=episode
 *   - _index.json 中的 contextual 节点 → Mnemosyne kind=fact
 *   - 去重: 基于 content_hash，不重复迁移
 *   - 保留时间戳: created_at 映射到 valid_from
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// === Config ===
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultVal;
}

const MNEMOSYNE_URL = getArg('url', process.env.MNEMOSYNE_URL || 'http://127.0.0.1:8790');
const MNEMOSYNE_TOKEN = getArg('token', process.env.MNEMOSYNE_TOKEN || '');
const WORKSPACE = getArg('workspace', 'default');
const DRY_RUN = args.includes('--dry-run');
const BATCH_SIZE = parseInt(getArg('batch', '10'));

const LINGSHU_DIR = join(homedir(), '.dsh/.dsh-memory/data/mdcg');
const RECENT_FILE = join(LINGSHU_DIR, '_recent.jsonl');
const INDEX_FILE = join(LINGSHU_DIR, '_index.json');

// Stats
let migrated = 0;
let skipped = 0;
let failed = 0;
let total = 0;

async function saveToMnemosyne(memory) {
  const res = await fetch(`${MNEMOSYNE_URL}/memory/save`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MNEMOSYNE_TOKEN}`,
    },
    body: JSON.stringify({ ...memory, workspace: WORKSPACE }),
    signal: AbortSignal.timeout(10000),
  });
  
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err}`);
  }
  
  return res.json();
}

function classifyKind(text, role, tags) {
  // Simple heuristic classification
  const lower = (text || '').toLowerCase();
  const tagSet = new Set(tags || []);
  
  if (tagSet.has('error') || lower.includes('error') || lower.includes('失败') || lower.includes('报错')) {
    return 'error';
  }
  if (tagSet.has('decision') || lower.includes('决定') || lower.includes('选定') || lower.includes('选择')) {
    return 'decision';
  }
  if (tagSet.has('preference') || lower.includes('喜欢') || lower.includes('偏好') || lower.includes('习惯')) {
    return 'preference';
  }
  if (tagSet.has('procedure') || lower.includes('步骤') || lower.includes('流程') || lower.includes('部署')) {
    return 'procedure';
  }
  if (role === 'user' && text?.length > 50) {
    return 'fact';
  }
  if (role === 'assistant' && text?.length > 100) {
    return 'episode';
  }
  return 'fact';
}

function estimateImportance(text, role) {
  // Simple importance heuristic
  if (!text) return 0.3;
  
  let score = 0.5;
  
  // Length-based (longer = more important)
  if (text.length > 200) score += 0.1;
  if (text.length > 500) score += 0.1;
  
  // Role-based (user statements slightly more important)
  if (role === 'user') score += 0.05;
  
  // Keyword boosts
  const boostWords = ['重要', '关键', '决定', '部署', '配置', '成功', '失败', '记住', '必须'];
  for (const w of boostWords) {
    if (text.includes(w)) { score += 0.05; break; }
  }
  
  return Math.min(score, 1.0);
}

async function migrateRecentWindow() {
  console.log('\n📋 Migrating _recent.jsonl (recent conversation window)...');
  
  if (!existsSync(RECENT_FILE)) {
    console.log('  ⚠️  File not found, skipping');
    return;
  }
  
  const lines = readFileSync(RECENT_FILE, 'utf-8').split('\n').filter(Boolean);
  console.log(`  Found ${lines.length} entries`);
  
  const seenHashes = new Set();
  
  for (let i = 0; i < lines.length; i++) {
    total++;
    try {
      const entry = JSON.parse(lines[i]);
      const { role, text, tags, meta, t } = entry;
      
      if (!text || text.length < 10) {
        skipped++;
        continue;
      }
      
      // Dedup by content hash if available
      const hash = meta?.content_hash || `${t}_${text.length}`;
      if (seenHashes.has(hash)) {
        skipped++;
        continue;
      }
      seenHashes.add(hash);
      
      const kind = classifyKind(text, role, tags);
      const importance = estimateImportance(text, role);
      
      const memory = {
        content: text.slice(0, 5000), // Cap at 5000 chars
        kind,
        tags: [...(tags || []), 'migrated', 'lingshu', `role:${role}`],
        importance,
        source_agent: 'lingshu-migration',
        source_session: meta?.session || null,
        valid_from: t ? Math.floor(t) : Math.floor(Date.now() / 1000),
      };
      
      if (DRY_RUN) {
        console.log(`  [DRY] ${kind} | ${role} | ${text.slice(0, 60)}...`);
        migrated++;
      } else {
        await saveToMnemosyne(memory);
        migrated++;
        if (migrated % BATCH_SIZE === 0) {
          process.stdout.write(`  Progress: ${migrated}/${lines.length}\r`);
        }
      }
    } catch (err) {
      failed++;
      if (failed <= 3) {
        console.log(`  ❌ Error: ${err.message}`);
      }
    }
  }
  
  console.log(`  ✅ Migrated: ${migrated}, Skipped: ${skipped}, Failed: ${failed}`);
}

async function migrateIndexNodes() {
  console.log('\n🧠 Migrating _index.json (knowledge graph nodes)...');
  
  if (!existsSync(INDEX_FILE)) {
    console.log('  ⚠️  File not found, skipping');
    return;
  }
  
  const index = JSON.parse(readFileSync(INDEX_FILE, 'utf-8'));
  const nodes = index.nodes || {};
  
  // Only migrate contextual layer (the main recall layer)
  const contextual = Object.entries(nodes).filter(([_, v]) => v.layer === 'contextual');
  console.log(`  Found ${contextual.length} contextual nodes`);
  
  let nodeMigrated = 0;
  let nodeSkipped = 0;
  let nodeFailed = 0;
  
  for (const [id, node] of contextual) {
    total++;
    
    // Skip very low importance
    if ((node.importance || 0) < 0.2) {
      nodeSkipped++;
      continue;
    }
    
    try {
      // Read the actual content from the .md file
      const mdPath = join(LINGSHU_DIR, '..', node.path || `contextual/${id}.md`);
      let content = '';
      
      if (existsSync(mdPath)) {
        content = readFileSync(mdPath, 'utf-8');
      } else {
        // Fallback: use metadata
        content = `[${node.layer}] ${id} (content file not found)`;
      }
      
      if (content.length < 10) {
        nodeSkipped++;
        continue;
      }
      
      const memory = {
        content: content.slice(0, 5000),
        kind: classifyKind(content, node.role, node.tags),
        tags: [...(node.tags || []), 'migrated', 'lingshu', 'contextual'],
        importance: node.importance || 0.5,
        source_agent: 'lingshu-migration',
        source_session: node.session || null,
        valid_from: node.created_at ? Math.floor(node.created_at) : Math.floor(Date.now() / 1000),
      };
      
      if (DRY_RUN) {
        console.log(`  [DRY] ${memory.kind} | ${id} | importance=${memory.importance}`);
        nodeMigrated++;
      } else {
        await saveToMnemosyne(memory);
        nodeMigrated++;
      }
    } catch (err) {
      nodeFailed++;
      if (nodeFailed <= 3) {
        console.log(`  ❌ Error on ${id}: ${err.message}`);
      }
    }
  }
  
  console.log(`  ✅ Migrated: ${nodeMigrated}, Skipped: ${nodeSkipped}, Failed: ${nodeFailed}`);
  migrated += nodeMigrated;
  skipped += nodeSkipped;
  failed += nodeFailed;
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     Mnemosyne Migration — 从灵枢迁移到 Mnemosyne              ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Source: ~/.dsh/.dsh-memory/                                 ║`);
  console.log(`║  Target: ${MNEMOSYNE_URL.padEnd(45)}║`);
  console.log(`║  Workspace: ${WORKSPACE.padEnd(43)}║`);
  console.log(`║  Mode: ${(DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE').padEnd(47)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  
  if (!MNEMOSYNE_TOKEN) {
    console.error('\n❌ Error: MNEMOSYNE_TOKEN not set. Use --token or env var.');
    process.exit(1);
  }
  
  // Test connection
  console.log('\n🔌 Testing connection...');
  try {
    const res = await fetch(`${MNEMOSYNE_URL}/health`, {
      headers: { 'Authorization': `Bearer ${MNEMOSYNE_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const health = await res.json();
      console.log(`  ✅ Connected. Server uptime: ${Math.floor(health.uptime)}s, existing memories: ${health.stats?.total || 0}`);
    } else {
      console.error(`  ❌ Server returned ${res.status}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`  ❌ Connection failed: ${err.message}`);
    process.exit(1);
  }
  
  // Migrate
  await migrateRecentWindow();
  await migrateIndexNodes();
  
  // Summary
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                      Migration Summary                        ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Total processed:  ${String(total).padEnd(42)}║`);
  console.log(`║  Migrated:         ${String(migrated).padEnd(42)}║`);
  console.log(`║  Skipped:          ${String(skipped).padEnd(42)}║`);
  console.log(`║  Failed:           ${String(failed).padEnd(42)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  
  if (!DRY_RUN && migrated > 0) {
    console.log('\n🔍 Verifying migration...');
    try {
      const res = await fetch(`${MNEMOSYNE_URL}/memory/recent?workspace=${WORKSPACE}&limit=5`, {
        headers: { 'Authorization': `Bearer ${MNEMOSYNE_TOKEN}` },
      });
      const data = await res.json();
      console.log(`  Recent memories count: ${data.count}`);
      if (data.results?.length > 0) {
        console.log(`  Latest: ${data.results[0].content?.slice(0, 60)}...`);
      }
    } catch (err) {
      console.log(`  ⚠️  Verification failed: ${err.message}`);
    }
  }
  
  console.log('\n✅ Migration complete!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
