import { useState, useEffect, useCallback } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';
import type { StreamInfo } from '@conduit-protocol/sdk';

export interface UseStreamResult {
  stream: StreamInfo | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useStream(streamId: bigint | string | null | undefined): UseStreamResult {
  const { client, isReady } = useStreamFiClient();
  const [stream, setStream] = useState<StreamInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback(() => {
    if (!isReady || !client || streamId == null) {
      setStream(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    client.streams
      .get(streamId)
      .then((data) => {
        setStream(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  }, [client, isReady, streamId]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { stream, loading, error, refetch: fetch };
}
