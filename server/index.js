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
  
  if (!timingSafeEqual(providedHash, TOKEN_HASH)) {
    stmts.insertAudit.run('auth_failed', null, null, clientIp, userAgent, 0);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized', hint: 'Provide Bearer token in Authorization header' }));
    return;
  }

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
    const result = await route(path, req.method, query, body, clientIp, userAgent);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result, null, 2));
  } catch (err) {
    res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

async function route(path, method, query, body, clientIp, userAgent) {
  const workspaceId = query.workspace || body.workspace || 'default';
  let redactedCount = 0;

  // POST /memory/save — Save a memory (with auto-redaction)
  if (path === '/memory/save' && method === 'POST') {
    const id = body.id || `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    
    // Auto-create workspace
    stmts.insertWorkspace.run(workspaceId, workspaceId, null);
    
    // Redact sensitive data
    const originalContent = body.content || '';
    const redactedContent = redactSensitive(originalContent);
    redactedCount = originalContent !== redactedContent ? 1 : 0;
    
    const redactedSummary = body.summary ? redactSensitive(body.summary) : null;
    
    stmts.insertMemory.run(
      id, workspaceId, redactedContent, redactedSummary,
      body.kind || 'fact',
      JSON.stringify(body.tags || []),
      body.valid_from || Math.floor(Date.now() / 1000),
      body.valid_until || null,
      body.source_session || null,
      body.source_agent || 'unknown',
      body.importance ?? 0.5,
      body.sensitivity || 'internal'
    );

    // Link entities if provided
    if (body.entities && Array.isArray(body.entities)) {
      for (const ent of body.entities) {
        const entId = `ent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        db.prepare("INSERT OR IGNORE INTO entities (id, workspace_id, name, entity_type, attributes) VALUES (?, ?, ?, ?, ?)")
          .run(entId, workspaceId, ent.name, ent.type || 'concept', JSON.stringify(ent.attributes || {}));
        db.prepare("INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, relevance) VALUES (?, ?, ?)")
          .run(id, entId, ent.relevance || 1.0);
      }
    }

    stmts.insertAudit.run('save', workspaceId, id, clientIp, userAgent, redactedCount);
    return { id, status: 'saved', redacted: redactedCount > 0 };
  }

  // GET /memory/get
  if (path === '/memory/get' && method === 'GET') {
    const mem = stmts.getMemory.get(query.id);
    if (!mem) throw { status: 404, message: 'Memory not found' };
    mem.tags = JSON.parse(mem.tags || '[]');
    stmts.bumpAccess.run(query.id);
    stmts.insertAudit.run('read', mem.workspace_id, query.id, clientIp, userAgent, 0);
    return mem;
  }

  // POST /memory/search
  if (path === '/memory/search' && method === 'POST') {
    const q = body.query || '';
    const limit = Math.min(body.limit || 20, 100);
    const offset = body.offset || 0;
    const kind = body.kind;
    
    let results;
    if (kind) {
      results = stmts.searchByKind.all(workspaceId, kind, limit);
    } else {
      const pattern = `%${q}%`;
      results = stmts.searchMemories.all(workspaceId, pattern, pattern, pattern, limit, offset);
    }

    stmts.insertAudit.run('search', workspaceId, null, clientIp, userAgent, 0);
    return {
      query: q, count: results.length,
      results: results.map(m => ({ ...m, tags: JSON.parse(m.tags || '[]') }))
    };
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
      status: 'ok', version: '1.1.0-secure', uptime: process.uptime(),
      workspace: workspaceId, stats: stmts.getStats.get(workspaceId),
      security: { redaction: true, rateLimit: true, auditLog: true }
    };
  }

  // GET /stats
  if (path === '/stats' && method === 'GET') {
    return { workspace: workspaceId, stats: stmts.getStats.get(workspaceId) };
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

  throw { status: 404, message: `Not found: ${method} ${path}` };
}

// === Start ===
server.listen(PORT, HOST, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║    Mnemosyne Secure v1.1 — 记忆女神 · 中心化记忆服务器        ║
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
