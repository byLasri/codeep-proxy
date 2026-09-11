import { DEEPSEEK } from './constants';

/**
 * StateManager: Unified Cloudflare KV storage for credentials and dynamic tokens.
 * 
 * Keys:
 * - 'creds:auth_token': The authorization bearer token
 * - 'creds:cookies': JSON stringified array of cookies
 * - 'hif:leim_token': The current valid HIF-LEIM token
 * - 'hif:leim_expiry': Timestamp (ms) when the HIF-LEIM token expires
 */
export class StateManager {
  private kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  // --- Credentials Management ---

  async getAuthToken(): Promise<string | null> {
    return await this.kv.get('creds:auth_token');
  }

  async setAuthToken(token: string): Promise<void> {
    await this.kv.put('creds:auth_token', token);
  }

  async getCookies(): Promise<Cookie[] | null> {
    const raw = await this.kv.get('creds:cookies');
    return raw ? JSON.parse(raw) : null;
  }

  async setCookies(cookies: Cookie[]): Promise<void> {
    await this.kv.put('creds:cookies', JSON.stringify(cookies));
  }

  async getCredentials(): Promise<{ token: string | null; cookies: Cookie[] | null }> {
    const [token, cookies] = await Promise.all([
      this.getAuthToken(),
      this.getCookies()
    ]);
    return { token, cookies };
  }

  async setCredentials(token: string, cookies: Cookie[]): Promise<void> {
    await Promise.all([
      this.setAuthToken(token),
      this.setCookies(cookies)
    ]);
  }

  // --- HIF-LEIM Management ---

  async getHifLeim(): Promise<string | null> {
    const expiryRaw = await this.kv.get('hif:leim_expiry');
    if (!expiryRaw) return null;

    const expiry = parseInt(expiryRaw, 10);
    if (Date.now() >= expiry) {
      // Expired, clean up
      await this.clearHifLeim();
      return null;
    }

    return await this.kv.get('hif:leim_token');
  }

  async setHifLeim(token: string, ttlSeconds: number = DEEPSEEK.HIF.TTL_SECONDS): Promise<void> {
    const expiry = Date.now() + (ttlSeconds * 1000);
    await Promise.all([
      this.kv.put('hif:leim_token', token, { expirationTtl: ttlSeconds }),
      this.kv.put('hif:leim_expiry', expiry.toString(), { expirationTtl: ttlSeconds })
    ]);
  }

  async clearHifLeim(): Promise<void> {
    await Promise.all([
      this.kv.delete('hif:leim_token'),
      this.kv.delete('hif:leim_expiry')
    ]);
  }
}

// Helper type for cookies if not globally defined in this context
interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  secure?: boolean;
  httpOnly?: boolean;
}
