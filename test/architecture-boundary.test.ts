import { readFileSync, readdirSync, statSync } from 'fs'
import { resolve, extname } from 'path'

interface BoundaryRule {
  file: string
  forbiddenPatterns: string[]
  description: string
}

interface RequiredImportRule {
  file: string
  requiredPatterns: string[]
  description: string
}

const BOUNDARY_RULES = [
  {
    file: 'src/translator/outbound.ts',
    forbiddenPatterns: [
      '../translator/inbound',
      './inbound',
      'orchestrator',
      'src/index',
      'deepseek_api/client',
    ],
    description: 'outbound.ts must not depend on inbound, orchestrator, src/index, or deepseek_api/client',
  },
  {
    file: 'src/translator/inbound.ts',
    forbiddenPatterns: [
      '../translator/outbound',
      './outbound',
      'request.ts',
      'orchestrator',
      'src/index',
      'deepseek_api/client',
    ],
    description: 'inbound.ts must not depend on outbound, request.ts, orchestrator, src/index, or deepseek_api/client',
  },
  {
    file: 'src/orchestrator/completion.ts',
    forbiddenPatterns: [
      'src/index',
    ],
    description: 'orchestrator/completion.ts must not depend on src/index',
  },
  {
    file: 'src/deepseek_api',
    forbiddenPatterns: [
      'translator/',
      'orchestrator/',
      'src/index',
    ],
    description: 'deepseek_api must not import from translator, orchestrator, or src/index',
  },
] as const

const REQUIRED_IMPORTS = [
  {
    file: 'src/orchestrator/completion.ts',
    requiredPatterns: [
      '../translator/outbound',
      '../translator/inbound',
    ],
    description: 'orchestrator/completion.ts must import both outbound and inbound',
  },
] as const

const STALE_REFERENCES = [
  'translator/request',
  'translator/response',
] as const

const EXCLUDED_TEST_FILE = 'test/architecture-boundary.test.ts'

function readFile(filePath: string): string {
  return readFileSync(resolve(process.cwd(), filePath), 'utf-8')
}

function getTsFiles(dir: string): string[] {
  const files: string[] = []
  const entries = readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...getTsFiles(fullPath))
    } else if (extname(entry.name) === '.ts') {
      files.push(fullPath)
    }
  }
  return files
}

function checkForbiddenImports(): { passed: boolean; errors: string[] } {
  const errors: string[] = []

  for (const rule of [
    { file: 'src/translator/outbound.ts', forbidden: ['../translator/inbound', './inbound', 'orchestrator', 'src/index', 'deepseek_api/client'], desc: 'outbound.ts must not depend on inbound, orchestrator, src/index, or deepseek_api/client' },
    { file: 'src/translator/inbound.ts', forbidden: ['../translator/outbound', './outbound', 'request.ts', 'parser/', 'orchestrator', 'src/index', 'deepseek_api/client'], desc: 'inbound.ts must not depend on outbound, parser, orchestrator, src/index, or deepseek_api/client' },
    { file: 'src/orchestrator/completion.ts', forbidden: ['src/index'], desc: 'orchestrator/completion.ts must not depend on src/index' },
  ] as const) {
    const content = readFile(rule.file)
    for (const pattern of rule.forbidden) {
      if (content.includes(pattern)) {
        const line = content.split('\n').findIndex(l => l.includes(pattern)) + 1
        return { passed: false, errors: [`${rule.file}:${line}: forbidden import/reference "${pattern}" - ${rule.desc}`] }
      }
    }
  }

  // deepseek_api: dynamic recursive scan
  const deepseekApiFiles = getTsFiles('src/deepseek_api')
  const deepseekForbidden = ['translator/', 'orchestrator/', 'src/index']
  for (const file of deepseekApiFiles) {
    const content = readFile(file)
    for (const pattern of deepseekForbidden) {
      if (content.includes(pattern)) {
        const line = content.split('\n').findIndex(l => l.includes(pattern)) + 1
        return { passed: false, errors: [`src/deepseek_api/${file}:${line}: forbidden import/reference "${pattern}" - deepseek_api must not import from translator, orchestrator, or src/index`] }
      }
    }
  }

  return { passed: true, errors: [] }
}

