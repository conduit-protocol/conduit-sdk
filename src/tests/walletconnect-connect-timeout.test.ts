import { describe, it, expect } from 'vitest';
import { WalletConnectAdapter } from '../adapters/walletconnect.js';

describe('WalletConnectAdapter connect() network interruption', () => {
  it('rejects with a timeout error instead of hanging when the handshake never resolves', async () => {
    const hangingClient = {
      connect: () => new Promise(() => {}), // simulates dropped network, never resolves
    };
    const adapter = new WalletConnectAdapter({
      client: hangingClient as any,
      connectTimeoutMs: 100,
    });

    await expect(adapter.connect()).rejects.toThrow(/timed out/i);
  });
});