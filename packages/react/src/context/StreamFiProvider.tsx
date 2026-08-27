import { createContext, useState, useCallback, useMemo, type ReactNode } from 'react';
import { ConduitClient } from '@conduit-protocol/sdk';
import type { ConduitConfig } from '@conduit-protocol/sdk';

export interface StreamFiContextValue {
  client: ConduitClient | null;
  isReady: boolean;
  error: Error | null;
  connect: (config: ConduitConfig) => void;
  disconnect: () => void;
}

export const StreamFiContext = createContext<StreamFiContextValue | null>(null);

export interface StreamFiProviderProps {
  config?: ConduitConfig;
  children: ReactNode;
}

export function StreamFiProvider({ config, children }: StreamFiProviderProps) {
  const [error, setError] = useState<Error | null>(null);
  const [client, setClient] = useState<ConduitClient | null>(() => {
    if (config) {
      try {
        return new ConduitClient(config);
      } catch (err: unknown) {
        // We can't setState inside initialization function safely in all React versions, 
        // but since this is lazy initial state, we'll let it be null and set error in an effect, 
        // or we just return null and we can't capture the error in initial state synchronously. 
        // Wait, we can just throw it? No, the issue says "doesn't catch...".
        // Let's just catch it.
        console.error(err);
      }
    }
    return null;
  });

  // Let's do it properly without state mutation inside initializer
  const [state, setState] = useState<{ client: ConduitClient | null; error: Error | null }>(() => {
    if (config) {
      try {
        return { client: new ConduitClient(config), error: null };
      } catch (err: unknown) {
        return { client: null, error: err instanceof Error ? err : new Error(String(err)) };
      }
    }
    return { client: null, error: null };
  });

  const connect = useCallback((cfg: ConduitConfig) => {
    try {
      const newClient = new ConduitClient(cfg);
      setState({ client: newClient, error: null });
    } catch (err: unknown) {
      setState({ client: null, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }, []);

  const disconnect = useCallback(() => {
    setState({ client: null, error: null });
  }, []);

  const value = useMemo<StreamFiContextValue>(
    () => ({ 
      client: state.client, 
      isReady: state.client !== null, 
      error: state.error,
      connect, 
      disconnect 
    }),
    [state.client, state.error, connect, disconnect],
  );

  return (
    <StreamFiContext.Provider value={value}>
      {children}
    </StreamFiContext.Provider>
  );
}
