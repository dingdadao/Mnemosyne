/**
 * dsh-mnemosyne 插件测试 —— 不依赖真实 dsh 宿主，也不依赖网络。
 *
 * 用假的 ctx 捕获事件监听器，用假的 next() 模拟 dsh 的 pre-step 决策，
 * 用替身 fetch 提供 /memory/brief 的响应，验证三件事：
 *   1. 会话首轮真的把简报追加成一条 recall 消息
 *   2. 工具续跑 / 第二轮 / 空简报 / 服务器挂掉，都不注入、不抛异常
 *   3. 注入消息的 source.kind 是插件命名空间，role 是 user（不是 system）
 *
 *   node --test plugin/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from './index.js';

const BRIEF = '<mnemosyne_memory>\n自动检索自本仓库的记忆库\n- 2026-11-08 · 限流按 token 分桶\n</mnemosyne_memory>';

/** 采集插件注册了哪些监听器 */
function fakeCtx() {
  const handlers = new Map();
  const sections = [];
  const tools = [];
  return {
    handlers,
    sections,
    tools: {
      definitions: tools,
      register(def) {
        tools.push(def);
      },
    },
    on(event, handler, opts) {
      handlers.set(event, { handler, opts });
      return () => handlers.delete(event);
    },
    systemPrompt: {
      section(def) {
        sections.push(def);
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  };
}

function userMessage(text) {
  return {
    id: `u-${text.slice(0, 6)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

/** 一段 pre-step 决策：默认就是"人刚说了一句话" */
function decisionWith(text) {
  return { kind: 'enter', messages: text === undefined ? [] : [userMessage(text)] };
}

function makePayload(sessionId = 's1') {
  return { agent: { session: { header: { id: sessionId, cwd: '/tmp/repo' } } }, signal: new AbortController().signal };
}

/** 替身 fetch：记录调用，返回预设响应 */
function stubFetch(impl) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return impl(url, init);
  };
  return calls;
}

function jsonResponse(obj, status = 200) {
  // 插件用 res.text() 读原文再 JSON.parse（这样非 JSON 的 5xx 也能进日志），
  // 所以替身必须同时提供 text() 和 json()
  const raw = JSON.stringify(obj);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => raw,
    json: async () => obj,
  };
}

function boot(config = {}) {
  const ctx = fakeCtx();
  apply(ctx, { mnemosyneUrl: 'http://127.0.0.1:1', mnemosyneToken: 't', workspace: 'w', ...config });
  const entry = ctx.handlers.get('agent/pre-step');
  return { ctx, preStep: entry?.handler };
}

test('首轮注入简报，作为一条 recall 消息追加在最后', async () => {
  const calls = stubFetch(async () => jsonResponse({ text: BRIEF, stats: { included: 1 } }));
  const { preStep } = boot();
  assert.equal(typeof preStep, 'function', 'pre-step 应当被注册');

  const decision = decisionWith('限流现在是多少来着，帮我改一下');
  const out = await preStep(makePayload('s1'), async () => decision);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/memory\/brief$/);
  assert.equal(calls[0].body.workspace, 'w');
  assert.match(calls[0].body.goal, /限流/);

  assert.equal(out.messages.length, 2);
  const injected = out.messages[1];
  assert.equal(injected.role, 'user');
  assert.equal(injected.source.kind, 'plugin:dsh-mnemosyne');
  assert.equal(injected.source.form, 'recall');
  assert.equal(injected.content[0].text, BRIEF);
});

test('工具续跑（没有新的用户输入）不注入，也不请求服务器', async () => {
  const calls = stubFetch(async () => jsonResponse({ text: BRIEF }));
  const { preStep } = boot();

  const out = await preStep(makePayload('s2'), async () => decisionWith(undefined));

  assert.equal(calls.length, 0);
  assert.deepEqual(out.messages, []);
});

test('同一会话第二轮不重复注入', async () => {
  stubFetch(async () => jsonResponse({ text: BRIEF }));
  const { preStep } = boot();

  const first = await preStep(makePayload('s3'), async () => decisionWith('第一轮'));
  assert.equal(first.messages.length, 2);

  const second = await preStep(makePayload('s3'), async () => decisionWith('第二轮'));
  assert.equal(second.messages.length, 1);
});

test('briefEveryTurn=true：内容变了就再注入，内容一样就不叠第二份', async () => {
  let n = 0;
  stubFetch(async () => jsonResponse({ text: `${BRIEF}\n<!-- v${++n} -->` }));
  const { preStep } = boot({ briefEveryTurn: true });

  await preStep(makePayload('s4'), async () => decisionWith('第一轮'));
  const second = await preStep(makePayload('s4'), async () => decisionWith('第二轮'));
  assert.equal(second.messages.length, 2);
});

test('briefEveryTurn=true 但内容与上一轮完全相同：不重复堆叠', async () => {
  stubFetch(async () => jsonResponse({ text: BRIEF }));
  const { preStep } = boot({ briefEveryTurn: true });

  await preStep(makePayload('s4b'), async () => decisionWith('第一轮'));
  const second = await preStep(makePayload('s4b'), async () => decisionWith('第二轮'));
  assert.equal(second.messages.length, 1);
});

test('简报为空字符串时什么都不注入（正常结果，不是失败）', async () => {
  stubFetch(async () => jsonResponse({ text: '', stats: { included: 0 } }));
  const { preStep } = boot();

  const out = await preStep(makePayload('s5'), async () => decisionWith('今天天气不错'));
  assert.equal(out.messages.length, 1);
});

test('服务器连不上：不抛异常、不注入、不阻塞这一轮', async () => {
  stubFetch(async () => {
    throw new Error('connect ECONNREFUSED');
  });
  const { preStep } = boot();

  const out = await preStep(makePayload('s6'), async () => decisionWith('帮我看看'));
  assert.equal(out.messages.length, 1);
});

test('HTTP 500 同样静默降级', async () => {
  stubFetch(async () => jsonResponse({ error: 'boom' }, 500));
  const { preStep } = boot();

  const out = await preStep(makePayload('s7'), async () => decisionWith('帮我看看'));
  assert.equal(out.messages.length, 1);
});

test('被拒绝的决策原样返回，不触发检索', async () => {
  const calls = stubFetch(async () => jsonResponse({ text: BRIEF }));
  const { preStep } = boot();

  const rejected = { kind: 'reject', reason: 'test' };
  const out = await preStep(makePayload('s8'), async () => rejected);
  assert.equal(out, rejected);
  assert.equal(calls.length, 0);
});

test('enableBrief=false 时不注册注入逻辑', async () => {
  stubFetch(async () => jsonResponse({ text: BRIEF }));
  const { ctx } = boot({ enableBrief: false });
  // 关闭后仍然注册了 pre-step（代码路径简单），但不会检索
  const handler = ctx.handlers.get('agent/pre-step')?.handler;
  const out = await handler(makePayload('s9'), async () => decisionWith('随便说点'));
  assert.equal(out.messages.length, 1);
});

test('注册了 memory_brief 工具，且工作区参数被带上', async () => {
  const calls = stubFetch(async () => jsonResponse({ text: BRIEF }));
  const { ctx } = boot();

  const tool = ctx.tools.definitions.find((t) => t.name === 'memory_brief');
  assert.ok(tool, 'memory_brief 应当注册');

  const res = await tool.execute({ goal: '检索质量' });
  assert.equal(res.text, BRIEF);
  assert.equal(calls[0].body.workspace, 'w');
});
