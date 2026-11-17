# 插件加载失败复盘：一次 fiber 静默 FAILED 的四层排查

> 时间：2026-11-17 · 环境：DSH 桌面版（Electron，打包运行时）
> 症状：重启后 `memory_*` 工具一个都不出现，插件文件语法正确、能正常 import、条目也确实在 loader 树里，但**任何日志都没有**。

## TL;DR

```js
export const inject = ['tools', 'systemPrompt'];
```

缺这一行，宿主会静默判定插件失败。**不是加载失败，是加载了但 `apply()` 从未被调用。**

cordis 有服务访问守卫：插件没在 `inject` 里声明依赖，读 `ctx.tools` 时直接抛
`Error: cannot get property "tools" without inject`。这个异常发生在 `apply` 体内，fiber 转为
FAILED，宿主不打印、不提示、不中断启动——于是表现成"插件装了个寂寞"。

---

## 一、根因链（四层，逐层剥开）

前三次修复每次都只推进到下一层，所以每次都以为"应该好了"。

| 层 | 缺陷 | 直接表现 | 修法 |
|---|---|---|---|
| 1 | `const { url: process.env.X \|\| 'y' } = config` —— 解构目标位置写表达式 | `SyntaxError: Invalid destructuring assignment target`，模块解析失败 | 改回 `url = process.env.X \|\| 'y'` |
| 2 | 工具定义缺 `output { schema, render }` | `TypeError: tool "x" must declare output`，`register()` 抛错 | 每个工具补 `output` |
| 3 | `ctx.logger.info(...)` 未守卫 | 宿主无 logger 时进 apply 就抛 | 全改可选链 `ctx.logger?.info?.()` |
| 4 | **未声明 `inject`** | **`cannot get property "tools" without inject`，fiber FAILED，apply 不执行** | **`export const inject = [...]`** |

第 4 层是总开关。前三层都修完仍然"毫无反应"，就是因为它。

---

## 二、为什么这么难查：三层静默叠加

1. **注册静默**：`tools.register()` 校验失败抛异常，但这个异常发生在 `apply` 里，宿主不向外冒泡。
2. **fiber 静默**：插件实例状态变 FAILED，宿主启动不中断、不提示，界面一切正常。
3. **日志静默**：用来"第一句留痕"的诊断代码自己就在读 `ctx.logger`——守卫先把它炸了，所以诊断日志一条都写不出来。

三件事叠在一起，形成"改了、重启了、还是没反应、而且没有任何信息"的死循环。

### cordis 守卫的实现（`@deepseek-ai/cordis`）

```js
get: (target, prop, ctx) => {
  if (isSpecialProperty(prop)) return Reflect.get(target, prop, ctx);
  if (Reflect.has(target, prop)) return getTraceable(ctx, Reflect.get(target, prop, ctx));
  const error = new Error(`cannot get property "${prop}" without inject`);
  ...
}
```

依赖声明格式（`Inject.resolve`）：数组 = 必需服务名；对象 = `{ 服务名: 拦截配置 | null }`。

```js
export const inject = ['tools', 'systemPrompt'];   // 两个服务缺失时插件保持 PENDING
export const inject = { tools: null, systemPrompt: null };  // 等价写法
```

---

## 三、排障方法论（可复用）

### 3.1 探针插件：把运行时树打出来

造一个临时 bundle，在**模块顶层**和 **apply 内**各写一行日志，并 dump `ctx.loader.entries()`：

```js
import { appendFileSync } from 'node:fs'
const LOG = `${process.env.HOME}/.dsh/profiles/desktop/zz-probe.log`
const log = (m) => { try { appendFileSync(LOG, `${new Date().toISOString()} [pid ${process.pid}] ${m}\n`) } catch {} }

log('module imported')            // 模块是否被导入

export function apply(ctx) {
  log('apply called')             // apply 是否被调用
  for (const e of ctx.loader.entries()) {
    const o = e.options ?? {}
    log(`  - id=${o.id} name=${o.name} fiber=${String(e.fiber?.state)}`)
  }
}
```

观察到的关键输出：

```
- id=mnemosyne name=dsh-mnemosyne fiber=5 disabled=false
module imported          ← 模块导入成功
（无 apply called）       ← apply 从未执行
```

一条输出就排除了"没装上/没解析/没进树"三种可能，把范围锁死在"进了树但 apply 不跑"。

### 3.2 fiber 状态码

| 值 | 含义 | 判定 |
|---|---|---|
| 0 | PENDING | `inject` 声明的服务还没就绪 |
| 2 | ACTIVE | 正常 |
| 3 | FAILED | apply 抛异常（**本例**） |

用最小插件实测得出：

```js
ctx.plugin({ apply() {} })                        // 2
ctx.plugin({ apply() { throw new Error('boom') } })// 3
ctx.plugin({ inject: ['neverProvided'], apply(){} })// 0
```

