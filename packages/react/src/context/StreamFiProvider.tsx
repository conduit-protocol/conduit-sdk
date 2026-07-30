import { createContext, useState, useCallback, useMemo, type ReactNode } from 'react';
import { ConduitClient } from '@conduit-protocol/sdk';
import type { ConduitConfig } from '@conduit-protocol/sdk';

export interface StreamFiContextValue {
  client: ConduitClient | null;
  isReady: boolean;
  connect: (config: ConduitConfig) => void;
  disconnect: () => void;
}

export const StreamFiContext = createContext<StreamFiContextValue | null>(null);

export interface StreamFiProviderProps {
  config?: ConduitConfig;
  children: ReactNode;
}

export function StreamFiProvider({ config, children }: StreamFiProviderProps) {
  const [client, setClient] = useState<ConduitClient | null>(() =>
    config ? new ConduitClient(config) : null,
  );

  const connect = useCallback((cfg: ConduitConfig) => {
    setClient(new ConduitClient(cfg));
  }, []);

  const disconnect = useCallback(() => {
    setClient(null);
  }, []);

  const value = useMemo<StreamFiContextValue>(
    () => ({ client, isReady: client !== null, connect, disconnect }),
    [client, connect, disconnect],
  );

  return (
    <StreamFiContext.Provider value={value}>
      {children}
    </StreamFiContext.Provider>
  );
}
