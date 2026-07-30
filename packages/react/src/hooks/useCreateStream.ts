import { useState, useCallback } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';
import type { CreateStreamParams, CreateStreamResult } from '@conduit-protocol/sdk';

export interface UseCreateStreamState {
  loading: boolean;
  error: Error | null;
  result: CreateStreamResult | null;
}

export type CreateStreamFn = (params: CreateStreamParams) => Promise<CreateStreamResult>;

export interface UseCreateStreamResult extends UseCreateStreamState {
  createStream: CreateStreamFn;
  reset: () => void;
}

export function useCreateStream(): UseCreateStreamResult {
  const { client, isReady } = useStreamFiClient();
  const [state, setState] = useState<UseCreateStreamState>({
    loading: false,
    error: null,
    result: null,
  });

  const reset = useCallback(() => {
    setState({ loading: false, error: null, result: null });
  }, []);

  const createStream = useCallback(
    async (params: CreateStreamParams): Promise<CreateStreamResult> => {
      if (!isReady || !client) {
        const err = new Error('ConduitClient is not connected. Wrap your component with <StreamFiProvider>.');
        setState({ loading: false, error: err, result: null });
        throw err;
      }

      setState({ loading: true, error: null, result: null });

      try {
        const result = await client.streams.create(params);
        setState({ loading: false, error: null, result });
        return result;
      } catch (err: unknown) {
        const typed = err instanceof Error ? err : new Error(String(err));
        setState({ loading: false, error: typed, result: null });
        throw typed;
      }
    },
    [client, isReady],
  );

  return { ...state, createStream, reset };
}
