#!/usr/bin/env node
/**
 * Mnemosyne Secure Server v1.1
 * 
 * 安全增强:
 * 1. 敏感数据自动脱敏 (保存时)
 * 2. 认证强化 (token + timing-safe compare)
 * 3. Rate limiting
 * 4. Security headers
 * 5. 请求日志
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import Database from 'better-sqlite3';
import { searchMemories, autoSummarize, findDuplicates, memoryHealth, jaccardSimilarity } from './search.js';

// === Config ===
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : defaultVal;
}

const PORT = parseInt(getArg('port', process.env.MNEMOSYNE_PORT || '8790'));
const HOST = getArg('host', process.env.MNEMOSYNE_HOST || '0.0.0.0');
const DATA_DIR = getArg('data-dir', process.env.MNEMOSYNE_DATA_DIR || join(homedir(), '.mnemosyne'));
const RATE_LIMIT_MAX = parseInt(getArg('rate-limit', '100')); // requests per window
const RATE_LIMIT_WINDOW = parseInt(getArg('rate-window', '60000')); // ms

// === Auth Token ===
const TOKEN_FILE = join(DATA_DIR, '.token');
let AUTH_TOKEN = process.env.MNEMOSYNE_TOKEN;

if (!AUTH_TOKEN) {
  if (existsSync(TOKEN_FILE)) {
    AUTH_TOKEN = readFileSync(TOKEN_FILE, 'utf-8').trim();
  } else {
    AUTH_TOKEN = randomBytes(32).toString('hex');
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, AUTH_TOKEN, { mode: 0o600 });
    console.log(`[mnemosyne] Generated auth token: ${AUTH_TOKEN.slice(0, 16)}...`);
  }
}

// Token hash for timing-safe comparison
const TOKEN_HASH = createHash('sha256').update(AUTH_TOKEN).digest();

// === Shared Write Permission ===
function canWriteShared(token, visibility) {
  if (!token) return false;
  const hash = createHash('sha256').update(token).digest('hex');
  const row = db.prepare("SELECT can_write_shared, can_write_public FROM owner_tokens WHERE token_hash = ?").get(hash);
  if (!row) return false;
  if (visibility === 'public') return row.can_write_public === 1;
  return row.can_write_shared === 1;
}

// === Evolution helpers (v3.2) ==========================================

// Opt-in: distill "User: ...\nAssistant: ..." chat text into discrete facts.
// Pure rules, no LLM. Returns 0-3 short statements.
function extractFacts(text) {
  const lines = String(text || '')
    .split(/\n+/)
    .map(s => s.replace(/^\s*(User|Assistant|user|assistant)\s*[:：]\s*/, '').trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    const sentences = line
      .split(/[。！？\n]|(?<=[\u4e00-\u9fff])[.!?](?=\s|$)/)
      .map(s => s.trim())
      .filter(s => s.length >= 8 && s.length <= 300);
    for (const s of sentences) {
      if (/^(好的|明白|收到|我来|让我|请问|谢谢|ok|sure|i will|let me)/i.test(s)) continue;
      out.push(s);
    }
  }
  return [...new Set(out)].slice(0, 3);
}

// Lightweight entity extraction: IPs, domains, explicit "service X" / "host: X".
function autoEntities(text) {
  const found = new Map();
  const src = String(text || '');
  for (const m of src.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?\b/g)) {
    found.set(m[1], 'host');
  }
  for (const m of src.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+){2,})\b/gi)) {
    if (!/^\d/.test(m[1])) found.set(m[1], 'domain');
  }
  for (const m of src.matchAll(/\bservice\s+([a-z][a-z0-9_-]{2,})\b/gi)) {
    found.set(m[1], 'service');
  }
  return [...found.entries()].slice(0, 8).map(([name, type]) => ({ name, type }));
}

// Write-time near-duplicate gate. Returns existing row or null.
function findNearDuplicate(text, owner, ws) {
  const rows = db.prepare(
    "SELECT id, content, importance FROM memories WHERE workspace_id = ? AND state = 'active' AND (owner = ? OR owner IS NULL OR owner = '')"
  ).all(ws, owner);
  let best = null, bestSim = 0;
  for (const r of rows) {
    const sim = jaccardSimilarity(String(text || ''), String(r.content || ''));
    if (sim > bestSim) { bestSim = sim; best = r; }
  }
  return bestSim >= 0.85 ? best : null;
}

