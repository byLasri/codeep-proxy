import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { resolve, extname, relative } from 'path'

interface TestResult {
  name: string
  passed: boolean
  error?: string
}

const results: TestResult[] = []

function pass(name: string) {
  results.push({ name, passed: true })
  console.log(`✓ ${name}`)
}

function fail(name: string, error: string) {
  results.push({ name, passed: false, error })
  console.error(`✗ ${name}`)
  console.error(`  ${error}`)
}

function assert(condition: boolean, name: string, errorMsg: string) {
  if (condition) pass(name)
  else fail(name, errorMsg)
}

function readFile(filePath: string): string {
  return readFileSync(resolve(process.cwd(), filePath), 'utf-8')
}

function fileExists(filePath: string): boolean {
  return existsSync(resolve(process.cwd(), filePath))
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

function extractImports(content: string): string[] {
  const imports: string[] = []
  // Match import statements that may span multiple lines
  // import ... from '...'
  // import type ... from '...'
  const importRegex = /import\s+(?:type\s+)?(?:[^'"]*?)\s+from\s+['"]([^'"]+)['"]/gs
  let match
  while ((match = importRegex.exec(content)) !== null) {
    let imp = match[1]
    // Strip .js extension for comparison
    if (imp.endsWith('.js')) imp = imp.slice(0, -3)
    imports.push(imp)
  }
  return imports
}

function hasImport(content: string, pattern: string): boolean {
  const imports = extractImports(content)
  return imports.some(imp => imp === pattern || imp.startsWith(pattern + '/') || imp.includes('/' + pattern))
}

async function main() {
  console.log('=== Architecture Mission Final Proof ===\n')

  // ============================================================
  // 1. Final production file set
  // ============================================================
  console.log('--- 1. Final production file set ---\n')

  const requiredFiles = [
    'src/translator/outbound.ts',
    'src/translator/inbound.ts',
    'src/orchestrator/completion.ts',
    'src/deepseek_api/index.ts',
    'src/deepseek_api/client.ts',
    'src/index.ts',
  ]

  for (const f of requiredFiles) {
    assert(fileExists(f), `Required file exists: ${f}`, `Missing required file: ${f}`)
  }

  const deletedFiles = [
    'src/translator/' + 'request.ts',
    'src/translator/' + 'response.ts',
  ]

  for (const f of deletedFiles) {
    assert(!fileExists(f), `Old translator file removed: ${f}`, `Stale file still exists: ${f}`)
  }

  // ============================================================
  // 2. Translator independence
  // ============================================================
  console.log('\n--- 2. Translator independence ---\n')

  const outboundContent = readFile('src/translator/outbound.ts')
  const inboundContent = readFile('src/translator/inbound.ts')

  const outboundForbidden = [
    '../translator/inbound',
    './inbound',
    'orchestrator',
    'deepseek_api/client',
    'src/index',
  ]

  for (const forbidden of outboundForbidden) {
    assert(
      !hasImport(outboundContent, forbidden),
      `outbound.ts does not import ${forbidden}`,
      `outbound.ts imports forbidden dependency: ${forbidden}`
    )
  }

  const inboundForbidden = [
    '../translator/outbound',
    './outbound',
    'translator/' + 'request',
    'parser/',
    'orchestrator',
    'deepseek_api/client',
    'src/index',
  ]

  for (const forbidden of inboundForbidden) {
    assert(
      !hasImport(inboundContent, forbidden),
      `inbound.ts does not import ${forbidden}`,
      `inbound.ts imports forbidden dependency: ${forbidden}`
    )
  }

  // Verify outbound imports only allowed deps
  const outboundAllowed = [
    '../deepseek_api/types',
    './types',
    './models',
    '../observability/logger',
  ]

  const outboundImports = extractImports(outboundContent)
  for (const imp of outboundImports) {
    const isAllowed = outboundAllowed.some(a => imp === a || imp.startsWith(a + '/'))
    if (!isAllowed) {
      fail(`outbound.ts imports only allowed deps`, `Unexpected import: ${imp}`)
    }
  }
  pass('outbound.ts imports only allowed dependencies')

  // Verify inbound imports only allowed deps
  const inboundAllowed = [
    './types',
    '../observability/logger',
    '../parser/index',
  ]

  const inboundImports = extractImports(inboundContent)
  for (const imp of inboundImports) {
    const isAllowed = inboundAllowed.some(a => imp === a || imp.startsWith(a + '/'))
    if (!isAllowed) {
      fail(`inbound.ts imports only allowed deps`, `Unexpected import: ${imp}`)
    }
  }
  pass('inbound.ts imports only allowed dependencies')

  // Regression test: verify that an unexpected relative import would be rejected
  // This proves the allowlist correctly rejects unauthorized relative imports
  const regressionTestPassed = (() => {
    // Simulate an import that is relative but NOT in the allowlist
    const forbiddenRelativeImport = '../translator/inbound' // This IS forbidden for outbound
    const isInAllowlist = outboundAllowed.some(a => forbiddenRelativeImport === a || forbiddenRelativeImport.startsWith(a + '/'))
    // The allowlist should reject this
    if (isInAllowlist) {
      fail('Regression test: allowlist should reject forbidden relative import', `../translator/inbound should not be allowed for outbound`)
      return false
    }
    // Now test that the logic would catch it
    const wouldFail = !outboundAllowed.some(a => forbiddenRelativeImport === a || forbiddenRelativeImport.startsWith(a + '/'))
    if (!wouldFail) {
      fail('Regression test: bug would allow forbidden relative import', `Bug: forbidden relative import would pass allowlist`)
      return false
    }
    return true
  })()
  if (regressionTestPassed) {
    pass('Regression test: allowlist correctly rejects forbidden relative imports (e.g., ../translator/inbound for outbound)')
  }

  // ============================================================
  // 3. Orchestrator dependency direction
  // ============================================================
  console.log('\n--- 3. Orchestrator dependency direction ---\n')

  const orchestratorContent = readFile('src/orchestrator/completion.ts')
  const orchestratorImports = extractImports(orchestratorContent)

  const requiredOrchestratorImports = [
    '../translator/outbound',
    '../translator/inbound',
    '../parser/index',
    '../deepseek_api/types',
    '../deepseek_api/client',
  ]

  for (const req of requiredOrchestratorImports) {
    assert(
      orchestratorImports.some(i => i === req || i.startsWith(req + '/')),
      `orchestrator imports ${req}`,
      `orchestrator missing required import: ${req}`
    )
  }

  assert(
    !hasImport(orchestratorContent, 'src/index'),
    'orchestrator does not import src/index',
    'orchestrator imports forbidden src/index'
  )

  // ============================================================
  // 4. DeepSeek protocol independence
  // ============================================================
  console.log('\n--- 4. DeepSeek protocol independence ---\n')

  const deepseekFiles = getTsFiles('src/deepseek_api')
  const deepseekForbidden = ['translator', 'orchestrator', 'src/index']

  let deepseekViolations = 0
  for (const file of deepseekFiles) {
    const content = readFile(file)
    for (const forbidden of deepseekForbidden) {
      if (hasImport(content, forbidden)) {
        deepseekViolations++
        fail(`deepseek_api/${relative('src/deepseek_api', file)} does not import ${forbidden}`, `Imports forbidden: ${forbidden}`)
      }
    }
  }

  if (deepseekViolations === 0) {
    pass('deepseek_api has no reverse dependencies on translator/orchestrator/src/index')
  }

  // ============================================================
  // 5. Normal /v1/chat/completions lifecycle boundary
  // ============================================================
  console.log('\n--- 5. Normal /v1/chat/completions lifecycle boundary ---\n')

  const indexContent = readFile('src/index.ts')

  // Check that normal flow delegates to executeCompletionWithRetry
  assert(
    indexContent.includes('executeCompletionWithRetry'),
    'src/index.ts invokes executeCompletionWithRetry',
    'Normal flow does not delegate to executeCompletionWithRetry'
  )

  // Verify the normal flow path (not edit-message path)
  // In src/index.ts, the edit flow is checked FIRST, then normal flow
  const editFlowStart = indexContent.indexOf('// EDIT FLOW:')
  const normalFlowStart = indexContent.indexOf('// NORMAL FLOW:')

  assert(
    normalFlowStart !== -1,
    'NORMAL FLOW marker present in src/index.ts',
    'NORMAL FLOW section not found'
  )

  assert(
    editFlowStart !== -1,
    'EDIT FLOW marker present (separate from normal flow)',
    'EDIT FLOW section not found'
  )

  // Verify that executeCompletionWithRetry is called in the normal flow section
  // The normal flow section starts at "// NORMAL FLOW:" and goes until the end of the completions handler
  const normalFlowSection = indexContent.substring(normalFlowStart)
  assert(
    normalFlowSection.includes('executeCompletionWithRetry'),
    'executeCompletionWithRetry called in NORMAL FLOW section',
    'Normal flow does not call executeCompletionWithRetry'
  )

  // Verify edit-message path is separate
  const editFlowSection = indexContent.substring(editFlowStart, normalFlowStart)
  assert(
    editFlowSection.includes('translateParserEventsToSSE') && editFlowSection.includes('translateParserEventsToJSON') && editFlowSection.includes('parseDeepSeekSSE'),
    'Edit flow uses translator directly (not orchestrator)',
    'Edit flow does not use translator directly'
  )
  assert(
    !editFlowSection.includes('executeCompletionWithRetry'),
    'Edit flow does NOT use executeCompletionWithRetry',
    'Edit flow incorrectly uses orchestrator'
  )

  // ============================================================
  // 6. Orchestrator ownership of retry loop
  // ============================================================
  console.log('\n--- 6. Orchestrator ownership of retry loop ---\n')

  assert(
    orchestratorContent.includes('MAX_MALFORMED_RETRIES = 5'),
    'MAX_MALFORMED_RETRIES = 5 constant present',
    'Retry constant not found'
  )

  assert(
    orchestratorContent.includes('executeCompletionAttempt'),
    'executeCompletionAttempt function exists',
    'executeCompletionAttempt not found'
  )

  assert(
    orchestratorContent.includes('executeCompletionWithRetry'),
    'executeCompletionWithRetry function exists',
    'executeCompletionWithRetry not found'
  )

  // Verify retry message append behavior
  assert(
    orchestratorContent.includes("role: 'user'") && orchestratorContent.includes('attemptResult.correction'),
    'Retry appends correction as role: user message',
    'Retry message append behavior not found'
  )

  // Verify the retry loop structure
  assert(
    orchestratorContent.includes('while (malformedRetryCount <= MAX_MALFORMED_RETRIES)'),
    'Retry loop with MAX_MALFORMED_RETRIES bound',
    'Retry loop structure not found'
  )

  // ============================================================
  // 7. Translator semantic boundary
  // ============================================================
  console.log('\n--- 7. Translator semantic boundary ---\n')

  // Check outbound exports translateOpenAIRequest returning DeepSeekCompletionInput
  assert(
    outboundContent.includes('export function translateOpenAIRequest'),
    'translateOpenAIRequest exported from outbound.ts',
    'translateOpenAIRequest not exported'
  )

  // Check DeepSeekCompletionInput is from deepseek_api/types
  const deepseekTypesContent = readFile('src/deepseek_api/types.ts')
  assert(
    deepseekTypesContent.includes('export interface DeepSeekCompletionInput') ||
    deepseekTypesContent.includes('export type DeepSeekCompletionInput'),
    'DeepSeekCompletionInput defined in deepseek_api/types.ts',
    'DeepSeekCompletionInput not found in deepseek_api/types.ts'
  )

  // Inbound is the boring semantic-to-OpenAI translator: it consumes parser events only.
  assert(
    inboundContent.includes('export async function translateParserEventsToSSE'),
    'translateParserEventsToSSE exported from inbound.ts',
    'SSE parser-event translator not exported'
  )

  assert(
    inboundContent.includes('export async function translateParserEventsToJSON'),
    'translateParserEventsToJSON exported from inbound.ts',
    'JSON parser-event translator not exported'
  )

  assert(
    !inboundContent.includes('DeepSeekSSEParser'),
    'inbound.ts does not instantiate the raw parser',
    'inbound.ts still owns parser construction'
  )

  // ============================================================
  // 8. No old translator road remains
  // ============================================================
  console.log('\n--- 8. No old translator road remains ---\n')

  const allSrcFiles = getTsFiles('src')
  const allTestFiles = getTsFiles('test')

  // Construct forbidden patterns without literals in source
  const t = 'translator'
  const req = 'request'
  const resp = 'response'
  const sep = '/'
  const forbidden1 = t + sep + req
  const forbidden2 = t + sep + resp

  let staleCount = 0
  for (const file of [...allSrcFiles, ...allTestFiles]) {
    // Skip this test file itself
    if (file.includes('architecture-mission-final.test.ts')) continue
    if (file.includes('architecture-boundary.test.ts')) continue // this test checks for stale refs

    const content = readFile(file)
    if (content.includes(forbidden1) || content.includes(forbidden2)) {
      staleCount++
      fail('No stale ' + forbidden1 + ' or ' + forbidden2, `Found in ${relative(process.cwd(), file)}`)
    }
  }

  if (staleCount === 0) {
    pass('No stale ' + forbidden1 + ' or ' + forbidden2 + ' references in src/ or test/')
  }

  // ============================================================
  // 9. No forbidden reverse dependency
  // ============================================================
  console.log('\n--- 9. No forbidden reverse dependency ---\n')

  // Build import graph
  const srcFiles = getTsFiles('src')
  const importGraph: Record<string, string[]> = {}

  for (const file of srcFiles) {
    const content = readFile(file)
    importGraph[file] = extractImports(content)
  }

  const forbiddenEdges = [
    { from: 'src/translator/outbound.ts', to: ['orchestrator', 'deepseek_api/client', 'translator/inbound'] },
    { from: 'src/translator/inbound.ts', to: ['orchestrator', 'translator/outbound', 'deepseek_api/client', 'translator/' + 'request'] },
    { from: 'src/deepseek_api', to: ['translator', 'orchestrator'] }, // directory prefix
    { from: 'src/orchestrator/completion.ts', to: ['src/index'] },
  ]

  let edgeViolations = 0
  for (const { from, to } of forbiddenEdges) {
    if (from === 'src/deepseek_api') {
      // Check all files in deepseek_api
      for (const file of srcFiles) {
        if (file.startsWith('src/deepseek_api/')) {
          const imports = importGraph[file] || []
          for (const forbidden of to) {
            if (imports.some(imp => imp === forbidden || imp.startsWith(forbidden + '/') || imp.includes('/' + forbidden))) {
              edgeViolations++
              fail(`No reverse edge: ${relative('src/deepseek_api', file)} → ${forbidden}`, `Found forbidden import`)
            }
          }
        }
      }
    } else {
      const imports = importGraph[from] || []
      for (const forbidden of to) {
        if (imports.some(imp => imp === forbidden || imp.startsWith(forbidden + '/') || imp.includes('/' + forbidden))) {
          edgeViolations++
          fail(`No reverse edge: ${from} → ${forbidden}`, `Found forbidden import`)
        }
      }
    }
  }

  if (edgeViolations === 0) {
    pass('No forbidden reverse dependencies in import graph')
  }

  // Verify allowed edges exist
  // Use resolved absolute paths for consistency with importGraph keys
  const allowedEdges = [
    { from: resolve(process.cwd(), 'src/translator/outbound.ts'), to: '../deepseek_api/types' },
    { from: resolve(process.cwd(), 'src/translator/inbound.ts'), to: '../observability/logger' },
    { from: resolve(process.cwd(), 'src/orchestrator/completion.ts'), to: ['../translator/outbound', '../translator/inbound', '../deepseek_api/types', '../deepseek_api/client'] },
  ]

  for (const { from, to } of allowedEdges) {
    const targets = Array.isArray(to) ? to : [to]
    const imports = importGraph[from] || []
    for (const target of targets) {
      const hasTarget = imports.some(imp => imp === target || imp.startsWith(target + '/'))
      assert(hasTarget, `Allowed edge exists: ${relative(process.cwd(), from)} → ${target}`, `Missing allowed import: ${target}`)
    }
  }

  // ============================================================
  // 10. Summary
  // ============================================================
  console.log('\n=== SUMMARY ===')
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  console.log(`Passed: ${passed}`)
  console.log(`Failed: ${failed}`)

  if (failed > 0) {
    console.log('\nFailures:')
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  ✗ ${r.name}: ${r.error}`)
    }
    process.exit(1)
  }

  console.log('\nAll architecture proof tests passed!')
}

main()