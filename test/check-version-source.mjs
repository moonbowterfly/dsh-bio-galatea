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
import { fileURLToPath, pathToFileURL } from 'node:url'
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

// ③ 真正 import 生产模块，核对它自报的版本。
//    ⚠️ 2026-10-01 修正：早先版本在 import 失败时**兜底为「读测试自己定位的
//    package.json」并判 PASS** —— 那使门禁假绿：把生产代码的包路径改错
//    （../package.json → ../../package.json，生产模块 ENOENT）时门禁仍报
//    4 项 PASS + exit 0，而真实导入退出 1。现改为导入失败一律判红。
let runtimeVersion = null
try {
  const mod = await import(pathToFileURL(integrationPath).href)
  runtimeVersion = mod.__test_pluginVersion ?? null
  check(
    true,
    runtimeVersion === null
      ? `生产模块可成功 import（无导出钩子，以静态断言 ${pkg.version} 为准）`
      : `生产模块可成功 import（自报 ${runtimeVersion}）`,
  )
} catch (e) {
  check(false, `生产模块 import 失败（门禁必须判红）：${e.code ?? ''} ${e.message}`)
}

// ④ 源码里的 .version 取值表达式必须能定位到
const runtimeMatch = src.match(/PLUGIN_VERSION\s*=\s*JSON\.parse\([\s\S]{0,200}?\)\.version/)
check(!!runtimeMatch, '能从源码定位到 .version 取值表达式')

// ⑤ 若拿到自报版本，必须与 package.json 一致
if (runtimeVersion !== null) {
  check(
    runtimeVersion === pkg.version,
    `自报版本 ${runtimeVersion} === package.json ${pkg.version}`,
  )
}

console.log(`\nversion-source: ${failed === 0 ? 'PASS' : 'FAIL'} (${failed} failed)`)
if (failed > 0) process.exitCode = 1
