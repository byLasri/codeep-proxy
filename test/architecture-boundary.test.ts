import { readFileSync } from 'fs'
import { resolve } from 'path'

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

const BOUNDARY_RULES: BoundaryRule[] = [
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
]

const REQUIRED_IMPORTS: RequiredImportRule[] = [
  {
    file: 'src/orchestrator/completion.ts',
    requiredPatterns: [
      '../translator/outbound',
      '../translator/inbound',
    ],
    description: 'orchestrator/completion.ts must import both outbound and inbound',
  },
]

const STALE_REFERENCES = [
  'translator/request',
  'translator/response',
]

function readFile(filePath: string): string {
  const fullPath = resolve(process.cwd(), filePath)
  return readFileSync(fullPath, 'utf-8')
}

function checkForbiddenImports(): { passed: boolean; errors: string[] } {
  const errors: string[] = []

  for (const rule of BOUNDARY_RULES) {
    let content: string
    let filesToCheck: string[] = []

    if (rule.file === 'src/deepseek_api') {
      // Check all files in deepseek_api directory
      const deepseekFiles = [
        'src/deepseek_api/client.ts',
        'src/deepseek_api/completion.ts',
        'src/deepseek_api/edit-message.ts',
        'src/deepseek_api/constants.ts',
        'src/deepseek_api/errors.ts',
        'src/deepseek_api/headers.ts',
        'src/deepseek_api/hif-leim.ts',
        'src/deepseek_api/pow-challenge.ts',
        'src/deepseek_api/pow.ts',
        'src/deepseek_api/session.ts',
        'src/deepseek_api/session-store.ts',
        'src/deepseek_api/state-store.ts',
        'src/deepseek_api/types.js',
      ]
      filesToCheck = deepseekFiles.filter(f => {
        try {
          return readFile(f).length > 0
        } catch {
          return false
        }
      })
    } else {
      filesToCheck = [rule.file]
    }

    for (const file of filesToCheck) {
      let content: string
      try {
        content = readFile(file)
      } catch {
        continue
      }

      for (const pattern of rule.forbiddenPatterns) {
        if (content.includes(pattern)) {
          // Find the line number for better error reporting
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(pattern)) {
              errors.push(`${file}:${i + 1}: forbidden import/reference "${pattern}" - ${rule.description}`)
              break
            }
          }
        }
      }
    }
  }

  return { passed: errors.length === 0, errors }
}

function checkRequiredImports(): { passed: boolean; errors: string[] } {
  const errors: string[] = []

  for (const rule of REQUIRED_IMPORTS) {
    const content = readFile(rule.file)
    for (const pattern of rule.requiredPatterns) {
      if (!content.includes(pattern)) {
        errors.push(`${rule.file}: missing required import "${pattern}" - ${rule.description}`)
      }
    }
  }

  return { passed: errors.length === 0, errors }
}

function checkStaleReferences(): { passed: boolean; errors: string[] } {
  const errors: string[] = []
  const srcFiles = [
    'src/index.ts',
    'src/orchestrator/completion.ts',
    'src/translator/index.ts',
    'src/translator/outbound.ts',
    'src/translator/inbound.ts',
    'src/translator/types.ts',
    'src/translator/models.ts',
    'src/orchestrator/completion.ts',
  ]

  for (const file of srcFiles) {
    try {
      const content = readFile(file)
      for (const pattern of STALE_REFERENCES) {
        if (content.includes(pattern)) {
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(pattern)) {
              errors.push(`${file}:${i + 1}: stale reference to "${pattern}"`)
              break
            }
          }
        }
      }
    } catch {
      continue
    }
  }

  // Also check test files for stale imports
  const testFiles = [
    'test/request-translation.test.ts',
    'test/architecture-baseline.test.ts',
    'test/dsml-malformed.test.ts',
    'test/orchestrator-completion.test.ts',
  ]

  for (const file of testFiles) {
    try {
      const content = readFile(file)
      for (const pattern of STALE_REFERENCES) {
        if (content.includes(pattern)) {
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(pattern)) {
              errors.push(`${file}:${i + 1}: stale test import/reference to "${pattern}"`)
              break
            }
          }
        }
      }
    } catch {
      continue
    }
  }

  return { passed: errors.length === 0, errors }
}

async function main() {
  console.log('Running Architecture Boundary Tests...\n')

  let totalErrors = 0

  // Check forbidden imports
  console.log('--- Forbidden Import Checks ---')
  const forbiddenResult = checkForbiddenImports()
  if (!forbiddenResult.passed) {
    console.log('✗ FORBIDDEN IMPORT VIOLATIONS:')
    for (const error of forbiddenResult.errors) {
      console.log(`  ${error}`)
      totalErrors++
    }
  } else {
    console.log('✓ No forbidden imports found')
  }

  // Check required imports
  console.log('\n--- Required Import Checks ---')
  const requiredResult = checkRequiredImports()
  if (!requiredResult.passed) {
    console.log('✗ MISSING REQUIRED IMPORTS:')
    for (const error of requiredResult.errors) {
      console.log(`  ${error}`)
      totalErrors++
    }
  } else {
    console.log('✓ All required imports present')
  }

  // Check stale references
  console.log('\n--- Stale Reference Checks ---')
  const staleResult = checkStaleReferences()
  if (!staleResult.passed) {
    console.log('✗ STALE REFERENCES FOUND:')
    for (const error of staleResult.errors) {
      console.log(`  ${error}`)
      totalErrors++
    }
  } else {
    console.log('✓ No stale references found')
  }

  console.log(`\n${totalErrors === 0 ? 'All' : totalErrors} test${totalErrors !== 1 ? 's' : ''} ${totalErrors === 0 ? 'passed' : 'failed'}!`)

  if (totalErrors > 0) {
    process.exit(1)
  }
}

main()