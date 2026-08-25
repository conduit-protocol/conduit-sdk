/**
 * Example: Construct and batch stream operations using the Fluent Builder API.
 *
 * Run with:
 *   npx ts-node examples/fluent-builder.ts
 */

import { StreamBuilder, ConduitBatcher } from '../src/index.js';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

async function main() {
  console.log('Building stream configurations...');

  // Generate valid dummy addresses for the example
  const SENDER = Keypair.random().publicKey();
  const RECIPIENT_A = Keypair.random().publicKey();
  const RECIPIENT_B = Keypair.random().publicKey();
  const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 1)); // Dummy contract ID
  const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 2));

  // Build stream 1
  const stream1 = new StreamBuilder()
    .token(TOKEN)
    .sender(SENDER)
    .recipient(RECIPIENT_A)
    .amount(500)
    .build();

  console.log('Stream 1 built:', stream1);

  // Build stream 2
  const stream2 = new StreamBuilder()
    .token(TOKEN)
    .sender(SENDER)
    .recipient(RECIPIENT_B)
    .amount(1200)
    .build();

  console.log('Stream 2 built:', stream2);

  console.log('\nExecuting batch operation via ConduitBatcher...');
  const batcher = new ConduitBatcher();
  const result = batcher.execute([stream1, stream2], {
    context: { 
      network: 'testnet', 
      networkPassphrase: 'Test SDF Network ; September 2015',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      contractId: CONTRACT_ID,
      sourceAccount: SENDER,
      sequence: 123456789n
    }
  });

  if (result.success) {
    console.log('✅ Batch Execution Result:');
    console.log('  Success:      ', result.success);
    console.log('  Operations:   ', result.operations);
    console.log('  Transaction XDR:', result.xdr);
  } else {
    console.log('❌ Batch Execution Failed:');
    console.log('  Errors:       ', result.errors);
  }
}

main().catch(console.error);
