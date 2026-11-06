#!/usr/bin/env node
/**
 * Mnemosyne Workspace Migration — 按工作区迁移所有记忆源
 * 
 * 整合多个记忆源，按工作区合并：
 * 
 * 1. 灵枢 _index.json contextual 节点 → workspace = session 对应的工作区
 * 2. 灵枢 _recent.jsonl 对话记录 → workspace = 当前工作区
 * 3. dsh-engram 存储 (如果存在) → workspace = engram 的 workspace
 * 4. dsh-native-memory (如果存在) → workspace = per-workspace facts
 * 5. Session logs (标题/摘要) → workspace = session 所在目录
 * 
 * 工作区命名规则:
 *   灵枢: --Users-dension-Documents-deepseek-harness-default-workspace-- → deepseek-harness-default-workspace
 *   Mnemosyne: 用 short name (最后一段路径)
 * 
 * 用法:
 *   node migrate-by-workspace.js [--dry-run] [--source all|lingshu|engram|native]
 *   node migrate-by-workspace.js --url http://127.0.0.1:8790 --token xxx
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultVal;
}

const MNEMOSYNE_URL = getArg('url', process.env.MNEMOSYNE_URL || 'http://127.0.0.1:8790');
const MNEMOSYNE_TOKEN = getArg('token', process.env.MNEMOSYNE_TOKEN || '');
const DRY_RUN = args.includes('--dry-run');
const SOURCE = getArg('source', 'all');
const BATCH_SIZE = parseInt(getArg('batch', '5'));

const DSH_HOME = join(homedir(), '.dsh');
const LINGSHU_DIR = join(DSH_HOME, '.dsh-memory/data/mdcg');
const SESSIONS_DIR = join(DSH_HOME, 'sessions');
const ENGRAM_STORAGE = join(DSH_HOME, 'storages/dsh_engram.json');
const NATIVE_STORAGE = join(DSH_HOME, 'storages/dsh_memory.json');

// Stats per workspace
const stats = new Map();

function getStats(ws) {
  if (!stats.has(ws)) {
    stats.set(ws, { migrated: 0, skipped: 0, failed: 0, sources: new Set() });
  }
  return stats.get(ws);
}

// Map session ID → workspace short name
function buildSessionWorkspaceMap() {
  const map = new Map();
  if (!existsSync(SESSIONS_DIR)) return map;
  
  for (const dir of readdirSync(SESSIONS_DIR)) {
    // dir format: --Users-dension-Documents-deepseek-harness-default-workspace--
    const match = dir.match(/^--(.+)--$/);
    if (!match) continue;
    
    const fullPath = match[1]; // Users-dension-Documents-deepseek-harness-default-workspace
    const parts = fullPath.split('-');
    // Find the last meaningful part (actual directory name)
    // Users-dension-Documents-deepseek-harness-default-workspace → default-workspace
    let shortName = parts[parts.length - 1];
    if (parts.length >= 2 && parts[parts.length - 2].length > 2) {
      shortName = parts[parts.length - 2] + '-' + parts[parts.length - 1];
    }
    
    // Map all session IDs in this workspace dir
    const wsDir = join(SESSIONS_DIR, dir);
    try {
      for (const item of readdirSync(wsDir)) {
        if (item.startsWith('session-')) {
          map.set(item, shortName);
        }
      }
    } catch {}
  }
  
  return map;
}

async function saveToMnemosyne(memory, workspace) {
  if (DRY_RUN) return { id: 'dry_run' };
  
  const res = await fetch(`${MNEMOSYNE_URL}/memory/save`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MNEMOSYNE_TOKEN}`,
    },
    body: JSON.stringify({ ...memory, workspace }),
    signal: AbortSignal.timeout(10000),
  });
  
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err.slice(0, 100)}`);
  }
  
  return res.json();
}

function classifyKind(text, role, tags) {
  const lower = (text || '').toLowerCase();
  const tagSet = new Set(tags || []);
  
  if (tagSet.has('error') || tagSet.has('失败') || lower.includes('error') || lower.includes('失败')) return 'error';
  if (tagSet.has('decision') || tagSet.has('决定') || lower.includes('决定') || lower.includes('选定')) return 'decision';
  if (tagSet.has('preference') || tagSet.has('偏好') || lower.includes('喜欢') || lower.includes('偏好')) return 'preference';
  if (tagSet.has('procedure') || tagSet.has('流程') || lower.includes('步骤') || lower.includes('部署')) return 'procedure';
  if (role === 'assistant' && text?.length > 100) return 'episode';
  return 'fact';
}

function estimateImportance(text, role) {
  if (!text) return 0.3;
  let score = 0.5;
  if (text.length > 200) score += 0.1;
  if (text.length > 500) score += 0.1;
  if (role === 'user') score += 0.05;
  const boosts = ['重要', '关键', '决定', '部署', '配置', '成功', '失败', '记住'];
  for (const w of boosts) { if (text.includes(w)) { score += 0.05; break; } }
  return Math.min(score, 1.0);
}

// === Source 1: Lingshu contextual nodes (by workspace) ===
async function migrateLingshuContextual(sessionMap) {
  console.log('\n📋 Source 1: 灵枢 contextual 节点 (按工作区)...');
  
  const indexFile = join(LINGSHU_DIR, '_index.json');
  if (!existsSync(indexFile)) { console.log('  ⚠️ Not found'); return; }
  
  const index = JSON.parse(readFileSync(indexFile, 'utf-8'));
  const nodes = index.nodes || {};
  const contextual = Object.entries(nodes).filter(([_, v]) => v.layer === 'contextual');
  
  console.log(`  Found ${contextual.length} nodes`);
  
  for (const [id, node] of contextual) {
    const sessionId = node.session || '';
    const workspace = sessionMap.get(sessionId) || 'default';
    const wsStats = getStats(workspace);
    wsStats.sources.add('lingshu-contextual');
    
    const mdPath = join(LINGSHU_DIR, node.path || `contextual/${id}.md`);
    if (!existsSync(mdPath)) { wsStats.skipped++; continue; }
    
    const content = readFileSync(mdPath, 'utf-8');
    if (content.length < 10) { wsStats.skipped++; continue; }
    
    try {
      await saveToMnemosyne({
        content: content.slice(0, 5000),
        kind: classifyKind(content, node.role, node.tags),
        tags: [...(node.tags || []), 'migrated', 'lingshu-contextual'],
        importance: node.importance || 0.5,
        source_agent: 'lingshu-migration',
        source_session: sessionId,
        valid_from: node.created_at ? Math.floor(node.created_at) : Math.floor(Date.now() / 1000),
      }, workspace);
      wsStats.migrated++;
    } catch (err) {
      wsStats.failed++;
    }
  }
}

// === Source 2: Lingshu recent window ===
async function migrateLingshuRecent(sessionMap) {
  console.log('\n📋 Source 2: 灵枢 recent window...');
  
  const recentFile = join(LINGSHU_DIR, '_recent.jsonl');
  if (!existsSync(recentFile)) { console.log('  ⚠️ Not found'); return; }
  
  const lines = readFileSync(recentFile, 'utf-8').split('\n').filter(Boolean);
  console.log(`  Found ${lines.length} entries`);
  
  const seenHashes = new Set();
  
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const { role, text, tags, meta, t } = entry;
      
      if (!text || text.length < 10) continue;
      
      const sessionId = meta?.session || '';
      const workspace = sessionMap.get(sessionId) || 'default';
      const wsStats = getStats(workspace);
      wsStats.sources.add('lingshu-recent');
      
      const hash = meta?.content_hash || `${t}_${text.length}`;
      if (seenHashes.has(hash)) { wsStats.skipped++; continue; }
      seenHashes.add(hash);
      
      await saveToMnemosyne({
        content: text.slice(0, 5000),
        kind: classifyKind(text, role, tags),
        tags: [...(tags || []), 'migrated', 'lingshu-recent', `role:${role}`],
        importance: estimateImportance(text, role),
        source_agent: 'lingshu-migration',
        source_session: sessionId,
        valid_from: t ? Math.floor(t) : Math.floor(Date.now() / 1000),
      }, workspace);
      wsStats.migrated++;
    } catch {}
  }
}

// === Source 3: dsh-engram storage ===
async function migrateEngram() {
  console.log('\n📋 Source 3: dsh-engram...');
  
  if (!existsSync(ENGRAM_STORAGE)) { console.log('  ⚠️ Not found'); return; }
  
  try {
    const data = JSON.parse(readFileSync(ENGRAM_STORAGE, 'utf-8'));
    const memories = data.memories || [];
    console.log(`  Found ${memories.length} memories`);
    
    for (const mem of memories) {
      const workspace = mem.workspace || 'default';
      const wsStats = getStats(workspace);
      wsStats.sources.add('engram');
      
      if (!mem.text || mem.text.length < 5) { wsStats.skipped++; continue; }
      
      try {
        await saveToMnemosyne({
          content: mem.text.slice(0, 5000),
          kind: mem.kind || classifyKind(mem.text, null, mem.tags),
          tags: [...(mem.tags || []), 'migrated', 'engram'],
          importance: mem.importance || estimateImportance(mem.text),
          source_agent: 'engram-migration',
          valid_from: mem.createdAt ? Math.floor(mem.createdAt / 1000) : Math.floor(Date.now() / 1000),
        }, workspace);
        wsStats.migrated++;
      } catch {
        wsStats.failed++;
      }
    }
  } catch (err) {
    console.log(`  ❌ Error: ${err.message}`);
  }
}

// === Source 4: dsh-native-memory ===
async function migrateNative() {
  console.log('\n📋 Source 4: dsh-native-memory...');
  
  if (!existsSync(NATIVE_STORAGE)) { console.log('  ⚠️ Not found'); return; }
  
  try {
    const data = JSON.parse(readFileSync(NATIVE_STORAGE, 'utf-8'));
    const facts = data.facts || {};
    console.log(`  Found ${Object.keys(facts).length} facts`);
    
    for (const [id, fact] of Object.entries(facts)) {
      const workspace = fact.workspacePath ? basename(fact.workspacePath) : 'default';
      const wsStats = getStats(workspace);
      wsStats.sources.add('native-memory');
      
      if (!fact.text || fact.text.length < 5) { wsStats.skipped++; continue; }
      
      try {
        await saveToMnemosyne({
          content: fact.text.slice(0, 5000),
          kind: fact.kind || 'fact',
          tags: [...(fact.tags || []), 'migrated', 'native-memory'],
          importance: 0.6,
          source_agent: 'native-migration',
          source_session: fact.sessionId || null,
          valid_from: fact.createdAt ? Math.floor(fact.createdAt / 1000) : Math.floor(Date.now() / 1000),
        }, workspace);
        wsStats.migrated++;
      } catch {
        wsStats.failed++;
      }
    }
  } catch (err) {
    console.log(`  ❌ Error: ${err.message}`);
  }
}

// === Source 5: Session titles/summaries ===
async function migrateSessionTitles(sessionMap) {
  console.log('\n📋 Source 5: Session titles...');
  
  if (!existsSync(SESSIONS_DIR)) { console.log('  ⚠️ Not found'); return; }
  
  for (const [sessionId, workspace] of sessionMap) {
    const wsStats = getStats(workspace);
    wsStats.sources.add('session-titles');
    
    // Look for session title in metadata
    const sessionDirs = readdirSync(SESSIONS_DIR).filter(d => {
      try { return readdirSync(join(SESSIONS_DIR, d)).includes(sessionId); } catch { return false; }
    });
    
    for (const dir of sessionDirs) {
      // Try to read title from session metadata
      const metaPath = join(SESSIONS_DIR, dir, sessionId, 'meta.json');
      if (!existsSync(metaPath)) continue;
      
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        const title = meta.title || meta.summary;
        if (!title || title.length < 5) continue;
        
        await saveToMnemosyne({
          content: `Session: ${title}`,
          kind: 'episode',
          tags: ['migrated', 'session-title'],
          importance: 0.4,
          source_agent: 'session-migration',
          source_session: sessionId,
        }, workspace);
        wsStats.migrated++;
      } catch {}
    }
  }
}

// === Main ===
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   Mnemosyne Workspace Migration — 按工作区迁移所有记忆源       ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Target: ${MNEMOSYNE_URL.padEnd(45)}║`);
  console.log(`║  Mode: ${(DRY_RUN ? 'DRY RUN' : 'LIVE').padEnd(47)}║`);
  console.log(`║  Sources: ${SOURCE.padEnd(44)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  
  if (!MNEMOSYNE_TOKEN) { console.error('❌ MNEMOSYNE_TOKEN required'); process.exit(1); }
  
  // Test connection
  try {
    const res = await fetch(`${MNEMOSYNE_URL}/health`, {
      headers: { 'Authorization': `Bearer ${MNEMOSYNE_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log('\n✅ Connected to Mnemosyne server');
  } catch (err) {
    console.error(`❌ Connection failed: ${err.message}`);
    process.exit(1);
  }
  
  // Build session→workspace map
  console.log('\n🔍 Building session→workspace map...');
  const sessionMap = buildSessionWorkspaceMap();
  console.log(`  Mapped ${sessionMap.size} sessions to workspaces`);
  
  // Migrate by source
  if (SOURCE === 'all' || SOURCE === 'lingshu') {
    await migrateLingshuContextual(sessionMap);
    await migrateLingshuRecent(sessionMap);
  }
  if (SOURCE === 'all' || SOURCE === 'engram') {
    await migrateEngram();
  }
  if (SOURCE === 'all' || SOURCE === 'native') {
    await migrateNative();
  }
  if (SOURCE === 'all' || SOURCE === 'sessions') {
    await migrateSessionTitles(sessionMap);
  }
  
  // Summary by workspace
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║              Migration Summary (by workspace)                ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  
  const sorted = [...stats.entries()].sort((a, b) => b[1].migrated - a[1].migrated);
  for (const [ws, s] of sorted) {
    const total = s.migrated + s.skipped + s.failed;
    console.log(`║  ${ws.padEnd(30)} migrated:${String(s.migrated).padEnd(5)} skipped:${String(s.skipped).padEnd(5)} failed:${s.failed}`);
    console.log(`║  ${''.padEnd(30)} sources: ${[...s.sources].join(', ')}`);
  }
  
  const totalMigrated = [...stats.values()].reduce((a, s) => a + s.migrated, 0);
  const totalFailed = [...stats.values()].reduce((a, s) => a + s.failed, 0);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  TOTAL: ${String(totalMigrated).padEnd(10)} migrated, ${String(totalFailed).padEnd(10)} failed          ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
