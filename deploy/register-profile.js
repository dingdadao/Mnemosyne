#!/usr/bin/env node
/**
 * 把已复制到 profile/node_modules 的 dsh-mnemosyne 注册进 profile。
 *
 * 做三件事（缺一不可）：
 *   1. node_modules/dsh-mnemosyne/            —— 文件就位（由 install-plugin.sh 复制）
 *   2. package.json → dsh.profile.bundles     —— 注册 bundle，否则宿主根本不加载
 *   3. cordis.patch.yml → `- id: mnemosyne`   —— 只覆盖 config，条目由插件自带 patch 引入
 *
 * 用法：
 *   node register-profile.js --profile-dir ~/.dsh/profiles/desktop \
 *        --url https://mnemosyne.example.com --token xxx
 *   node register-profile.js --profile-dir ~/.dsh/profiles/desktop --verify
 */

import fs from 'node:fs'
import path from 'node:path'

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const has = (name) => process.argv.includes(`--${name}`)

const profileDir = arg('profile-dir', path.join(process.env.HOME || '', '.dsh/profiles/desktop'))
const url = arg('url', process.env.MNEMOSYNE_URL || 'http://127.0.0.1:8790')
const token = arg('token', process.env.MNEMOSYNE_TOKEN || '')
const pkgPath = path.join(profileDir, 'package.json')
const patchPath = path.join(profileDir, 'cordis.patch.yml')
const pluginDir = path.join(profileDir, 'node_modules/dsh-mnemosyne')

const q = (v) => `'${String(v).replace(/'/g, "''")}'`

function registerBundle() {
  if (!fs.existsSync(pkgPath)) throw new Error(`profile package.json 不存在: ${pkgPath}`)
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  pkg.dsh ??= {}
  pkg.dsh.profile ??= {}
  pkg.dsh.profile.bundles ??= []
  const added = !pkg.dsh.profile.bundles.includes('dsh-mnemosyne')
  if (added) pkg.dsh.profile.bundles.push('dsh-mnemosyne')
  pkg.dependencies ??= {}
  pkg.dependencies['dsh-mnemosyne'] = 'file:node_modules/dsh-mnemosyne'
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  return added
}

function writeConfigOverride() {
  const block = [
    '- id: mnemosyne',
    '  config:',
    `    mnemosyneUrl: ${q(url)}`,
    `    mnemosyneToken: ${q(token)}`,
    '    maxHintsPerSession: 3',
    '    maxAutoRecallsPerSession: 2',
    '    enableAutoRecall: true',
    '    enableHints: true',
    '    hintOrder: 95',
    "    workspace: 'default'",
    '    timeoutMs: 10000',
  ]

  const text = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : ''
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.trim() === '- id: mnemosyne')

  if (start >= 0) {
    // 覆盖已有条目：从 `- id: mnemosyne` 到下一个顶格 `- ` 之前
    let end = start + 1
    while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1
    lines.splice(start, end - start, ...block)
    fs.writeFileSync(patchPath, lines.join('\n'))
    return 'replaced'
  }

  let out = text
  if (out.length && !out.endsWith('\n')) out += '\n'
  out += (out.trim().length ? '\n' : '') + block.join('\n') + '\n'
  fs.writeFileSync(patchPath, out)
  return 'appended'
}

function verify() {
  const problems = []
  let pkg = {}
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  } catch {
    problems.push('profile package.json 读取失败')
  }
  const inBundles = (pkg?.dsh?.profile?.bundles || []).includes('dsh-mnemosyne')
  if (!inBundles) problems.push('未在 dsh.profile.bundles 中注册')

  const entry = path.join(pluginDir, 'index.js')
  const exists = fs.existsSync(entry)
  if (!exists) problems.push('node_modules/dsh-mnemosyne/index.js 不存在')

  const src = exists ? fs.readFileSync(entry, 'utf8') : ''
  const hasInject = /export const inject\s*=/.test(src)
  if (!hasInject) problems.push('index.js 缺少 export const inject（宿主会静默不 apply）')

  let hasBundlePatch = false
  try {
    const pp = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
    hasBundlePatch = Boolean(pp?.dsh?.bundle?.patch)
  } catch {
    problems.push('插件 package.json 读取失败')
  }
  if (!hasBundlePatch) problems.push('插件 package.json 缺少 dsh.bundle.patch')

  const configured = fs.existsSync(patchPath) && fs.readFileSync(patchPath, 'utf8').includes('- id: mnemosyne')
  if (!configured) problems.push('cordis.patch.yml 未写入配置覆盖')

  const rows = [
    ['bundles 注册', inBundles],
    ['index.js 存在', exists],
    ['inject 声明', hasInject],
    ['dsh.bundle.patch', hasBundlePatch],
    ['配置覆盖', configured],
  ]
  for (const [label, ok] of rows) console.log(`  ${ok ? '✓' : '✗'} ${label}`)

  if (problems.length) {
    console.error('\n安装校验未通过：')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  return true
}

if (has('verify')) {
  verify()
} else {
  const added = registerBundle()
  const action = writeConfigOverride()
  console.log(`  bundle ${added ? '已新增' : '已存在'}；配置 ${action === 'replaced' ? '已更新' : '已追加'}`)
  verify()
}
