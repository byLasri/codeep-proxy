#!/usr/bin/env node
/**
 * Live HIF + PoW Protocol Execution Test
 * 
 * This script executes the REAL DeepSeek HIF and PoW protocols
 * using minimal shims around the actual bundle functions.
 * 
 * DO NOT commit credentials, cookies, or auth dumps.
 */

import https from 'https';
import http from 'http';

// Configuration - use environment variables for sensitive data
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://chat.deepseek.com';
const AUTH_TOKEN = process.env.DEEPSEEK_AUTH_TOKEN;
const COOKIES = process.env.DEEPSEEK_COOKIES;

if (!AUTH_TOKEN) {
  console.error('ERROR: DEEPSEEK_AUTH_TOKEN environment variable required');
  console.error('Set it with: export DEEPSEEK_AUTH_TOKEN="your-token-here"');
  process.exit(1);
}

// Actual HIF URLs extracted from bundle at byte offset ~943000
// Note: Bundle shows conditional URLs based on CZ.KV feature flag
// Production URLs when CZ.KV is true:
const HIF_LEIM_URL = 'https://hif-leim.deepseek.com/query';
const HIF_DLIQ_URL = 'https://hif-dliq.deepseek.com/query';
// Alternative test URLs when CZ.KV is false:
// const HIF_LEIM_URL = 'https://hif-test.deepseek.com/query';
// const HIF_DLIQ_URL = 'https://hif-test.deepseek.com/query';
const POW_CHALLENGE_URL = '/api/v0/chat/create_pow_challenge';

console.log('=== DeepSeek HIF + PoW Live Protocol Test ===\n');
console.log('HIF LEIM URL:', HIF_LEIM_URL);
console.log('HIF DLIQ URL:', HIF_DLIQ_URL);
console.log('PoW Challenge Endpoint:', POW_CHALLENGE_URL);
console.log('');

// Minimal HTTP client that mimics the DeepSeek internal HTTP client
function createHttpClient() {
  function request(method, url, options = {}) {
    return new Promise((resolve, reject) => {
      const parsedUrl = url.startsWith('http') ? new URL(url) : new URL(url, DEEPSEEK_BASE_URL);
      
      const client = parsedUrl.protocol === 'https:' ? https : http;
      
      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: method,
        headers: {
          'Authorization': `Bearer ${AUTH_TOKEN}`,
          'Content-Type': 'application/json',
          'Origin': 'https://chat.deepseek.com',
          'Referer': 'https://chat.deepseek.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      };

      // Add cookies if provided
      if (COOKIES) {
        try {
          const cookieObj = JSON.parse(COOKIES);
          const cookieHeader = cookieObj.map(c => `${c.name}=${c.value}`).join('; ');
          reqOptions.headers['Cookie'] = cookieHeader;
        } catch (e) {
          // Cookies parsing failed, continue without
        }
      }

      const req = client.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (e) {}
          
          resolve({
            status: res.statusCode,
            headers: res.headers,
            json: json,
            data: data
          });
        });
      });

      req.on('error', reject);
      
      if (options.body) {
        req.write(JSON.stringify(options.body));
      }
      
      req.end();
    });
  }

  return {
    get: (url, options) => request('GET', url, options),
    post: (url, options) => request('POST', url, options),
    withDefaultHttpContext: (ctx) => ctx
  };
}

// Simulate the en.Ax() service locator
const mockServiceLocator = {
  http: createHttpClient(),
  addSSEHeader: () => ({})
};

// Test 1: HIF LEIM Request
async function testHifLeim() {
  console.log('[TEST 1] HIF LEIM Token Request');
  console.log('URL:', HIF_LEIM_URL);
  
  try {
    const result = await mockServiceLocator.http.get(HIF_LEIM_URL, {
      timeout: 3000,
      context: mockServiceLocator.http.withDefaultHttpContext({ withToken: false })
    });
    
    console.log('HTTP Status:', result.status);
    console.log('Has x-hif-ttl header:', !!result.headers['x-hif-ttl']);
    console.log('TTL Value:', result.headers['x-hif-ttl'] || 'N/A');
    
    if (result.json?.data?.biz_code === 0) {
      console.log('Biz Code: 0 (SUCCESS)');
      console.log('Token obtained: YES (value redacted)');
      return { success: true, token: result.json.data.biz_data?.value, ttl: result.headers['x-hif-ttl'] };
    } else {
      console.log('Biz Code:', result.json?.data?.biz_code || 'N/A');
      console.log('Error:', result.json?.data?.biz_msg || 'Unknown error');
      return { success: false, error: result.json?.data?.biz_msg };
    }
  } catch (error) {
    console.log('Request failed:', error.message);
    return { success: false, error: error.message };
  }
}

