import { getClient } from './conduit';
import type { PaginatedStreams, CreateStreamParams, CreateStreamResult } from '@conduit-protocol/sdk';

export async function listStreams(address: string): Promise<PaginatedStreams> {
  const client = getClient();
  return client.streams.list({ recipient: address, limit: 50 });
}

export async function createStream(params: CreateStreamParams): Promise<CreateStreamResult> {
  const client = getClient();
  return client.streams.create(params);
}

export async function withdrawStream(streamId: bigint | string): Promise<string> {
  const client = getClient();
  return client.streams.withdraw(streamId);
}
