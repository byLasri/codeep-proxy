import { spawn } from 'child_process'

interface SuiteResult {
  name: string
  passed: boolean
  output: string
}

const SUITES = [
  'test/request-translation.test.ts',
  'test/translator-outbound.test.ts',
  'test/translator-inbound.test.ts',
  'test/architecture-boundary.test.ts',
  'test/architecture-mission-final.test.ts',
  'test/architecture-baseline.test.ts',
  'test/dsml-malformed.test.ts',
  'test/orchestrator-completion.test.ts',
] as const

function runSuite(file: string): Promise<SuiteResult> {
  return new Promise((resolve) => {
    console.log(`\n=== Running ${file} ===`)
    const child = spawn(process.execPath, ['--import', 'tsx', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
    })

    let output = ''
    child.stdout.on('data', (data) => {
      output += data.toString()
    })
    child.stderr.on('data', (data) => {
      output += data.toString()
    })

    child.on('close', (code) => {
      const passed = code === 0
      console.log(output.trim())
      console.log(`${passed ? '✓' : '✗'} ${file} ${passed ? 'PASSED' : 'FAILED'}`)
      resolve({ name: file, passed, output })
    })

    child.on('error', (err) => {
      console.error(`Failed to start ${file}:`, err)
      resolve({ name: file, passed: false, output: err.message })
    })
  })
}

async function main() {
  console.log('=== Running all fixture test suites ===\n')

  const results: SuiteResult[] = []

  for (const suite of SUITES) {
    const result = await runSuite(suite)
    results.push(result)
  }

  console.log('\n=== SUMMARY ===')
  let failed = 0
  for (const r of results) {
    if (!r.passed) {
      console.log(`✗ ${r.name} FAILED`)
      failed++
    } else {
      console.log(`✓ ${r.name} PASSED`)
    }
  }

  if (failed > 0) {
    console.log(`\n${failed} of ${SUITES.length} suites FAILED`)
    process.exit(1)
  } else {
    console.log(`\nAll ${SUITES.length} suites PASSED`)
    process.exit(0)
  }
}

main()