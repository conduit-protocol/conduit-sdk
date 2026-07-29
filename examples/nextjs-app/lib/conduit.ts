import { ConduitClient } from '@conduit-protocol/sdk';
import { Keypair } from '@stellar/stellar-sdk';

function getNetwork(): 'mainnet' | 'testnet' | 'local' {
  const n = process.env.NEXT_PUBLIC_NETWORK;
  if (n === 'mainnet' || n === 'testnet' || n === 'local') return n;
  return 'testnet';
}

function getKeypair(): Keypair | undefined {
  const secret = process.env.NEXT_PUBLIC_STELLAR_SECRET;
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
