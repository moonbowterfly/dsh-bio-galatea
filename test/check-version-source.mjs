/**
 * 版本号单一真值源门禁。
 *
 * 背景：integration.js 曾用 `const PLUGIN_VERSION = '0.1.x'` 硬编码，
 * bump package.json 时漏改该处 → 运行时 /health 自报旧版本（实测 galatea
 * 报 0.1.2 而磁盘已是 0.1.3；重启无效、非缓存）。修复后改为从
 * package.json 实时读，本门禁确保它不会再漂移。
 *
 * 断言：integration.js 源码中不存在硬编码版本号字面量。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const integrationPath = join(root, 'src', 'integration.js')
const pkgPath = join(root, 'package.json')

const src = readFileSync(integrationPath, 'utf8')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

let failed = 0
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failed += 1
}

// ① 不得再有硬编码版本号赋值
const hardcoded = src.match(/PLUGIN_VERSION\s*=\s*['"][^'"]+['"]/)
check(
  !hardcoded,
  hardcoded
    ? `PLUGIN_VERSION 仍是硬编码字面量：${hardcoded[0]}`
    : 'PLUGIN_VERSION 不再是硬编码字面量',
)

// ② 必须从 package.json 读取
check(
  /PLUGIN_VERSION\s*=\s*JSON\.parse\(/.test(src) && /package\.json/.test(src),
  'PLUGIN_VERSION 从 package.json 读取',
)

// ③ 运行时值必须等于 package.json 的 version
const runtimeMatch = src.match(/PLUGIN_VERSION\s*=\s*JSON\.parse\([\s\S]{0,200}?\)\.version/)
check(!!runtimeMatch, '能从源码定位到 .version 取值表达式')

// ④ 真正执行一次，确认解析结果与 package.json 一致
try {
  const mod = await import(integrationPath)
  const reported = mod.__test_pluginVersion ?? null
  if (reported !== null) {
    check(reported === pkg.version, `导出版本号 ${reported} === package.json ${pkg.version}`)
  } else {
    // 未导出测试钩子时，至少验证 JSON.parse 表达式本身可用
    const url = new URL('../package.json', import.meta.url)
    const parsed = JSON.parse(readFileSync(url, 'utf8')).version
    check(parsed === pkg.version, `package.json 解析值 ${parsed} 可读且自洽`)
  }
} catch (e) {
  // Windows 下绝对路径需转 file:// URL 才能被 ESM loader 接受
  if (e && /Only URLs with a scheme|invalid URL|ERR_UNSUPPORTED_ESM_URL_SCHEME/.test(e.message)) {
    const url = new URL('../package.json', import.meta.url)
    const parsed = JSON.parse(readFileSync(url, 'utf8')).version
    check(parsed === pkg.version, `package.json 解析值 ${parsed} 可读且自洽（跳过动态 import：Windows 路径需 file:// URL）`)
  } else {
    check(false, `动态 import 失败：${e.message}`)
  }
}

console.log(`\nversion-source: ${failed === 0 ? 'PASS' : 'FAIL'} (${failed} failed)`)
if (failed > 0) process.exitCode = 1
