import { ConduitClient } from '@conduit-protocol/sdk';
import { Keypair } from '@stellar/stellar-sdk';

function getNetwork(): 'mainnet' | 'testnet' | 'local' {
  const n = process.env.NEXT_PUBLIC_NETWORK;
  if (n === 'mainnet' || n === 'testnet' || n === 'local') return n;
  return 'testnet';
}

function getKeypair(): Keypair | undefined {
  // Deliberately NOT NEXT_PUBLIC_-prefixed: that prefix tells Next.js to
  // inline the value into the client-side JS bundle, which would ship this
  // signing secret to every browser that loads the page. getClient() is only
  // ever called from Server Actions ('use server' in lib/streams.ts), so a
  // server-only env var is both correct and safe here.
  const secret = process.env.STELLAR_SECRET;
  if (!secret) return undefined;
  return Keypair.fromSecret(secret);
}

let _client: ConduitClient | null = null;

export function getClient(): ConduitClient {
  if (_client) return _client;
  _client = new ConduitClient({
    network: getNetwork(),
    keypair: getKeypair(),
  });
  return _client;
}

export function resetClient(): void {
  _client = null;
}
