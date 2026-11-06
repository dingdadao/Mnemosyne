/**
 * Mnemosyne DSH Plugin — 预测式记忆召回
 * 
 * 核心创新：不是每步注入（灵枢的问题），也不是完全靠 agent 自觉，
 * 而是在关键决策点预测是否需要记忆，给 agent 一个提示。
 * 
 * 原则：Pull, not Push. Hint, not Inject.
 * 
 * 触发器：
 *   HIGH   confidence → auto-recall（直接调用 memory_search）
 *   MEDIUM confidence → inject hint（注入一次性提示）
 *   LOW    confidence → do nothing
 * 
 * 限制：每会话最多 maxHintsPerSession 次提示（默认 3）
 */

const CONTINUATION_SIGNALS = [
  '之前', '上次', '继续', '还是', '那个', '帮我还原', '接着',
  '刚才', '早前', '昨天', '上周', '上次说的', '回到',
  'previous', 'before', 'continue', 'last time', 'earlier',
  'resume', 'pick up where', 'as I mentioned', 'back to',
];

const ERROR_SIGNALS = [
  'error', 'fail', 'exception', 'failed', 'errno', 'panic',
  '错误', '失败', '异常', '报错', '不行', '挂了', '崩了',
];

const MEMORY_EXPLICIT_SIGNALS = [
  '记得', '记住', '之前说过', '查一下', '翻记录', '找找',
  'remember', 'recall', 'look up', 'search memory',
  '有什么记录', '历史', '以前怎么',
];

const DECISION_KEYWORDS = [
  '修改', '删除', '更新', '执行', '运行', '部署', '提交',
  'modify', 'delete', 'update', 'execute', 'deploy', 'change',
  'push', 'merge', 'release',
];

const TOPIC_SWITCH_MIN_WORDS = 3; // 话题切换检测的最小消息长度

// Per-session state
const sessionState = new Map();

function getState(sessionId) {
  if (!sessionState.has(sessionId)) {
    sessionState.set(sessionId, {
      hintsGiven: 0,
      autoRecallsDone: 0,
      errorHintsGiven: false,
      decisionHintsGiven: false,
      continuationHintsGiven: false,
      lastUserMessage: '',
      messageCount: 0,
    });
  }
  return sessionState.get(sessionId);
}