// Which of the given ids are superseded/contradicted (for score demotion).
function supersedeMap(ids) {
  if (!ids || !ids.length) return {};
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT to_memory_id, from_memory_id, relation_type FROM relations
     WHERE to_memory_id IN (${ph}) AND relation_type IN ('supersede','contradict')`
  ).all(...ids);
  const out = {};
  for (const r of rows) {
    if (!out[r.to_memory_id]) out[r.to_memory_id] = { by: r.from_memory_id, type: r.relation_type };
  }
  return out;
}
// === End evolution helpers =============================================


// === Rate Limiter ===
const requestCounts = new Map();
function checkRateLimit(clientIp) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;
  
  if (!requestCounts.has(clientIp)) {
    requestCounts.set(clientIp, []);
  }
  
  const requests = requestCounts.get(clientIp);
  // Clean old requests
  while (requests.length > 0 && requests[0] < windowStart) {
    requests.shift();
  }
  
  if (requests.length >= RATE_LIMIT_MAX) {
    return false;
  }
  
  requests.push(now);
  return true;
}

// Cleanup rate limiter periodically
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW * 2;
  for (const [ip, requests] of requestCounts) {
    while (requests.length > 0 && requests[0] < cutoff) {
      requests.shift();
    }
    if (requests.length === 0) {
      requestCounts.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW);

// === Sensitive Data Redaction ===
const SENSITIVE_PATTERNS = [
  { pattern: /(?:密码|口令|密钥)(?:是|为|[:=：])?\s*[^\s"'）】]{4,}/gi, name: 'chinese_secret' },
  { pattern: /(?:密码|口令)是\s*[:=：]?\s*[^\s]{4,}/gi, name: 'chinese_password' },
  { pattern: /(?:password|passwd|pwd|密码|口令)\s*[:=：]\s*[^\s"'）】]{4,}/gi, name: 'password' },
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, name: 'api_key' },
  { pattern: /ak-[a-zA-Z0-9]{16,}/g, name: 'api_key' },
  { pattern: /api[_-]?key\s*[:=：]\s*[a-zA-Z0-9]{16,}/gi, name: 'api_key' },
  { pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/g, name: 'bearer_token' },
  { pattern: /token\s*[:=：]\s*[a-zA-Z0-9]{16,}/gi, name: 'token' },
  { pattern: /tk_[a-zA-Z0-9]{8,}/g, name: 'token' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, name: 'private_key' },
  { pattern: /AKIA[0-9A-Z]{16}/g, name: 'aws_key' },
  { pattern: /(?:secret|密钥)\s*[:=：]\s*[^\s]{8,}/gi, name: 'secret' },
  { pattern: /ssh-(?:rsa|ed25519)\s+[a-zA-Z0-9+/=]{20,}/g, name: 'ssh_key' },
  { pattern: /[a-z]+:\/\/[^\/\s:]+:[^\/\s@]+@/g, name: 'url_credentials' },
  { pattern: /gh[pousr]_[a-zA-Z0-9]{20,}/g, name: 'github_token' },
];

function redactSensitive(text) {
  if (!text || typeof text !== 'string') return text;
  
  let result = text;
  let redactedCount = 0;
  
  for (const { pattern, name } of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, (match) => {
      redactedCount++;
      return `[REDACTED:${name}]`;
    });
  }
  
  return result;
}

// === Database ===
console.log(`[mnemosyne] Data directory: ${DATA_DIR}`);
mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(join(DATA_DIR, 'mnemosyne.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    config TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    content TEXT NOT NULL,
    summary TEXT,
    kind TEXT DEFAULT 'fact',
    tags TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    valid_from INTEGER,
    valid_until INTEGER,
    state TEXT DEFAULT 'active',
    importance REAL DEFAULT 0.5,
    source_session TEXT,
    source_agent TEXT,
    confidence REAL DEFAULT 1.0,
    access_count INTEGER DEFAULT 0,
    last_accessed_at INTEGER,
    verification_state TEXT DEFAULT 'unverified',
    verification_basis TEXT,
    sensitivity TEXT DEFAULT 'internal'
  );

  CREATE TABLE IF NOT EXISTS relations (
    id TEXT PRIMARY KEY,
    from_memory_id TEXT NOT NULL REFERENCES memories(id),
    to_memory_id TEXT NOT NULL REFERENCES memories(id),
    relation_type TEXT NOT NULL,
    confidence REAL DEFAULT 1.0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    metadata TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    entity_type TEXT DEFAULT 'concept',
    attributes TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(workspace_id, name, entity_type)
  );

  CREATE TABLE IF NOT EXISTS memory_entities (
    memory_id TEXT NOT NULL REFERENCES memories(id),
    entity_id TEXT NOT NULL REFERENCES entities(id),
    relevance REAL DEFAULT 1.0,
    PRIMARY KEY (memory_id, entity_id)
  );

  CREATE INDEX IF NOT EXISTS idx_memories_timeline ON memories(workspace_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(workspace_id, kind, state);
  CREATE INDEX IF NOT EXISTS idx_memories_state ON memories(workspace_id, state, importance DESC);
  CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_memory_id, relation_type);
  CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_memory_id, relation_type);

  -- Audit log
  -- v3: owner token permissions (who can write shared/public)
  CREATE TABLE IF NOT EXISTS owner_tokens (
    token_hash TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    can_write_shared INTEGER DEFAULT 0,
    can_write_public INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
    action TEXT NOT NULL,
    workspace_id TEXT,
    memory_id TEXT,
    client_ip TEXT,
    user_agent TEXT,
    redacted INTEGER DEFAULT 0
  );
`);

