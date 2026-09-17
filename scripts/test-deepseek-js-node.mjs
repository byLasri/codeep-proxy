#!/usr/bin/env node
/**
 * DeepSeek JS Node.js Execution Forensic Experiment
 * 
 * Goal: Load/execute DeepSeek JS networking code under Node.js with minimal shims
 * to prove whether it can run without browser/Chromium.
 * 
 * This script intercepts the request builder path and captures:
 * - x-hif-leim
 * - x-hif-dliq  
 * - x-device-id
 * - x-ds-pow-response
 * - URL and body construction
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DS_JS_PATH = join(__dirname, '../ds_js/main.d79ba3e506.js');

// ============================================================================
// BROWSER GLOBAL SHIMS (MINIMAL REQUIRED)
// ============================================================================

// Track which shims are actually used at runtime
const shimUsage = {
  globalThis: { used: false, required: false },
  localStorage: { used: false, required: false },
  crypto: { used: false, required: false },
  document: { used: false, required: false },
  window: { used: false, required: false },
  navigator: { used: false, required: false },
  fetch: { used: false, required: false },
  XMLHttpRequest: { used: false, required: false },
  FormData: { used: false, required: false },
  setTimeout: { used: false, required: false },
  clearTimeout: { used: false, required: false },
  setInterval: { used: false, required: false },
  clearInterval: { used: false, required: false },
  Promise: { used: false, required: false },
  Uint8Array: { used: false, required: false },
  ArrayBuffer: { used: false, required: false },
  TextEncoder: { used: false, required: false },
  TextDecoder: { used: false, required: false },
};

let executionLog = [];
let capturedHeaders = {};
let capturedUrl = null;
let capturedBody = null;
let errors = [];
let successMarkers = [];

// Intercept console.log for debugging
const originalLog = console.log;
const logInterceptor = (...args) => {
  executionLog.push({ type: 'log', args: args.map(String).join(' ') });
  // Silent during execution
};

// ============================================================================
// SETUP GLOBAL SHIMS
// ============================================================================

// globalThis already exists in Node.js 12+
shimUsage.globalThis.used = true;

// self is an alias for globalThis in browser contexts
global.self = globalThis;

// localStorage shim - stores hif_leim_cached and hif_dliq_cached
const localStorageData = new Map();
global.localStorage = {
  getItem: (key) => {
    shimUsage.localStorage.used = true;
    const val = localStorageData.get(key) || null;
    return val;
  },
  setItem: (key, value) => {
    shimUsage.localStorage.used = true;
    localStorageData.set(key, String(value));
  },
  removeItem: (key) => {
    shimUsage.localStorage.used = true;
    localStorageData.delete(key);
  },
  clear: () => {
    shimUsage.localStorage.used = true;
    localStorageData.clear();
  },
  get length() {
    shimUsage.localStorage.used = true;
    return localStorageData.size;
  },
  key: (index) => {
    shimUsage.localStorage.used = true;
    return Array.from(localStorageData.keys())[index] || null;
  }
};

// Pre-seed fake HIF tokens (simulating what pollers would provide)
localStorage.setItem('hif_leim_cached', 'fake.leim.token.signature');
localStorage.setItem('hif_dliq_cached', 'fake.dliq.token.signature');

// crypto shim - for UUID generation and random values
// Node.js 20+ has globalThis.crypto as read-only, so we augment it
if (!globalThis.crypto) {
  globalThis.crypto = {};
}
globalThis.crypto.randomUUID = globalThis.crypto.randomUUID || (() => {
  shimUsage.crypto.used = true;
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
});
globalThis.crypto.getRandomValues = globalThis.crypto.getRandomValues || ((array) => {
  shimUsage.crypto.used = true;
  for (let i = 0; i < array.length; i++) {
    array[i] = Math.floor(Math.random() * 256);
  }
  return array;
});

// document shim - minimal, should NOT be required for request building
global.document = {
  createElement: () => {
    shimUsage.document.used = true;
    throw new Error('document.createElement called - indicates DOM dependency');
  },
  getElementsByTagName: () => {
    shimUsage.document.used = true;
    return [];
  },
  head: {
    appendChild: () => {
      shimUsage.document.used = true;
      throw new Error('document.head.appendChild called - indicates DOM dependency');
    },
    insertBefore: () => {
      shimUsage.document.used = true;
      throw new Error('document.head.insertBefore called - indicates DOM dependency');
    }
  },
  baseURI: 'https://chat.deepseek.com/',
  location: { href: 'https://chat.deepseek.com/' }
};

// window shim - minimal
global.window = {
  location: { href: 'https://chat.deepseek.com/' },
  addEventListener: () => {},
  removeEventListener: () => {}
};

// navigator shim - minimal
global.navigator = {
  userAgent: 'Node.js',
  language: 'en-US',
  languages: ['en-US'],
  platform: 'Linux'
};

// fetch interceptor - capture requests instead of sending them
global.fetch = async (url, options = {}) => {
  shimUsage.fetch.used = true;
  capturedUrl = url;
  
  // Capture headers
  if (options.headers) {
    capturedHeaders = { ...options.headers };
  }
  
  // Capture body
  if (options.body) {
    capturedBody = options.body instanceof FormData 
      ? '[FormData]' 
      : String(options.body);
  }
  
  // Return mock response to prevent actual network calls
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: 'mocked', data: {} }),
    text: async () => JSON.stringify({ status: 'mocked' })
  };
};

// FormData shim
global.FormData = class FormData {
  constructor() {
    shimUsage.FormData.used = true;
    this.data = new Map();
  }
  append(key, value) {
    this.data.set(key, value);
  }
  get(key) {
    return this.data.get(key);
  }
};

// XMLHttpRequest shim - should NOT be required
global.XMLHttpRequest = class XMLHttpRequest {
  constructor() {
    shimUsage.XMLHttpRequest.used = true;
    throw new Error('XMLHttpRequest instantiated - indicates XHR dependency');
  }
};

// setTimeout/clearTimeout - native in Node.js but track usage
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;

global.setTimeout = function(...args) {
  shimUsage.setTimeout.used = true;
  return originalSetTimeout.apply(this, args);
};

global.clearTimeout = function(...args) {
  shimUsage.clearTimeout.used = true;
  return originalClearTimeout.apply(this, args);
};

global.setInterval = function(...args) {
  shimUsage.setInterval.used = true;
  return originalSetInterval.apply(this, args);
};

global.clearInterval = function(...args) {
  shimUsage.clearInterval.used = true;
  return originalClearInterval.apply(this, args);
};

// Promise - native but track
shimUsage.Promise.used = typeof Promise !== 'undefined';

// Typed arrays - native but track
shimUsage.Uint8Array.used = typeof Uint8Array !== 'undefined';
shimUsage.ArrayBuffer.used = typeof ArrayBuffer !== 'undefined';

// TextEncoder/TextDecoder - native in Node.js
global.TextEncoder = global.TextEncoder || class TextEncoder {
  encode(str) {
    shimUsage.TextEncoder.used = true;
    return Buffer.from(str);
  }
};
global.TextDecoder = global.TextDecoder || class TextDecoder {
  decode(buf) {
    shimUsage.TextDecoder.used = true;
    return Buffer.from(buf).toString();
  }
};

// ============================================================================
// LOAD AND EXECUTE DEEPSEEK JS
// ============================================================================

console.error('Loading DeepSeek JS bundle...');
const dsJsContent = readFileSync(DS_JS_PATH, 'utf-8');
console.error(`Bundle size: ${dsJsContent.length} bytes`);

try {
  // Execute the bundle in an isolated context
  const vm = await import('vm');
  const context = vm.createContext({
    ...global,
    console: { log: logInterceptor, error: logInterceptor, warn: logInterceptor, info: logInterceptor },
    process: process,
    require: function(mod) { return require(mod); },
    module: { exports: {} },
    exports: {}
  });
  
  console.error('Executing DeepSeek JS in VM context...');
  
  // Run the bundle
  const script = new vm.Script(dsJsContent);
  script.runInContext(context, { timeout: 5000 });
  
  successMarkers.push('bundle_executed');
  console.error('Bundle executed successfully');
  
  // List all global properties added by the bundle
  const newGlobals = Object.keys(context).filter(k => !['global', 'globalThis', 'self', 'console', 'process', 'require', 'module', 'exports'].includes(k));
  console.error('New globals from bundle:', newGlobals.slice(0, 50).join(', '));
  
  // Try to access wr object if exposed
  if (context.wr) {
    console.error('wr object found');
    if (typeof context.wr.getHeaders === 'function') {
      try {
        const headers = context.wr.getHeaders();
        console.error('getHeaders() returned:', JSON.stringify(headers));
        successMarkers.push('getHeaders_called');
      } catch (e) {
        errors.push({ source: 'getHeaders', message: e.message });
      }
    }
  }
  
  // Try to access ws for storage handles
  if (context.ws) {
    console.error('ws object found');
    try {
      const leimVal = context.ws().leim.get();
      const dliqVal = context.ws().dliq.get();
      console.error('ws().leim.get():', leimVal ? '[TOKEN_PRESENT]' : '[NULL]');
      console.error('ws().dliq.get():', dliqVal ? '[TOKEN_PRESENT]' : '[NULL]');
      successMarkers.push('storage_accessed');
    } catch (e) {
      errors.push({ source: 'ws', message: e.message });
    }
  }
  
  // Look for common webpack module patterns
  const possibleModuleExports = ['wt', 'EF', 'cM', 'en', 'wr', 'ws', 'createPowChallenge', 'getHeaders', 'sendChatCompletion', 'sendEditMessage'];
  for (const sym of possibleModuleExports) {
    if (context[sym]) {
      console.error(`Found symbol: ${sym} (${typeof context[sym]})`);
      if (typeof context[sym] === 'function') {
        try {
          const result = context[sym]();
          console.error(`  ${sym}() returned: ${JSON.stringify(result)?.substring(0, 100)}`);
        } catch (e) {
          // Function may require arguments
        }
      }
    }
  }
  
  // Wait briefly for any async protocol flows (pollers may start on load)
  await new Promise(resolve => setTimeout(resolve, 3000));
  
} catch (e) {
  errors.push({ source: 'execution', message: e.message, stack: e.stack });
  console.error('Execution error:', e.message);
}

// ============================================================================
// ANALYZE RESULTS
// ============================================================================

// Determine which shims were REQUIRED vs just USED
const requiredShims = [];
const optionalShims = [];
const unusedShims = [];

for (const [name, info] of Object.entries(shimUsage)) {
  if (!info.used) {
    unusedShims.push(name);
  } else if (['document', 'window', 'navigator', 'XMLHttpRequest'].includes(name)) {
    // These indicate browser-only APIs that shouldn't be needed for pure request building
    optionalShims.push(name);
  } else {
    requiredShims.push(name);
  }
}

// Check if critical headers would have been set
const hasLeimHeader = !!capturedHeaders['x-hif-leim'];
const hasDliqHeader = !!capturedHeaders['x-hif-dliq'];
const hasDeviceIdHeader = !!capturedHeaders['x-device-id'];
const hasPowHeader = !!capturedHeaders['x-ds-pow-response'];

// Determine feasibility
const canRunInNode = !errors.some(e => 
  e.message.includes('document') || 
  e.message.includes('XMLHttpRequest') ||
  e.message.includes('DOM')
);

const verdict = canRunInNode 
  ? 'CONFIRMED_EXECUTABLE' 
  : 'REQUIRES_BROWSER';

// ============================================================================
// OUTPUT REPORT
// ============================================================================

const report = {
  experiment: 'DeepSeek JS Node.js Execution Test',
  timestamp: new Date().toISOString(),
  bundle: 'main.d79ba3e506.js',
  bundle_size_bytes: dsJsContent.length,
  
  result: {
    verdict,
    bundle_executed: successMarkers.includes('bundle_executed'),
    getHeaders_callable: successMarkers.includes('getHeaders_called'),
    storage_accessible: successMarkers.includes('storage_accessed'),
  },
  
  captured_data: {
    url: capturedUrl,
    headers: capturedHeaders,
    body: capturedBody,
    has_x_hif_leim: hasLeimHeader,
    has_x_hif_dliq: hasDliqHeader,
    has_x_device_id: hasDeviceIdHeader,
    has_x_ds_pow_response: hasPowHeader,
  },
  
  shim_analysis: {
    required_shims: requiredShims,
    optional_shims: optionalShims,
    unused_shims: unusedShims,
    detailed_usage: shimUsage,
  },
  
  errors: errors,
  execution_log_sample: executionLog.slice(0, 20),
  
  conclusion: {
    node_compatible: canRunInNode,
    minimal_shim_count: requiredShims.length,
    browser_api_dependencies: optionalShims.filter(s => shimUsage[s].used),
    recommendation: canRunInNode 
      ? 'Can run in Node.js with minimal shims (localStorage, crypto)'
      : 'Requires browser environment due to DOM/XHR dependencies'
  }
};

console.log(JSON.stringify(report, null, 2));