function checkRequiredImports(): { passed: boolean; errors: string[] } {
  const errors: string[] = []
  for (const rule of [
    { file: 'src/orchestrator/completion.ts', required: ['../translator/outbound', '../translator/inbound', '../parser/index'], desc: 'orchestrator/completion.ts must import both outbound and inbound' },
  ] as const) {
    const content = readFile(rule.file)
    for (const pattern of rule.required) {
      if (!content.includes(pattern)) {
        return { passed: false, errors: [`${rule.file}: missing required import "${pattern}" - ${rule.desc}`] }
      }
    }
  }
  return { passed: true, errors: [] }
}

function checkStaleReferences(): { passed: boolean; errors: string[] } {
  const errors: string[] = []
  const stalePatterns = ['translator/request', 'translator/response']

  // Recursively scan src/
  const srcFiles = getTsFiles('src')
  for (const file of srcFiles) {
    const content = readFile(file)
    for (const pattern of ['translator/request', 'translator/response']) {
      if (content.includes(pattern)) {
        const line = content.split('\n').findIndex(l => l.includes(pattern)) + 1
        errors.push(`${file}:${line}: stale reference to "${pattern}"`)
      }
    }
  }

  // Scan test/ (excluding this test file)
  const testFiles = getTsFiles('test').filter(f => !f.includes('architecture-boundary.test.ts'))
  for (const file of testFiles) {
    const content = readFile(file)
    for (const pattern of ['translator/request', 'translator/response']) {
      if (content.includes(pattern)) {
        const line = content.split('\n').findIndex(l => l.includes(pattern)) + 1
        errors.push(`${file}:${line}: stale test import/reference to "${pattern}"`)
      }
    }
  }

  return { passed: errors.length === 0, errors }
}

async function main() {
  console.log('Running Architecture Boundary Tests...\n')

  let totalErrors = 0

  console.log('--- Forbidden Import Checks ---')
  const forbiddenResult = checkForbiddenImports()
  if (!forbiddenResult.passed) {
    console.log('✗ FORBIDDEN IMPORT VIOLATIONS:')
    for (const error of forbiddenResult.errors) {
      console.log(`  ${error}`)
      process.exit(1)
    }
    console.log('✓ No forbidden imports found')
  } else {
    console.log('✓ No forbidden imports found')
  }

  console.log('\n--- Required Import Checks ---')
  const requiredResult = { passed: true, errors: [] }
  for (const rule of [{ file: 'src/orchestrator/completion.ts', required: ['../translator/outbound', '../translator/inbound'], desc: 'orchestrator/completion.ts must import both outbound and inbound' }]) {
    const content = readFile(rule.file)
    for (const pattern of rule.required) {
      if (!content.includes(pattern)) {
        console.log(`✗ MISSING REQUIRED IMPORTS:`)
        console.log(`  ${rule.file}: missing required import "${pattern}" - ${rule.desc}`)
        process.exit(1)
      }
    }
  }
  console.log('✓ All required imports present')

  console.log('\n--- Stale Reference Checks ---')
  let staleErrors = 0
  // src/
  const srcFiles = getTsFiles('src')
  for (const file of srcFiles) {
    const content = readFile(file)
    for (const pattern of ['translator/request', 'translator/response']) {
      if (content.includes(pattern)) {
        const line = content.split('\n').findIndex(l => l.includes(pattern)) + 1
        console.log(`  ${file}:${line}: stale reference to "${pattern}"`)
        staleErrors++
      }
    }
  }
  // test/ (excluding this test file)
  const testFiles = getTsFiles('test').filter(f => !f.includes('architecture-boundary.test.ts'))
  for (const file of testFiles) {
    const content = readFile(file)
    for (const pattern of ['translator/request', 'translator/response']) {
      if (content.includes(pattern)) {
        const line = content.split('\n').findIndex(l => l.includes(pattern)) + 1
        console.log(`  ${file}:${line}: stale test import/reference to "${pattern}"`)
        staleErrors++
      }
    }
  }
  if (staleErrors > 0) {
    console.log('✗ STALE REFERENCES FOUND:')
    process.exit(1)
  } else {
    console.log('✓ No stale references found')
  }

  console.log('\nAll tests passed!')
}

main()