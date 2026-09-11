// Test script to verify DeepSeek API connection
import { DeepSeekWebClient } from './src/deepseek/client.js';
import { DEEPSEEK } from './src/deepseek/constants.js';

// Extract credentials from environment variables
const DEEPSEEK_AUTH = process.env.DEEPSEEK_AUTH || undefined;
const DEEP_COOKIES = process.env.DEEP_COOKIES || undefined;

console.log('=== Environment Credentials ===');
console.log(`DEEPSEEK_AUTH: ${DEEPSEEK_AUTH ? 'present' : 'missing'}`);
console.log(`DEEP_COOKIES: ${DEEP_COOKIES ? 'present' : 'missing'}`);
console.log('');

async function testConnection() {
  console.log('Testing DeepSeek API connection...\n');
  console.log(`Target Origin: ${DEEPSEEK.ORIGIN}`);
  console.log(`Completion Endpoint: ${DEEPSEEK.ENDPOINTS.COMPLETION}\n`);

  // Create client with credentials from environment
  const client = new DeepSeekWebClient({
    credentials: {
      authorization: DEEPSEEK_AUTH,
      cookie: DEEP_COOKIES,
    },
  });

  try {
    console.log('Attempting to create session...');
    const session = await client.createSession();
    console.log('Session created:', session);
  } catch (error: any) {
    console.log('Session creation failed (expected without auth):');
    console.log(`  Status: ${error.message}`);
    if (error.cause) {
      console.log(`  Cause: ${error.cause}`);
    }
  }

  console.log('\n--- Testing PoW Challenge Endpoint ---\n');
  
  try {
    console.log('Attempting to fetch PoW challenge...');
    const response = await fetch(`${DEEPSEEK.ORIGIN}${DEEPSEEK.ENDPOINTS.CREATE_POW}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-bundle-id': DEEPSEEK.CLIENT.BUNDLE_ID,
        'x-client-platform': DEEPSEEK.CLIENT.PLATFORM,
        'x-client-version': DEEPSEEK.CLIENT.VERSION,
        'x-client-locale': DEEPSEEK.CLIENT.LOCALE,
      },
      body: JSON.stringify({}),
    });
    
    console.log(`Response Status: ${response.status} ${response.statusText}`);
    console.log('Response Headers:');
    response.headers.forEach((value, key) => {
      console.log(`  ${key}: ${value}`);
    });
    
    const data = await response.json();
    console.log('\nResponse Body:');
    console.log(JSON.stringify(data, null, 2));
    
  } catch (error: any) {
    console.log('PoW challenge request failed:');
    console.log(`  Error: ${error.message}`);
    if (error.cause) {
      console.log(`  Cause: ${error.cause}`);
    }
  }

  console.log('\n--- Test Complete ---');
}

testConnection().catch(console.error);
