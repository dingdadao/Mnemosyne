/**
 * Mnemosyne Database Layer
 * 
 * 存储设计决策：
 * 
 * SQLite (better-sqlite3) 而非 MySQL/PostgreSQL，原因：
 * 1. 记忆数据是"单写入者"场景——只有一个服务器进程写入
 * 2. 数据量可控——记忆不是日志，有 GC 机制，单 workspace 上限 500 条
 * 3. 零运维——不需要额外安装/配置数据库服务
 * 4. 备份简单——复制一个文件即可
 * 5. 性能足够——SQLite 单连接读性能 > MySQL 单连接
 * 
 * 但如果未来需要多写入者或分布式部署，可以无痛迁移到 PostgreSQL。
 * 
 * 表结构：
 * - memories: 主记忆表（时间轴格式）
 * - relations: 关系表（记忆间的关联）
 * - entities: 实体表（人/项目/概念）
 * - timeline: 时间轴索引（高效时间范围查询）
 * - workspaces: 工作区隔离
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

const DEFAULT_DATA_DIR = join(homedir(), '.mnemosyne');
const DEFAULT_DB_PATH = join(DEFAULT_DATA_DIR, 'mnemosyne.db');

export function createDatabase(dbPath = DEFAULT_DB_PATH) {
  // Ensure directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  
  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000'); // 64MB cache

  // Create tables
  db.exec(`
    -- 工作区表：隔离不同项目/环境的记忆
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      config TEXT DEFAULT '{}'
    );

    -- 主记忆表：时间轴格式存储
    -- 每条记忆是一个时间点上的"认知快照"
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      
      -- 内容
      content TEXT NOT NULL,
      summary TEXT,           -- AI 生成的摘要（可选）
      
      -- 分类
      kind TEXT DEFAULT 'fact',  -- fact | preference | decision | procedure | error | episode
      tags TEXT DEFAULT '[]',    -- JSON array
      
      -- 时间轴
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      valid_from INTEGER,        -- 这条记忆什么时候开始有效
      valid_until INTEGER,       -- 什么时候过期（NULL = 永久）
      
      -- 状态
      state TEXT DEFAULT 'active',  -- active | archived | superseded | contradicted
      importance REAL DEFAULT 0.5,  -- 0.0 - 1.0
      
      -- 元数据
      source_session TEXT,      -- 来源会话 ID
      source_agent TEXT,        -- 来源 agent（dsh / claude-code / cursor ...）
      confidence REAL DEFAULT 1.0,
      access_count INTEGER DEFAULT 0,
      last_accessed_at INTEGER,
      
      -- 可验证性
      verification_state TEXT DEFAULT 'unverified',  -- unverified | verified | falsified
      verification_basis TEXT,    -- 验证依据
      
      -- 边界标记（安全）
      sensitivity TEXT DEFAULT 'internal'  -- public | internal | private
    );

    -- 关系表：记忆间的图谱关系
    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      from_memory_id TEXT NOT NULL REFERENCES memories(id),
      to_memory_id TEXT NOT NULL REFERENCES memories(id),
      relation_type TEXT NOT NULL,  -- supersede | contradict | support | derive | relate
      confidence REAL DEFAULT 1.0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      metadata TEXT DEFAULT '{}'
    );

    -- 实体表：提取的人/项目/概念
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL,
      entity_type TEXT DEFAULT 'concept',  -- person | project | concept | tool | place
      attributes TEXT DEFAULT '{}',        -- JSON object
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(workspace_id, name, entity_type)
    );

    -- 记忆-实体关联
    CREATE TABLE IF NOT EXISTS memory_entities (
      memory_id TEXT NOT NULL REFERENCES memories(id),
      entity_id TEXT NOT NULL REFERENCES entities(id),
      relevance REAL DEFAULT 1.0,
      PRIMARY KEY (memory_id, entity_id)
    );

    -- 时间轴索引：高效时间范围查询
    CREATE INDEX IF NOT EXISTS idx_memories_timeline 
      ON memories(workspace_id, created_at DESC);
    
    CREATE INDEX IF NOT EXISTS idx_memories_kind 
      ON memories(workspace_id, kind, state);
    
    CREATE INDEX IF NOT EXISTS idx_memories_state 
      ON memories(workspace_id, state, importance DESC);
    
    CREATE INDEX IF NOT EXISTS idx_memories_tags 
      ON memories(workspace_id, tags);
    
    CREATE INDEX IF NOT EXISTS idx_relations_from 
      ON relations(from_memory_id, relation_type);
    
    CREATE INDEX IF NOT EXISTS idx_relations_to 
      ON relations(to_memory_id, relation_type);
    
    CREATE INDEX IF NOT EXISTS idx_entities_name 
      ON entities(workspace_id, name);
  `);

  // Prepare statements
  const stmts = {
    // Workspace
    insertWorkspace: db.prepare(`
      INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (?, ?, ?)
    `),
    getWorkspace: db.prepare(`
      SELECT * FROM workspaces WHERE id = ?
    `),
    listWorkspaces: db.prepare(`
      SELECT * FROM workspaces ORDER BY created_at
    `),

    // Memory CRUD
    insertMemory: db.prepare(`
      INSERT INTO memories (
        id, workspace_id, content, summary, kind, tags,
        valid_from, valid_until, source_session, source_agent,
        importance, sensitivity
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    
    getMemory: db.prepare(`
      SELECT m.*, 
        (SELECT json_group_array(json_object(
          'id', r.id, 'type', r.relation_type, 
          'to_id', r.to_memory_id, 'confidence', r.confidence
        )) FROM relations r WHERE r.from_memory_id = m.id) as outgoing_relations,
        (SELECT json_group_array(json_object(
          'id', r.id, 'type', r.relation_type,
          'from_id', r.from_memory_id, 'confidence', r.confidence
        )) FROM relations r WHERE r.to_memory_id = m.id) as incoming_relations
      FROM memories m WHERE m.id = ?
    `),
    
    updateMemory: db.prepare(`
      UPDATE memories SET 
        content = COALESCE(?, content),
        summary = COALESCE(?, summary),
        kind = COALESCE(?, kind),
        tags = COALESCE(?, tags),
        updated_at = unixepoch(),
        valid_from = COALESCE(?, valid_from),
        valid_until = COALESCE(?, valid_until),
        state = COALESCE(?, state),
        importance = COALESCE(?, importance),
        verification_state = COALESCE(?, verification_state),
        verification_basis = COALESCE(?, verification_basis)
      WHERE id = ?
    `),
    
    deleteMemory: db.prepare(`
      DELETE FROM memories WHERE id = ?
    `),
    
    // Search
    searchMemories: db.prepare(`
      SELECT * FROM memories 
      WHERE workspace_id = ? 
        AND state = 'active'
        AND (content LIKE ? OR summary LIKE ? OR tags LIKE ?)
      ORDER BY 
        importance DESC,
        last_accessed_at DESC,
        created_at DESC
      LIMIT ? OFFSET ?
    `),
    
    searchByKind: db.prepare(`
      SELECT * FROM memories 
      WHERE workspace_id = ? AND kind = ? AND state = 'active'
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `),
    
    timelineQuery: db.prepare(`
      SELECT * FROM memories 
      WHERE workspace_id = ? 
        AND created_at BETWEEN ? AND ?
        AND state = 'active'
      ORDER BY created_at ASC
      LIMIT ?
    `),
    
    recentMemories: db.prepare(`
      SELECT * FROM memories 
      WHERE workspace_id = ? AND state = 'active'
      ORDER BY created_at DESC
      LIMIT ?
    `),
    
    // Access tracking
    bumpAccess: db.prepare(`
      UPDATE memories SET 
        access_count = access_count + 1,
        last_accessed_at = unixepoch()
      WHERE id = ?
    `),
    
    // Relations
    insertRelation: db.prepare(`
      INSERT INTO relations (id, from_memory_id, to_memory_id, relation_type, confidence, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    
    getRelations: db.prepare(`
      SELECT * FROM relations 
      WHERE from_memory_id = ? OR to_memory_id = ?
    `),
    
    // Entities
    insertEntity: db.prepare(`
      INSERT OR IGNORE INTO entities (id, workspace_id, name, entity_type, attributes)
      VALUES (?, ?, ?, ?, ?)
    `),
    
    linkMemoryEntity: db.prepare(`
      INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, relevance)
      VALUES (?, ?, ?)
    `),
    
    getMemoryEntities: db.prepare(`
      SELECT e.*, me.relevance FROM entities e
      JOIN memory_entities me ON e.id = me.entity_id
      WHERE me.memory_id = ?
    `),
    
    // Stats
    getStats: db.prepare(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN state = 'active' THEN 1 END) as active,
        COUNT(CASE WHEN kind = 'error' THEN 1 END) as errors,
        COUNT(CASE WHEN kind = 'decision' THEN 1 END) as decisions,
        AVG(importance) as avg_importance
      FROM memories WHERE workspace_id = ?
    `),
    
    // Backup
    getAllMemories: db.prepare(`
      SELECT * FROM memories ORDER BY created_at
    `),
    getAllRelations: db.prepare(`
      SELECT * FROM relations ORDER BY created_at
    `),
    getAllEntities: db.prepare(`
      SELECT * FROM entities ORDER BY created_at
    `),
  };

  return { db, stmts, dbPath };
}

// Generate ID
export function genId(prefix = 'mem') {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rand}`;
}