### 3.3 离线复刻宿主：把被吞掉的异常抓出来

不必重启应用，用真实的 `@deepseek-ai/cordis` + 真实 `@deepseek-ai/dsh-tools` 的 `ToolRegistry`，
再复刻 loader 的 `unwrapExports`，把模块命名空间交给 `ctx.plugin()`：

```js
function unwrapExports(e) {          // 与 @deepseek-ai/cordis-plugin-loader 一致
  if (e == null) return e
  e = e.default ?? e
  if (!e.__esModule) return e
  return e.default ?? e
}

const ns = await import('./plugin/index.js')
const ctx = new Context()
await ctx.plugin(FakePrompt)         // 提供 systemPrompt 服务的替身
await ctx.plugin(ToolRegistry)
const fiber = ctx.plugin(unwrapExports(ns), config)
```

包装一层就能看到被吞的报错：

```js
ctx.plugin({ name: 'wrapper', apply(c, cfg) {
  try { ns.apply(c, cfg) } catch (e) { console.log('>>>', e.message) }  // → cannot get property "tools" without inject
}})
```

修复前后对照（真实注册表实测）：

```
--- 修复前 ---  fiber=3 (FAILED) | 注册工具数=0
--- 修复后 ---  fiber=2 (ACTIVE) | 注册工具数=5
```

### 3.4 HMR：改文件即可生效，不必重启

`dsh-hmr` 监听插件文件，改动后自动重新导入并 apply。验证方式：改一行注释，观察诊断日志里出现新 pid 的 `apply entered`。

> 注意：仅当插件**已经**能被成功 apply 时才有意义；fiber 处于 FAILED 时改文件同样会触发重载，这正是本例最终的生效方式。

---

## 四、修复 diff

```diff
+// cordis 服务访问守卫：未在 inject 中声明的服务，读取时抛
+// "cannot get property \"tools\" without inject"，插件 fiber 静默 FAILED。
+export const inject = ['tools', 'systemPrompt'];
+
 export function apply(ctx, config) {
```

同时修掉一处**安装即失败**的清单问题：作为 bundle 引入时，宿主要求包内声明 patch 路径。

```diff
   "dsh": {
-    "plugin": true
+    "plugin": true,
+    "bundle": { "patch": "./cordis.patch.yml" }
   },
```

缺这一项时宿主直接拒绝：

```
dsh: profile bundle "dsh-mnemosyne" declares no dsh.bundle in its package.json
```

### 回归测试

新增用例（`plugin/index.test.mjs`），不需要真实宿主即可拦住同类回归：

```js
test('声明了 cordis 服务依赖（inject），否则宿主静默不 apply', async () => {
  const ns = await import('./index.js');
  assert.ok(Array.isArray(ns.inject));
  assert.ok(ns.inject.includes('tools'));
  assert.ok(ns.inject.includes('systemPrompt'));
});
```

> 为什么之前的测试拦不住：原测试直接调用 `apply(fakeCtx, config)`，绕过了 cordis 的守卫。
> **凡是"手动构造 ctx 直接调 apply"的测试，都无法发现 inject 缺失。**

---

## 五、发布前检查清单

装/改 DSH 插件后，按此顺序过一遍：

- [ ] `node --check index.js` —— 语法
- [ ] `export const inject = [...]` —— 列出了所有用到的服务（`tools` / `systemPrompt` / `llm` / `session` …）
- [ ] 每个工具都有 `output: { schema, render }`
- [ ] `ctx.logger?.x?.()` 全部可选链
- [ ] `package.json` 有 `dsh.bundle.patch`（要作为 bundle 引入时）
- [ ] 用**真实 cordis + 真实注册表**跑一遍，确认 `fiber=2` 且工具数正确
- [ ] 宿主侧验证：`apply` 里的第一行诊断日志真的打出来了

---

## 附：一次完整的时间线（供参考）

| 时间 | 动作 | 结果 |
|---|---|---|
| 23:05 | 修解构语法 | 仍无工具（第 2 层未暴露） |
| 23:17 | 补 `output`，登记真实注册表 4/4 | 仍无工具（第 3 层未暴露） |
| 23:20 | logger 全改可选链 | 仍无工具、**无日志** |
| 23:22 | 改成 bundle 形态 | 仍无日志 |
| 23:25 | 探针 dump 运行时树 | 发现 `fiber=5`、模块已导入、apply 未执行 |
| 23:27 | 复刻宿主抓异常 | `without inject` → 加 `inject` → `fiber=2`，现场 HMR 生效，4/4 工具 |

教训：**先建立可观测性（探针 + 状态码），再改代码。** 前三次都是盲改，每次只验证到"下一个症状"。
