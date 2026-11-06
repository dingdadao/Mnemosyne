#!/usr/bin/env node
/**
 * Mnemosyne Session Summary Sync — 按工作区总结会话并同步
 * 
 * 读取每个工作区的会话日志，生成摘要，同步到 Mnemosyne。
 * 摘要用 LLM 生成（如果配置了）或纯文本提取。
 * 
 * 用法:
 *   node sync-session-summaries.js [--dry-run] [--workspace all|default-workspace|...]
 *   node sync-session-summaries.js --url http://127.0.0.1:8790 --token xxx
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultVal;
}

const MNEMOSYNE_URL = getArg('url', process.env.MNEMOSYNE_URL || 'http://127.0.0.1:8790');
const MNEMOSYNE_TOKEN = getArg('token', process.env.MNEMOSYNE_TOKEN || '');
const DRY_RUN = args.includes('--dry-run');
const TARGET_WS = getArg('workspace', 'all');
const DSH_HOME = join(homedir(), '.dsh');
const SESSIONS_DIR = join(DSH_HOME, 'sessions');

// Stats
const stats = new Map();

function getStats(ws) {
  if (!stats.has(ws)) stats.set(ws, { sessions: 0, summaries: 0, skipped: 0, failed: 0 });
  return stats.get(ws);
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
  
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function getWorkspaceShortName(dirName) {
  const match = dirName.match(/^--(.+)--$/);
  if (!match) return dirName;
  const parts = match[1].split('-');
  let shortName = parts[parts.length - 1];
  if (parts.length >= 2 && parts[parts.length - 2].length > 2) {
    shortName = parts[parts.length - 2] + '-' + parts[parts.length - 1];
  }
  return shortName;
}

function extractSessionSummary(sessionDir) {
  // Try to read session title from metadata or extract from JSONL
  const jsonlFiles = readdirSync(sessionDir).filter(f => f.endsWith('.jsonl') || f.endsWith('.jsonl.zstd'));
  if (jsonlFiles.length === 0) return null;
  
  const jsonlPath = join(sessionDir, jsonlFiles[0]);
  
  try {
    let content;
    if (jsonlPath.endsWith('.zstd')) {
      // Decompress zstd
      try {
        content = execSync(`zstd -dc "${jsonlPath}" 2>/dev/null | head -200`, { maxBuffer: 10 * 1024 * 1024 }).toString();
      } catch {
        return null; // Can't decompress
      }
    } else {
      content = readFileSync(jsonlPath, 'utf-8');
    }
    
    const lines = content.split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    
    // Extract user messages and assistant summaries
    const userMessages = [];
    const assistantMessages = [];
    let sessionTitle = null;
    
    for (const line of lines.slice(0, 100)) { // First 100 lines
      try {
        const event = JSON.parse(line);
        
        // Session title
        if (event.type === 'session/title' && event.data?.title) {
          sessionTitle = event.data.title;
        }
        
        // User messages
        if (event.type === 'user/message' && event.data?.content) {
          const text = typeof event.data.content === 'string' 
            ? event.data.content 
            : event.data.content?.[0]?.text || '';
          if (text.length > 10) userMessages.push(text.slice(0, 200));
        }
        
        // Assistant messages (take first few as summary)
        if (event.type === 'assistant/message' && event.data?.content) {
          const text = typeof event.data.content === 'string'
            ? event.data.content
            : event.data.content?.[0]?.text || '';
          if (text.length > 50) assistantMessages.push(text.slice(0, 300));
        }
      } catch {}
    }
    
    if (!sessionTitle && userMessages.length === 0) return null;
    
    // Build summary
    const summary = {
      title: sessionTitle || `Session: ${basename(sessionDir).slice(0, 20)}`,
      userMessages: userMessages.slice(0, 3), // Top 3 user messages
      keyTakeaways: assistantMessages.slice(0, 2), // Top 2 assistant responses
      messageCount: userMessages.length,
    };
    
    return summary;
  } catch {
    return null;
  }
}

function formatSummary(summary, sessionId) {
  let text = `## Session Summary\n\n`;
  text += `**Title**: ${summary.title}\n`;
  text += `**Messages**: ${summary.messageCount} user messages\n\n`;
  
  if (summary.userMessages.length > 0) {
    text += `### User Requests\n`;
    summary.userMessages.forEach((msg, i) => {
      text += `${i + 1}. ${msg}\n`;
    });
    text += '\n';
  }
  
  if (summary.keyTakeaways.length > 0) {
    text += `### Key Takeaways\n`;
    summary.keyTakeaways.forEach((msg, i) => {
      text += `${i + 1}. ${msg.slice(0, 200)}...\n`;
    });
  }
  
  text += `\n*Session: ${sessionId}*\n`;
  return text;
}

async function syncWorkspace(workspaceDir) {
  const wsShortName = getWorkspaceShortName(workspaceDir);
  
  if (TARGET_WS !== 'all' && TARGET_WS !== wsShortName) return;
  
  const wsPath = join(SESSIONS_DIR, workspaceDir);
  const sessions = readdirSync(wsPath).filter(d => d.startsWith('session-') || d.includes('~'));
  
  if (sessions.length === 0) return;
  
  console.log(`\n📂 Workspace: ${wsShortName} (${sessions.length} sessions)`);
  const wsStats = getStats(wsShortName);
  
  for (const sessionId of sessions) {
    const sessionDir = join(wsPath, sessionId);
    if (!existsSync(sessionDir)) continue;
    
    // Check if already migrated (skip if memory exists with this session ID)
    // For now, just process all
    wsStats.sessions++;
    
    const summary = extractSessionSummary(sessionDir);
    if (!summary) {
      wsStats.skipped++;
      continue;
    }
    
    const content = formatSummary(summary, sessionId);
    
    try {
      await saveToMnemosyne({
        content,
        kind: 'episode',
        tags: ['session-summary', 'migrated', `workspace:${wsShortName}`],
        importance: summary.messageCount > 5 ? 0.7 : 0.4,
        source_agent: 'session-summary-sync',
        source_session: sessionId,
      }, wsShortName);
      wsStats.summaries++;
      
      if (wsStats.summaries % 5 === 0) {
        process.stdout.write(`  Progress: ${wsStats.summaries}/${sessions.length}\r`);
      }
    } catch (err) {
      wsStats.failed++;
    }
  }
  
  console.log(`  ✅ ${wsStats.summaries} summaries, ${wsStats.skipped} skipped, ${wsStats.failed} failed`);
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   Mnemosyne Session Summary Sync — 按工作区同步会话摘要        ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Target: ${MNEMOSYNE_URL.padEnd(45)}║`);
  console.log(`║  Mode: ${(DRY_RUN ? 'DRY RUN' : 'LIVE').padEnd(47)}║`);
  console.log(`║  Workspace: ${TARGET_WS.padEnd(42)}║`);
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
  
  // Process each workspace
  const workspaceDirs = readdirSync(SESSIONS_DIR).filter(d => d.startsWith('--'));
  
  for (const wsDir of workspaceDirs) {
    await syncWorkspace(wsDir);
  }
  
  // Summary
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║              Session Summary Sync Results                     ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  
  for (const [ws, s] of stats) {
    if (s.sessions > 0) {
      console.log(`║  ${ws.padEnd(30)} sessions:${String(s.sessions).padEnd(4)} summaries:${String(s.summaries).padEnd(4)} failed:${s.failed}`);
    }
  }
  
  const totalSummaries = [...stats.values()].reduce((a, s) => a + s.summaries, 0);
  const totalSessions = [...stats.values()].reduce((a, s) => a + s.sessions, 0);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  TOTAL: ${totalSummaries} summaries from ${totalSessions} sessions              ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