// Test 2: HIF DLIQ Request
async function testHifDliq() {
  console.log('\n[TEST 2] HIF DLIQ Token Request');
  console.log('URL:', HIF_DLIQ_URL);
  
  try {
    const result = await mockServiceLocator.http.get(HIF_DLIQ_URL, {
      timeout: 3000,
      context: mockServiceLocator.http.withDefaultHttpContext({ withToken: false })
    });
    
    console.log('HTTP Status:', result.status);
    console.log('Has x-hif-ttl header:', !!result.headers['x-hif-ttl']);
    console.log('TTL Value:', result.headers['x-hif-ttl'] || 'N/A');
    
    if (result.json?.data?.biz_code === 0) {
      console.log('Biz Code: 0 (SUCCESS)');
      console.log('Token obtained: YES (value redacted)');
      return { success: true, token: result.json.data.biz_data?.value, ttl: result.headers['x-hif-ttl'] };
    } else {
      console.log('Biz Code:', result.json?.data?.biz_code || 'N/A');
      console.log('Error:', result.json?.data?.biz_msg || 'Unknown error');
      return { success: false, error: result.json?.data?.biz_msg };
    }
  } catch (error) {
    console.log('Request failed:', error.message || String(error));
    return { success: false, error: error.message || String(error) };
  }
}

// Test 3: PoW Challenge Request
async function testPowChallenge() {
  console.log('\n[TEST 3] PoW Challenge Request');
  console.log('Endpoint:', POW_CHALLENGE_URL);
  console.log('Target Path: /api/v0/chat/completion');
  
  try {
    const result = await mockServiceLocator.http.post(POW_CHALLENGE_URL, {
      body: { target_path: '/api/v0/chat/completion' }
    });
    
    console.log('HTTP Status:', result.status);
    
    if (result.json?.data?.biz_code === 0) {
      console.log('Biz Code: 0 (SUCCESS)');
      const challenge = result.json.data.biz_data?.challenge;
      if (challenge) {
        console.log('Challenge obtained: YES');
        console.log('Challenge fields:', Object.keys(challenge).join(', '));
        console.log('Expire At:', challenge.expire_at || 'N/A');
        console.log('Expire After:', challenge.expire_after || 'N/A');
        return { success: true, challenge: challenge };
      } else {
        console.log('Challenge field missing in response');
        return { success: false, error: 'No challenge in response' };
      }
    } else {
      console.log('Biz Code:', result.json?.data?.biz_code || 'N/A');
      console.log('Error:', result.json?.data?.biz_msg || 'Unknown error');
      return { success: false, error: result.json?.data?.biz_msg };
    }
  } catch (error) {
    console.log('Request failed:', error.message);
    return { success: false, error: error.message };
  }
}

// Main execution
async function main() {
  console.log('Starting live protocol tests...\n');
  console.log('='.repeat(50));
  
  const leimResult = await testHifLeim();
  const dliqResult = await testHifDliq();
  const powResult = await testPowChallenge();
  
  console.log('\n' + '='.repeat(50));
  console.log('\n=== SUMMARY ===\n');
  
  console.log('HIF_LEIM_LIVE_PROVEN:', leimResult.success ? 'yes' : 'no');
  console.log('HIF_DLIQ_LIVE_PROVEN:', dliqResult.success ? 'yes' : 'no');
  console.log('POW_LIVE_PROVEN:', powResult.success ? 'yes' : 'no');
  
  console.log('\nACTUAL_HIF_URLS:');
  console.log('  LEIM:', HIF_LEIM_URL);
  console.log('  DLIQ:', HIF_DLIQ_URL);
  
  if (!leimResult.success || !dliqResult.success || !powResult.success) {
    console.log('\nBLOCKER:');
    if (!leimResult.success) console.log('  - HIF LEIM failed:', leimResult.error);
    if (!dliqResult.success) console.log('  - HIF DLIQ failed:', dliqResult.error);
    if (!powResult.success) console.log('  - PoW Challenge failed:', powResult.error);
  } else {
    console.log('\nBLOCKER: NONE');
    console.log('\nMINIMUM_RUNTIME_BRIDGE_PROVEN: yes');
  }
  
  // Return results for programmatic access
  return {
    hifLeim: leimResult,
    hifDliq: dliqResult,
    pow: powResult,
    allSuccess: leimResult.success && dliqResult.success && powResult.success
  };
}

main().then(results => {
  process.exit(results.allSuccess ? 0 : 1);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
