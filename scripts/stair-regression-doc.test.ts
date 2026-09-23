import { describe, expect, test } from 'bun:test'
import { basename, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { collectTestInventory } from './run-source-tests'

const REPO_ROOT = join(import.meta.dir, '..')
const SPEC_PATH = join(REPO_ROOT, 'docs/stair-full-regression.md')
const PRODUCT_MODULE_COUNTS: Record<string, number> = {
  APP: 12,
  PROJECT: 10,
  WORKBENCH: 27,
  FILES: 16,
  READER: 2,
  EPUB: 7,
  PDF: 5,
  REFERENCE: 12,
  CHAT: 7,
  BROWSER: 14,
  DRAWNIX: 10,
  RELEASE: 6,
}
const INVARIANT_COUNT = 8
const CASE_PREFIXES = [...Object.keys(PRODUCT_MODULE_COUNTS), 'INV']
const CASE_ID_PATTERN = `(?:${CASE_PREFIXES.join('|')})-\\d{2}`
const PRODUCT_CASE_ID_PATTERN = `(?:${Object.keys(PRODUCT_MODULE_COUNTS).join('|')})-\\d{2}`

function expandCaseIds(value: string): string[] {
  const ids: string[] = []
  const ranges = value.matchAll(new RegExp(
    `\`(${CASE_ID_PATTERN})\`(?:—\`(${CASE_ID_PATTERN})\`)?`,
    'g',
  ))
  for (const range of ranges) {
    const start = range[1]!
    const end = range[2]
    if (!end) {
      ids.push(start)
      continue
    }
    const [startPrefix, startNumber] = start.split('-')
    const [endPrefix, endNumber] = end.split('-')
    if (startPrefix !== endPrefix) throw new Error(`Invalid cross-prefix range: ${range[0]}`)
    for (let number = Number(startNumber); number <= Number(endNumber); number += 1) {
      ids.push(`${startPrefix}-${String(number).padStart(2, '0')}`)
    }
  }
  return ids
}

function collectCases(document: string) {
  const executionSection = document.slice(
    document.indexOf('### 3.1 执行类型'),
    document.indexOf('### 3.2 场景修饰符'),
  )
  const executionById = new Map<string, string>()
  for (const execution of ['AUTO', 'PKG', 'DERIVED']) {
    const line = executionSection.match(new RegExp(
      `^- \`${execution}\` Case(?:或规则)?：(.+)$`,
      'm',
    ))
    if (!line) throw new Error(`Missing ${execution} Case classification`)
    for (const id of expandCaseIds(line[1]!)) {
      if (executionById.has(id)) throw new Error(`Duplicate execution classification: ${id}`)
      executionById.set(id, execution)
    }
  }

  const productCases = [...document.matchAll(new RegExp(
    `^- \`(${PRODUCT_CASE_ID_PATTERN})\`：(.+)\\n  - Expect：(.+)$`,
    'gm',
  ))].map(match => ({
    id: match[1]!,
    execution: executionById.get(match[1]!) ?? 'DEV',
    test: match[2]!.trim(),
    expected: match[3]!.trim(),
  }))
  const invariants = [...document.matchAll(
    /^\| (INV-\d{2}) \| DERIVED \| ([^|]+) \| ([^|]+) \|$/gm,
  )].map(match => ({
    id: match[1]!,
    execution: 'DERIVED',
    test: match[2]!.trim(),
    expected: match[3]!.trim(),
  }))
  const cases = [...productCases, ...invariants]
  for (const id of executionById.keys()) {
    if (!cases.some(item => item.id === id)) throw new Error(`Classified unknown Case: ${id}`)
  }
  return cases
}

describe('Stair full regression specification', () => {
  test('organizes product cases by module, keeps invariants separate, and synchronizes the report', () => {
    const document = readFileSync(SPEC_PATH, 'utf8')
    const cases = collectCases(document)

    expect(cases).toHaveLength(136)
    expect(new Set(cases.map(item => item.id)).size).toBe(cases.length)
    for (const [prefix, count] of [
      ...Object.entries(PRODUCT_MODULE_COUNTS),
      ['INV', INVARIANT_COUNT] as const,
    ]) {
      expect(cases.filter(item => item.id.startsWith(`${prefix}-`)).map(item => item.id))
        .toEqual(Array.from(
          { length: count },
          (_, index) => `${prefix}-${String(index + 1).padStart(2, '0')}`,
        ))
    }

    const report = document.slice(
      document.indexOf('## 20. 回归报告模板'),
      document.indexOf('## 21. 旧 Case ID 迁移索引'),
    )
    const reportIds = [...report.matchAll(new RegExp(
      `^\\| (${CASE_ID_PATTERN}) \\| \\| \\| \\|$`,
      'gm',
    ))].map(match => match[1]!)
    expect(reportIds).toEqual(cases.map(item => item.id))

    const activeSpecification = document.slice(0, document.indexOf('## 21. 旧 Case ID 迁移索引'))
    const referencedIds = new Set(
      [...activeSpecification.matchAll(new RegExp(`\\b${CASE_ID_PATTERN}\\b`, 'g'))]
        .map(match => match[0]!),
    )
    expect([...referencedIds].filter(id => !cases.some(item => item.id === id))).toEqual([])
    expect(document).not.toMatch(/^## \\d+\\. Phase/m)
    expect(document).not.toContain('受影响 Phase')
    expect(document).not.toContain('## Phase results')
    for (const retiredBrowserModel of [
      'Browser Panel',
      'Browser Auxiliary',
      'Browser Surface',
      'browser-workbench.test.ts',
      'browser-surface-geometry.test.ts',
    ]) {
      expect(document).not.toContain(retiredBrowserModel)
    }
    const productDefinitions = document.slice(
      document.indexOf('## 6. APP：产品身份与应用生命周期'),
      document.indexOf('## 18. 跨模块架构不变量'),
    )
    expect(productDefinitions).not.toMatch(
      new RegExp(`^\\| ${PRODUCT_CASE_ID_PATTERN} \\|`, 'm'),
    )
    for (const item of cases.filter(item => !item.id.startsWith('INV-'))) {
      expect(item.test.length, `${item.id} test`).toBeGreaterThan(8)
      expect(item.expected.length, `${item.id} Expect`).toBeGreaterThan(8)
      expect(item.expected, `${item.id} Expect`).not.toMatch(
        /三个动作正常|主链通过|代表性主路径在正式包通过|恢复正确/,
      )
    }
    expect(Object.fromEntries(
      ['AUTO', 'DEV', 'PKG', 'DERIVED'].map(execution => [
        execution,
        cases.filter(item => item.execution === execution).length,
      ]),
    )).toEqual({ AUTO: 22, DEV: 89, PKG: 12, DERIVED: 13 })

    const faultSection = document.slice(
      document.indexOf('### 3.2 场景修饰符'),
      document.indexOf('### 3.3 结果状态'),
    )
    const faultIds = expandCaseIds(faultSection.split('`+FAULT` Case统一为：')[1] ?? '')
    expect(faultIds).toHaveLength(21)
    expect(new Set(faultIds).size).toBe(faultIds.length)
    expect(faultIds.filter(id => !cases.some(item => item.id === id))).toEqual([])

    const moduleDependencies = document.slice(
      document.indexOf('### 3.4 模块验收依赖'),
      document.indexOf('## 4. 标准环境与测试数据'),
    )
    expect(moduleDependencies).not.toMatch(/^\| INV \|/m)
    expect(document).toContain('产品模块 Case 共 128 条')
    expect(document).toContain('`INV` 是 Invariant（不变量）的缩写')

    const craftLines = document.split('\n').filter(line => line.includes('Craft'))
    expect(craftLines).toHaveLength(3)
    expect(craftLines.some(line => line.startsWith('- 一个已有 Craft数据命名空间'))).toBe(true)
    expect(craftLines.some(line => line.startsWith('- `APP-03`：'))).toBe(true)
    expect(craftLines.some(line => line.startsWith('  - Expect：'))).toBe(true)
  })

  test('maps every automated or derived case to exact source evidence', () => {
    const document = readFileSync(SPEC_PATH, 'utf8')
    const inventory = collectTestInventory(REPO_ROOT)
    const filesByName = new Map<string, string[]>()
    for (const path of [...inventory.regular, ...inventory.isolated]) {
      const name = basename(path)
      filesByName.set(name, [...(filesByName.get(name) ?? []), path])
    }

    const cases = collectCases(document)
    const mapping = document.slice(
      document.indexOf('### 19.1 AUTO Case / DERIVED Case与规则精确证据映射'),
      document.indexOf('### 19.2 模块导航'),
    )
    const mappedIds = [...mapping.matchAll(new RegExp(
      `^\\| (${CASE_ID_PATTERN}) \\|`,
      'gm',
    ))].map(match => match[1]!)
    const requiredIds = cases
      .filter(item => item.execution.includes('AUTO') || item.execution === 'DERIVED')
      .map(item => item.id)
    expect(mappedIds.sort()).toEqual(requiredIds.sort())

    const exactEvidence = [...mapping.matchAll(
      /`((?:[^`/]+\/)*[^`/]+(?:\.test\.ts|\.isolated\.ts)) :: ([^`]+)`/g,
    )]
    expect(exactEvidence.length).toBeGreaterThan(30)
    for (const entry of exactEvidence) {
      const fileName = basename(entry[1]!)
      const exactMatches = (filesByName.get(fileName) ?? [])
        .filter(path => readFileSync(path, 'utf8').includes(entry[2]!))
      expect(exactMatches, `${fileName} :: ${entry[2]}`).toHaveLength(1)
    }

    const navigation = document.slice(
      document.indexOf('### 19.2 模块导航'),
      document.indexOf('## 20. 回归报告模板'),
    )
    const navigationModules = [...navigation.matchAll(
      /^\| (INV|APP|PROJECT|WORKBENCH|FILES|READER|EPUB|PDF|REFERENCE|CHAT|BROWSER|DRAWNIX|RELEASE) \|/gm,
    )].map(match => match[1]!)
    expect(navigationModules).toEqual(Object.keys(PRODUCT_MODULE_COUNTS))

    const navigationEntries = [...navigation.matchAll(
      /`((?:[^`/]+\/)*[^`/]+(?:\.test\.ts|\.isolated\.ts))`/g,
    )]
    expect(navigationEntries.length).toBeGreaterThan(30)
    for (const entry of navigationEntries) {
      const fileName = basename(entry[1]!)
      expect(filesByName.get(fileName) ?? [], fileName).not.toHaveLength(0)
    }
  })
})
