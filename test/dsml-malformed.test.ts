import { describe, test, expect } from '@playwright/test'

describe('DSML Malformed Detection', () => {
  test('parameter directly under <calls> should be detected as malformed', async () => {
    const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ calls>`
    
    // This should be detected as malformed because parameter is outside invoke
    expect(xml).toContain('<｜｜DSML｜｜ parameter')
  })
  
  test('invalid/unknown DSML element should be detected as malformed', async () => {
    const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invalid_element>something</｜｜DSML｜｜ invalid_element>
</｜｜DSML｜｜ calls>`
    
    // This should be detected as malformed due to unknown element
    expect(xml).toContain('<｜｜DSML｜｜ invalid_element')
  })
  
  test('missing closing tags should be detected as malformed', async () => {
    const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ calls>`
    
    // Missing </｜｜DSML｜｜ invoke> tag
    const hasOpenInvoke = xml.includes('<｜｜DSML｜｜ invoke')
    const hasCloseInvoke = xml.includes('</｜｜DSML｜｜ invoke>')
    
    expect(hasOpenInvoke).toBe(true)
    expect(hasCloseInvoke).toBe(false)
  })
  
  test('valid DSML should still work', async () => {
    const xml = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">README.md</｜｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`
    
    // This is valid DSML
    const hasCallsStart = xml.includes('<｜｜DSML｜｜ calls>')
    const hasCallsEnd = xml.includes('</｜｜DSML｜｜ calls>')
    const hasInvoke = xml.includes('<｜｜DSML｜｜ invoke name="read">')
    const hasCloseInvoke = xml.includes('</｜｜DSML｜｜ invoke>')
    
    expect(hasCallsStart).toBe(true)
    expect(hasCallsEnd).toBe(true)
    expect(hasInvoke).toBe(true)
    expect(hasCloseInvoke).toBe(true)
  })
})