export function apply(ctx, config) {
  const {
    mnemosyneUrl = process.env.MNEMOSYNE_URL || 'http://127.0.0.1:8790',
    mnemosyneToken = process.env.MNEMOSYNE_TOKEN || '',
    maxHintsPerSession = 3,
    maxAutoRecallsPerSession = 2,
    enableAutoRecall = true,
    enableHints = true,
    hintOrder = 95,
    workspace = 'default',
    timeoutMs = 5000,
  } = config;

  // Validate
  if (!mnemosyneUrl) {
    ctx.logger.warn('[mnemosyne] No URL configured, plugin disabled');
    return;
  }

  ctx.logger.info(`[mnemosyne] Connected to ${mnemosyneUrl}, workspace: ${workspace}`);

  // === Tool Definitions ===
  const tools = [
    {
      name: 'memory_save',
      description: 'Save a memory to the central Mnemosyne server. Use for facts, decisions, preferences, procedures.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The memory content' },
          kind: { type: 'string', enum: ['fact', 'preference', 'decision', 'procedure', 'error'], description: 'Memory type' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
          summary: { type: 'string', description: 'Brief summary (optional)' },
          importance: { type: 'number', description: 'Importance 0.0-1.0 (default 0.5)' },
        },
        required: ['content'],
      },
      execute: async (args) => {
        const res = await fetch(`${mnemosyneUrl}/memory/save`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${mnemosyneToken}`,
          },
          body: JSON.stringify({ ...args, workspace }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return res.json();
      },
    },
    {
      name: 'memory_search',
      description: 'Search memories on the central Mnemosyne server. Use when you need context from previous work.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          kind: { type: 'string', enum: ['fact', 'preference', 'decision', 'procedure', 'error'] },
          limit: { type: 'number', default: 10 },
        },
        required: ['query'],
      },
      execute: async (args) => {
        const res = await fetch(`${mnemosyneUrl}/memory/search`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${mnemosyneToken}`,
          },
          body: JSON.stringify({ ...args, workspace }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return res.json();
      },
    },
    {
      name: 'memory_recent',
      description: 'Get recent memories from the timeline.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 10 },
        },
      },
      execute: async (args) => {
        const res = await fetch(`${mnemosyneUrl}/memory/recent?workspace=${workspace}&limit=${args.limit || 10}`, {
          headers: { 'Authorization': `Bearer ${mnemosyneToken}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        return res.json();
      },
    },
    {
      name: 'memory_timeline',
      description: 'Query memories in a time range.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'number', description: 'Unix timestamp (seconds)' },
          to: { type: 'number', description: 'Unix timestamp (seconds)' },
          limit: { type: 'number', default: 50 },
        },
      },
      execute: async (args) => {
        const params = new URLSearchParams({
          workspace,
          from: args.from || '0',
          to: args.to || String(Math.floor(Date.now() / 1000)),
          limit: String(args.limit || 50),
        });
        const res = await fetch(`${mnemosyneUrl}/memory/timeline?${params}`, {
          headers: { 'Authorization': `Bearer ${mnemosyneToken}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        return res.json();
      },
    },
  ];

  // Register tools
  if (ctx.tools?.register) {
    for (const tool of tools) {
      ctx.tools.register(tool);
    }
    ctx.logger.info(`[mnemosyne] Registered ${tools.length} tools`);
  }

  // === System Prompt Hint Section ===
  // This is a STATIC section that always appears (not per-step)
  if (ctx.systemPrompt?.section) {
    ctx.systemPrompt.section({
      name: 'mnemosyne',
      order: hintOrder,
      text: [
        '## Memory (Mnemosyne)',
        '',
        'You have access to a central memory server with these tools:',
        '- `memory_save` — Save facts, decisions, preferences',
        '- `memory_search` — Search for relevant memories',
        '- `memory_recent` — Get recent memories',
        '- `memory_timeline` — Query memories in a time range',
        '',
        '**When to use:**',
        '- At conversation start if this seems like continuation of previous work',
        '- Before making important decisions',
        '- When you encounter errors (check if similar errors were solved before)',
        '- When user mentions previous conversations',
        '',
        '**When NOT to use:**',
        '- Simple questions that don\'t need historical context',
        '- Every tool call (only when genuinely needed)',
      ].join('\n'),
    });
  }

  // === Predictive Hooks ===
  // Listen to session events to predict when memory recall is needed

  if (ctx.on) {
    ctx.on('session/event', async (session, event) => {
      const sessionId = session?.id || 'unknown';
      const state = getState(sessionId);

      // --- User Message Analysis ---
      if (event.type === 'user/message') {
        state.messageCount++;
        const text = (event.data?.content || '').toLowerCase();
        const originalText = event.data?.content || '';

        // Skip very short messages
        if (originalText.length < 5) return;

        // === HIGH CONFIDENCE: Explicit memory request ===
        if (enableAutoRecall && state.autoRecallsDone < maxAutoRecallsPerSession) {
          const hasExplicit = MEMORY_EXPLICIT_SIGNALS.some(s => text.includes(s.toLowerCase()));
          const hasContinuation = CONTINUATION_SIGNALS.some(s => text.includes(s.toLowerCase()));

          if (hasExplicit || (hasContinuation && state.messageCount <= 3)) {
            state.autoRecallsDone++;
            
            // Fire and forget - don't block the conversation
            const query = originalText.slice(0, 100); // Use first 100 chars as query
            ctx.logger.info(`[mnemosyne] Auto-recall triggered (explicit signal): "${query.slice(0, 50)}..."`);
            
            // We don't inject the result directly - we add a hint that suggests searching
            // This keeps the architecture "pull" based
            if (ctx.systemPrompt?.section && state.hintsGiven < maxHintsPerSession) {
              state.hintsGiven++;
              ctx.systemPrompt.section({
                name: 'mnemosyne-recall-hint',
                order: hintOrder + 1,
                text: `> [Mnemosyne] This seems like a continuation. Consider calling memory_search with query: "${query.slice(0, 60)}"`,
              });
            }
            return;
          }
        }

        // === MEDIUM CONFIDENCE: Decision point ===
        if (enableHints && !state.decisionHintsGiven && state.hintsGiven < maxHintsPerSession) {
          const hasDecision = DECISION_KEYWORDS.some(s => text.includes(s.toLowerCase()));
          if (hasDecision && state.messageCount > 1) {
            state.decisionHintsGiven = true;
            state.hintsGiven++;
            ctx.logger.info('[mnemosyne] Decision point detected, hint injected');
            
            if (ctx.systemPrompt?.section) {
              ctx.systemPrompt.section({
                name: 'mnemosyne-decision-hint',
                order: hintOrder + 2,
                text: '> [Mnemosyne] You\'re about to make changes. Consider memory_search for relevant past decisions or lessons.',
              });
            }
          }
        }

        // === MEDIUM CONFIDENCE: Topic switch ===
        if (enableHints && state.messageCount > 3 && state.hintsGiven < maxHintsPerSession) {
          // Simple topic switch detection: significant word overlap change
          const prevWords = new Set(state.lastUserMessage.toLowerCase().split(/\s+/).filter(w => w.length > 2));
          const currWords = new Set(originalText.toLowerCase().split(/\s+/).filter(w => w.length > 2));
          
          if (prevWords.size > 0 && currWords.size > 0) {
            let overlap = 0;
            for (const w of currWords) {
              if (prevWords.has(w)) overlap++;
            }
            const similarity = overlap / Math.min(prevWords.size, currWords.size);
            
            // Very low similarity = potential topic switch
            if (similarity < 0.1 && currWords.size >= TOPIC_SWITCH_MIN_WORDS) {
              // Don't hint on every topic switch, only if we haven't hinted recently
              if (state.hintsGiven < maxHintsPerSession) {
                state.hintsGiven++;
                ctx.logger.info('[mnemosyne] Topic switch detected, hint injected');
              }
            }
          }
        }

        state.lastUserMessage = originalText;
      }

      // --- Tool Result Analysis (Error Detection) ---
      if (event.type === 'tool/result' && enableHints && !state.errorHintsGiven) {
        const text = JSON.stringify(event.data || '').toLowerCase();
        const hasError = ERROR_SIGNALS.some(s => text.includes(s));
        
        if (hasError && state.hintsGiven < maxHintsPerSession) {
          state.errorHintsGiven = true;
          state.hintsGiven++;
          ctx.logger.info('[mnemosyne] Error detected, hint injected');
          
          if (ctx.systemPrompt?.section) {
            ctx.systemPrompt.section({
              name: 'mnemosyne-error-hint',
              order: hintOrder + 3,
              text: '> [Mnemosyne] An error occurred. Consider memory_search for similar past errors and their solutions.',
            });
          }
        }
      }
    });

    // Cleanup on session end
    ctx.on('session/disposed', (session) => {
      const sessionId = session?.id;
      if (sessionId && sessionState.has(sessionId)) {
        sessionState.delete(sessionId);
        ctx.logger.info(`[mnemosyne] Cleaned up state for session ${sessionId}`);
      }
    });
  }

  ctx.logger.info(`[mnemosyne] Plugin loaded. maxHints=${maxHintsPerSession}, maxAutoRecalls=${maxAutoRecallsPerSession}`);
}