// v3: add owner + visibility columns (idempotent) — MUST run after CREATE TABLE
try { db.exec("ALTER TABLE memories ADD COLUMN owner TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE memories ADD COLUMN visibility TEXT DEFAULT 'private'"); } catch(e) {}

try { db.exec('CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories(workspace_id, owner, visibility, state)'); } catch(e) {}

// Prepared statements
const stmts = {
  insertWorkspace: db.prepare("INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (?, ?, ?)"),
  getWorkspace: db.prepare("SELECT * FROM workspaces WHERE id = ?"),
  insertMemory: db.prepare(`
    INSERT INTO memories (id, workspace_id, content, summary, kind, tags, valid_from, valid_until, source_session, source_agent, importance, sensitivity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getMemory: db.prepare("SELECT * FROM memories WHERE id = ?"),
  searchMemories: db.prepare(`
    SELECT * FROM memories WHERE workspace_id = ? AND state = 'active' AND (content LIKE ? OR summary LIKE ? OR tags LIKE ?)
    ORDER BY importance DESC, last_accessed_at DESC, created_at DESC LIMIT ? OFFSET ?
  `),
  searchByKind: db.prepare("SELECT * FROM memories WHERE workspace_id = ? AND kind = ? AND state = 'active' ORDER BY importance DESC, created_at DESC LIMIT ?"),
  timelineQuery: db.prepare("SELECT * FROM memories WHERE workspace_id = ? AND created_at BETWEEN ? AND ? AND state = 'active' ORDER BY created_at ASC LIMIT ?"),
  recentMemories: db.prepare("SELECT * FROM memories WHERE workspace_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT ?"),
  bumpAccess: db.prepare("UPDATE memories SET access_count = access_count + 1, last_accessed_at = unixepoch() WHERE id = ?"),
  updateMemory: db.prepare(`
    UPDATE memories SET content = COALESCE(?, content), summary = COALESCE(?, summary), kind = COALESCE(?, kind),
    tags = COALESCE(?, tags), updated_at = unixepoch(), state = COALESCE(?, state), importance = COALESCE(?, importance)
    WHERE id = ?
  `),
  deleteMemory: db.prepare("DELETE FROM memories WHERE id = ?"),
  insertRelation: db.prepare("INSERT INTO relations (id, from_memory_id, to_memory_id, relation_type, confidence, metadata) VALUES (?, ?, ?, ?, ?, ?)"),
  insertAudit: db.prepare("INSERT INTO audit_log (action, workspace_id, memory_id, client_ip, user_agent, redacted) VALUES (?, ?, ?, ?, ?, ?)"),
  getStats: db.prepare("SELECT COUNT(*) as total, COUNT(CASE WHEN state = 'active' THEN 1 END) as active, COUNT(CASE WHEN kind = 'error' THEN 1 END) as errors, COUNT(CASE WHEN kind = 'decision' THEN 1 END) as decisions, AVG(importance) as avg_importance FROM memories WHERE workspace_id = ?"),
  getAllMemories: db.prepare("SELECT * FROM memories ORDER BY created_at"),
  getAllRelations: db.prepare("SELECT * FROM relations ORDER BY created_at"),
  getAllEntities: db.prepare("SELECT * FROM entities ORDER BY created_at"),
};

// Ensure default workspace
stmts.insertWorkspace.run('default', 'Default Workspace', null);

// === HTTP Server ===
const server = createServer(async (req, res) => {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'unknown';
  
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Rate limiting
  if (!checkRateLimit(clientIp)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate_limited', hint: 'Too many requests' }));
    return;
  }

  // Auth check - timing safe
  const authHeader = req.headers.authorization || '';
  const providedToken = authHeader.replace('Bearer ', '');
  const providedHash = createHash('sha256').update(providedToken).digest();
  
  // v3: accept master token OR any registered owner token
  const isMaster = timingSafeEqual(providedHash, TOKEN_HASH);
  let ownerRow = null;
  if (!isMaster) {
    ownerRow = db.prepare("SELECT owner FROM owner_tokens WHERE token_hash = ?").get(providedHash.toString('hex'));
  }
  if (!isMaster && !ownerRow) {
    stmts.insertAudit.run('auth_failed', null, null, clientIp, userAgent, 0);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized', hint: 'Provide Bearer token in Authorization header' }));
    return;
  }
  // Bind caller identity for permission checks
  const callerOwner = ownerRow ? ownerRow.owner : 'admin';

  // Parse URL
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const query = Object.fromEntries(url.searchParams);

  // Parse body
  let body = {};
  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }
  }

  // Route
  try {
    const result = await route(path, req.method, query, body, clientIp, userAgent, providedToken);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result, null, 2));
  } catch (err) {
    res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

async function route(path, method, query, body, clientIp, userAgent, callerToken) {
  const workspaceId = query.workspace || body.workspace || 'default';
  let redactedCount = 0;

  // POST /memory/save — Save a memory (redaction + dedup gate + extract mode)
  if (path === '/memory/save' && method === 'POST') {
    const id = body.id || `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    stmts.insertWorkspace.run(workspaceId, workspaceId, null);

    const originalContent = body.content || '';
    const redactedContent = redactSensitive(originalContent);
    redactedCount = originalContent !== redactedContent ? 1 : 0;
    const redactedSummary = body.summary ? redactSensitive(body.summary) : null;
    const finalSummary = redactedSummary || autoSummarize(redactedContent, 2);

    const owner = body.owner || workspaceId;
    const visibility = body.visibility || 'private';

    if ((visibility === 'shared' || visibility === 'public') && !canWriteShared(callerToken, visibility)) {
      stmts.insertAudit.run('save_denied', workspaceId, id, clientIp, userAgent, redactedCount);
      throw { status: 403, message: 'No permission to write ' + visibility + ' memories' };
    }

    // v3.2 opt-in: extract discrete facts from raw chat text instead of storing the log
    const facts = body.extract === true ? extractFacts(redactedContent) : [];
    const payloads = facts.length
      ? facts.map(t => ({ content: t, summary: null }))
      : [{ content: redactedContent, summary: finalSummary }];

    const savedIds = [];
    let deduped = 0;
    const insertStmt = db.prepare(`
      INSERT INTO memories (id, workspace_id, content, summary, kind, tags, valid_from, valid_until, source_session, source_agent, importance, sensitivity, owner, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const p of payloads) {
      // v3.2 write-time near-duplicate gate (skip unless caller forces)
      if (body.force !== true) {
        const dup = findNearDuplicate(p.content, owner, workspaceId);
        if (dup) {
          stmts.bumpAccess.run(dup.id);
          savedIds.push(dup.id);
          deduped++;
          continue;
        }
      }
      const memId = savedIds.length === 0 && !facts.length
        ? id
        : `${id}_${savedIds.length}`;
      insertStmt.run(
        memId, workspaceId, p.content, p.summary,
        body.kind || 'fact',
        JSON.stringify(body.tags || []),
        body.valid_from || Math.floor(Date.now() / 1000),
        body.valid_until || null,
        body.source_session || null,
        body.source_agent || 'unknown',
        body.importance ?? 0.5,
        body.sensitivity || 'internal',
        owner, visibility
      );
      savedIds.push(memId);

      // v3.2 auto entity linking (fills the previously-empty entities table)
      const ents = (body.entities && Array.isArray(body.entities)) ? body.entities : autoEntities(p.content);
      for (const ent of ents) {
        const entId = `ent_${workspaceId}_${String(ent.name).slice(0, 48)}`;
        db.prepare("INSERT OR IGNORE INTO entities (id, workspace_id, name, entity_type, attributes) VALUES (?, ?, ?, ?, ?)")
          .run(entId, workspaceId, ent.name, ent.type || 'concept', JSON.stringify(ent.attributes || {}));
        db.prepare("INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, relevance) VALUES (?, ?, ?)")
          .run(memId, entId, ent.relevance || 1.0);
      }
    }

    stmts.insertAudit.run('save', workspaceId, savedIds[0] || id, clientIp, userAgent, redactedCount);
    return {
      id: savedIds[0] || id,
      ids: savedIds,
      status: 'saved',
      extracted: facts.length || 0,
      deduped,
      redacted: redactedCount > 0
    };
  }


  // GET /memory/get
  if (path === '/memory/get' && method === 'GET') {
    const mem = stmts.getMemory.get(query.id);
    if (!mem) throw { status: 404, message: 'Memory not found' };
    const sup = supersedeMap([mem.id])[mem.id];
    if (sup) { mem.superseded_by = sup.by; mem.relation = sup.type; }
    mem.tags = JSON.parse(mem.tags || '[]');
    stmts.bumpAccess.run(query.id);
    stmts.insertAudit.run('read', mem.workspace_id, query.id, clientIp, userAgent, 0);
    return mem;
  }

  // POST /memory/search — BM25 + decay + access boost
  if (path === '/memory/search' && method === 'POST') {
    const q = body.query || '';
    const limit = Math.min(body.limit || 20, 100);
    const offset = body.offset || 0;
    const kind = body.kind;
    
    // Get all memories for this workspace
    let allMemories;
    if (kind) {
      allMemories = db.prepare("SELECT * FROM memories WHERE workspace_id = ? AND kind = ? AND state = 'active'").all(workspaceId, kind);
    } else {
      allMemories = db.prepare("SELECT * FROM memories WHERE workspace_id = ? AND state = 'active'").all(workspaceId);
    }
    
    // Use v2 search engine (BM25 + decay + access boost)
    // v3: filter by owner + include
    const owner = body.owner || query.owner || '';
    const include = body.include || ['own', 'shared'];
    
    let filtered = allMemories;
    if (owner) {
      filtered = allMemories.filter(m => {
        const memOwner = m.owner || m.workspace_id;
        const memVis = m.visibility || 'private';
        
        if (include.includes('own') && memOwner === owner) return true;
        if (include.includes('shared') && memVis === 'shared') return true;
        if (include.includes('public') && memVis === 'public') return true;
        if (include.includes('all')) return true;
        return false;
      });
    }
    
    let searchResult = searchMemories(filtered, q, { kind, limit, offset });

    // v3.2 belief revision: demote memories that a newer one supersedes/contradicts
    const smap = supersedeMap(searchResult.results.map(m => m.id));
    if (Object.keys(smap).length) {
      searchResult.results = searchResult.results.map(m => smap[m.id]
        ? { ...m, _score: (m._score || 0) * 0.3, superseded_by: smap[m.id].by, relation: smap[m.id].type }
        : m);
      searchResult.results.sort((a, b) => (b._score || 0) - (a._score || 0));
      searchResult.demoted = Object.keys(smap).length;
    }
    
    // Bump access for returned results
    for (const mem of searchResult.results) {
      stmts.bumpAccess.run(mem.id);
    }
    
    stmts.insertAudit.run('search', workspaceId, null, clientIp, userAgent, 0);
    return searchResult;
  }

  // GET /memory/timeline
  if (path === '/memory/timeline' && method === 'GET') {
    const from = parseInt(query.from) || 0;
    const to = parseInt(query.to) || Math.floor(Date.now() / 1000);
    const limit = Math.min(parseInt(query.limit) || 50, 200);
    const results = stmts.timelineQuery.all(workspaceId, from, to, limit);
    return { range: { from, to }, count: results.length, results: results.map(m => ({ ...m, tags: JSON.parse(m.tags || '[]') })) };
  }

  // GET /memory/recent
  if (path === '/memory/recent' && method === 'GET') {
    const limit = Math.min(parseInt(query.limit) || 10, 50);
    const results = stmts.recentMemories.all(workspaceId, limit);
    return { count: results.length, results: results.map(m => ({ ...m, tags: JSON.parse(m.tags || '[]') })) };
  }

  // PUT /memory/update
  if (path === '/memory/update' && method === 'PUT') {
    const redactedContent = body.content ? redactSensitive(body.content) : null;
    stmts.updateMemory.run(
      redactedContent, body.summary ? redactSensitive(body.summary) : null,
      body.kind, body.tags ? JSON.stringify(body.tags) : null,
      body.state, body.importance, body.id
    );
    stmts.insertAudit.run('update', workspaceId, body.id, clientIp, userAgent, redactedContent ? 1 : 0);
    return { id: body.id, status: 'updated' };
  }

  // DELETE /memory/delete
  if (path === '/memory/delete' && method === 'DELETE') {
    stmts.deleteMemory.run(query.id);
    stmts.insertAudit.run('delete', workspaceId, query.id, clientIp, userAgent, 0);
    return { id: query.id, status: 'deleted' };
  }

  // POST /memory/relate
  if (path === '/memory/relate' && method === 'POST') {
    const id = `rel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    stmts.insertRelation.run(id, body.from_id, body.to_id, body.relation_type, body.confidence || 1.0, JSON.stringify(body.metadata || {}));
    stmts.insertAudit.run('relate', workspaceId, id, clientIp, userAgent, 0);
    return { id, status: 'related' };
  }

  // GET /health
  if (path === '/health' && method === 'GET') {
    return {
      status: 'ok', version: '3.0.0-multi-tenant', uptime: process.uptime(),
      workspace: workspaceId, stats: (() => { const s = stmts.getStats.get(workspaceId); return { total: s.active, active: s.active, errors: s.errors, decisions: s.decisions, avg_importance: s.avg_importance }; })(),
      security: { redaction: true, rateLimit: true, auditLog: true }
    };
  }

  // GET /stats
  if (path === '/stats' && method === 'GET') {
    return { workspace: workspaceId, stats: (() => { const s = stmts.getStats.get(workspaceId); return { total: s.active, active: s.active, errors: s.errors, decisions: s.decisions, avg_importance: s.avg_importance }; })() };
  }

  // GET /audit
  if (path === '/audit' && method === 'GET') {
    const limit = Math.min(parseInt(query.limit) || 50, 200);
    const logs = db.prepare("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?").all(limit);
    return { count: logs.length, logs };
  }

  // GET /export
  if (path === '/export' && method === 'GET') {
    return {
      format: 'mnemosyne/export', version: 1, exported_at: new Date().toISOString(),
      memories: stmts.getAllMemories.all(),
      relations: stmts.getAllRelations.all(),
      entities: stmts.getAllEntities.all(),
    };
  }

  // POST /backup
  if (path === '/backup' && method === 'POST') {
    const backupDir = join(DATA_DIR, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(backupDir, `mnemosyne-backup-${timestamp}.db`);
    db.backup(backupPath);
    stmts.insertAudit.run('backup', null, null, clientIp, userAgent, 0);
    return { status: 'backed_up', path: backupPath };
  }

  // === V2 Endpoints ===

  // GET /memory/health — Memory store health check
  if (path === '/memory/health' && method === 'GET') {
    const allMemories = db.prepare("SELECT * FROM memories WHERE workspace_id = ? AND state = 'active'").all(workspaceId);
    const health = memoryHealth(allMemories);
    return { workspace: workspaceId, ...health };
  }

  // GET /memory/duplicates — Find duplicate memories
  if (path === '/memory/duplicates' && method === 'GET') {
    const threshold = parseFloat(query.threshold) || 0.7;
    const allMemories = db.prepare("SELECT id, content, kind, created_at FROM memories WHERE workspace_id = ? AND state = 'active'").all(workspaceId);
    const duplicates = findDuplicates(allMemories, threshold);
    return { workspace: workspaceId, count: duplicates.length, duplicates };
  }

  // POST /memory/consolidate — Merge near-duplicates (autoDream lite)
  if (path === '/memory/consolidate' && method === 'POST') {
    const threshold = body.threshold || 0.85;
    const dryRun = body.dry_run || false;
    
    const allMemories = db.prepare("SELECT * FROM memories WHERE workspace_id = ? AND state = 'active' ORDER BY importance DESC").all(workspaceId);
    const duplicates = findDuplicates(allMemories, threshold);
    
    if (dryRun) {
      return { workspace: workspaceId, dry_run: true, would_merge: duplicates.length, duplicates };
    }
    
    let merged = 0;
    const mergeStmt = db.prepare("UPDATE memories SET state = 'archived', updated_at = unixepoch() WHERE id = ?");
    
    for (const dup of duplicates) {
      // Archive the lower-importance one (later in list = lower importance)
      mergeStmt.run(dup.b);
      merged++;
      
      // Create relation
      const relId = 'rel_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      stmts.insertRelation.run(relId, dup.a, dup.b, 'supersede', dup.similarity, JSON.stringify({ auto_merged: true }));
    }
    
    stmts.insertAudit.run('consolidate', workspaceId, null, clientIp, userAgent, 0);
    return { workspace: workspaceId, merged, duplicates_found: duplicates.length };
  }

  // POST /memory/summarize — Generate summary for existing memory
  if (path === '/memory/summarize' && method === 'POST') {
    const mem = stmts.getMemory.get(body.id);
    if (!mem) throw { status: 404, message: 'Memory not found' };
    
    const summary = autoSummarize(mem.content, body.max_sentences || 3);
    
    if (!dryRun) {
      db.prepare("UPDATE memories SET summary = ?, updated_at = unixepoch() WHERE id = ?").run(summary, body.id);
    }
    
    return { id: body.id, summary };
  }

  // GET /memory/stats/detailed — Detailed statistics
  if (path === '/memory/stats/detailed' && method === 'GET') {
    const byKind = db.prepare("SELECT kind, COUNT(*) as count, AVG(importance) as avg_importance FROM memories WHERE workspace_id = ? AND state = 'active' GROUP BY kind").all(workspaceId);
    const byTag = db.prepare("SELECT tags, COUNT(*) as count FROM memories WHERE workspace_id = ? AND state = 'active' GROUP BY tags ORDER BY count DESC LIMIT 20").all(workspaceId);
    const recentActivity = db.prepare("SELECT COUNT(*) as count FROM memories WHERE workspace_id = ? AND created_at > unixepoch() - 86400 * 7 AND state = 'active'").get(workspaceId);
    const totalAccess = db.prepare("SELECT SUM(access_count) as total FROM memories WHERE workspace_id = ? AND state = 'active'").get(workspaceId);
    
    return {
      workspace: workspaceId,
      by_kind: byKind,
      by_tag: byTag,
      recent_7d: recentActivity.count,
      total_accesses: totalAccess.total || 0,
      health: memoryHealth(db.prepare("SELECT * FROM memories WHERE workspace_id = ? AND state = 'active'").all(workspaceId)),
    };
  }

  // POST /memory/dream — Run full autoDream consolidation
  if (path === '/memory/dream' && method === 'POST') {
    const allMemories = db.prepare("SELECT * FROM memories WHERE workspace_id = ? AND state = 'active' ORDER BY importance DESC").all(workspaceId);
    
    // Step 1: Find and merge duplicates
    const duplicates = findDuplicates(allMemories, 0.85);
    let merged = 0;
    const archiveStmt = db.prepare("UPDATE memories SET state = 'archived', updated_at = unixepoch() WHERE id = ?");
    
    for (const dup of duplicates) {
      const pair = allMemories.filter(m => m.id === dup.a || m.id === dup.b);
      if (pair.some(m => m.kind === 'procedure')) continue;  // v3.2
      archiveStmt.run(dup.b);
      const relId = 'rel_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      stmts.insertRelation.run(relId, dup.a, dup.b, 'supersede', dup.similarity, JSON.stringify({ dream_merged: true }));
      merged++;
    }
    
    // Step 2: Auto-summarize memories without summary
    const noSummary = allMemories.filter(m => !m.summary && m.content.length > 100);
    let summarized = 0;
    const summaryStmt = db.prepare("UPDATE memories SET summary = ?, updated_at = unixepoch() WHERE id = ?");
    
    for (const mem of noSummary.slice(0, 50)) { // Limit to 50 per run
      const summary = autoSummarize(mem.content, 2);
      if (summary) {
        summaryStmt.run(summary, mem.id);
        summarized++;
      }
    }
    
    // Step 3: Archive stale low-importance memories
    const staleCutoff = Math.floor(Date.now() / 1000) - 90 * 86400; // 90 days
    const staleLow = allMemories.filter(m => 
      m.created_at < staleCutoff && 
      (!m.access_count || m.access_count < 2) && 
      (m.importance || 0.5) < 0.3 &&
      m.kind !== 'procedure'   // v3.2: procedures are versioned assets, never auto-archived
    );
    let archived = 0;
    for (const mem of staleLow) {
      archiveStmt.run(mem.id);
      archived++;
    }
    
    stmts.insertAudit.run('dream', workspaceId, null, clientIp, userAgent, 0);
    
    return {
      workspace: workspaceId,
      dream_run: true,
      duplicates_merged: merged,
      memories_summarized: summarized,
      stale_archived: archived,
      health_before: memoryHealth(allMemories),
      total_processed: allMemories.length,
    };
  }

  if (path === '/admin/token/create' && method === 'POST') {
    const ownerName = body.owner || 'unnamed';
    const canShared = body.can_write_shared ? 1 : 0;
    const canPublic = body.can_write_public ? 1 : 0;
    
    // Generate new token
    const newToken = randomBytes(32).toString('hex');
    const newHash = createHash('sha256').update(newToken).digest('hex');
    
    db.prepare("INSERT OR REPLACE INTO owner_tokens (token_hash, owner, can_write_shared, can_write_public) VALUES (?, ?, ?, ?)").run(newHash, ownerName, canShared, canPublic);
    
    stmts.insertAudit.run('token-create', workspaceId, null, clientIp, userAgent, 0);
    return { token: newToken, owner: ownerName, can_write_shared: canShared, can_write_public: canPublic };
  }

  // GET /memory/graph — entity timeline (v3.2)
  if (path === '/memory/graph' && method === 'GET') {
    const name = query.entity || '';
    if (!name) return { error: 'entity parameter required' };
    const ents = db.prepare("SELECT * FROM entities WHERE workspace_id = ? AND name LIKE ?").all(workspaceId, `%${name}%`);
    const out = [];
    for (const e of ents) {
      const mems = db.prepare(`
        SELECT m.id, m.content, m.summary, m.kind, m.owner, m.visibility, m.created_at, m.importance
        FROM memories m JOIN memory_entities me ON me.memory_id = m.id
        WHERE me.entity_id = ? AND m.state = 'active'
        ORDER BY m.created_at ASC LIMIT 50
      `).all(e.id);
      out.push({ entity: e.name, type: e.entity_type, memories: mems });
    }
    return { entity: name, count: out.length, results: out };
  }

  // POST /memory/migrate-owner — Migrate existing records to owner system
  if (path === '/memory/migrate-owner' && method === 'POST') {
    const fromWs = body.from_workspace || 'default';
    const fromOwner = body.from_owner || null;
    const toOwner = body.to_owner || body.default_owner || 'default';
    const defaultVis = body.visibility || null;
    
    let sql, params;
    if (fromOwner) {
      // Migrate specific owner to new owner
      sql = "UPDATE memories SET owner = ? WHERE workspace_id = ? AND owner = ?";
      params = [toOwner, fromWs, fromOwner];
      if (defaultVis) {
        sql = "UPDATE memories SET owner = ?, visibility = ? WHERE workspace_id = ? AND owner = ?";
        params = [toOwner, defaultVis, fromWs, fromOwner];
      }
    } else {
      // Migrate records with no owner
      sql = "UPDATE memories SET owner = ? WHERE workspace_id = ? AND (owner IS NULL OR owner = '')";
      params = [toOwner, fromWs];
      if (defaultVis) {
        sql = "UPDATE memories SET owner = ?, visibility = ? WHERE workspace_id = ? AND (owner IS NULL OR owner = '')";
        params = [toOwner, defaultVis, fromWs];
      }
    }
    
    const updated = db.prepare(sql).run(...params);
    
    stmts.insertAudit.run('migrate-owner', workspaceId, null, clientIp, userAgent, 0);
    return { migrated: updated.changes, from_owner: fromOwner, to_owner: toOwner, visibility: defaultVis };
  }

  // 404 fallback
  throw { status: 404, message: `Not found: ${method} ${path}` };
}

// v3: Register admin token with shared write permission
{
  const adminHash = createHash('sha256').update(AUTH_TOKEN).digest('hex');
  try {
    db.prepare("INSERT OR REPLACE INTO owner_tokens (token_hash, owner, can_write_shared, can_write_public) VALUES (?, ?, 1, 1)").run(adminHash, 'admin');
    console.log('[mnemosyne] Admin token registered with shared+public write permission');
  } catch {}
}

// === Start ===
server.listen(PORT, HOST, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║    Mnemosyne v3.0 Multi-Tenant — 记忆女神 · 中心化记忆服务器        ║
╠══════════════════════════════════════════════════════════════╣
║  Endpoint:  http://${HOST}:${PORT}                            ║
║  Auth:      Bearer ${AUTH_TOKEN.slice(0, 16)}...              ║
║  Security:  ✅ Redaction  ✅ Rate Limit  ✅ Audit Log        ║
║  Data:      ${DATA_DIR}                                       ║
╚══════════════════════════════════════════════════════════════╝
`);
});

process.on('SIGTERM', () => { console.log('[mnemosyne] Shutting down...'); db.close(); server.close(); process.exit(0); });
process.on('SIGINT', () => { console.log('[mnemosyne] Shutting down...'); db.close(); server.close(); process.exit(0); });
