import { Transaction } from '@stellar/stellar-sdk';
import type { WalletAdapter, SignTransactionOptions } from './types.js';

export interface WalletConnectAppMetadata {
  name: string;
  description: string;
  url: string;
  icons: string[];
}

export interface WalletConnectSignClient {
  connect?: (opts: unknown) => Promise<{ session?: WalletConnectSession; approval?: () => Promise<WalletConnectSession> }>;
  disconnect?: (opts: unknown) => Promise<void>;
  request?: (opts: unknown) => Promise<unknown>;
  [key: string]: unknown;
}

export interface WalletConnectSession {
  topic?: string;
  account?: string;
  namespaces?: Record<string, { accounts?: string[] }>;
  accounts?: string[];
  [key: string]: unknown;
}

export interface WalletConnectAdapterOptions {
  /** WalletConnect v2 Project ID */
  projectId?: string;
  /**
   * CAIP-2 chain identifier (e.g., 'stellar:pubnet', 'stellar:testnet').
   * Must be one of: 'stellar:pubnet', 'stellar:testnet', 'stellar:local'.
   * Defaults to 'stellar:pubnet'.
   */
  chainId?: string | undefined;
  /** DApp metadata for WalletConnect modal/handshake */
  metadata?: WalletConnectAppMetadata;
  /** Optional pre-existing WalletConnect SignClient or provider instance */
  client?: WalletConnectSignClient | unknown;
  /** Optional active session object or mock session */
  session?: WalletConnectSession | unknown;
  /** Milliseconds to wait for the connect handshake before rejecting. Defaults to 30000. */
  connectTimeoutMs?: number;
}

/**
 * Exhaustive map of CAIP-2 identifiers this adapter accepts to their
 * human-readable Stellar network names. Anything not in this map is
 * rejected at construction time so an invalid chain ID never silently
 * reaches the smart contract (fixes #157).
 */
const SUPPORTED_CAIP2_CHAINS: Readonly<Record<string, string>> = {
  'stellar:pubnet':  'mainnet',
  'stellar:testnet': 'testnet',
  'stellar:local':   'local',
};

/**
 * Native WalletConnect v2 adapter for mobile and browser-based wallet integration.
 * Supports Stellar / Soroban transaction signing via CAIP-2 RPC protocols.
 */
export class WalletConnectAdapter implements WalletAdapter {
  private readonly projectId?: string | undefined;
  private readonly chainId: string;
  private readonly metadata?: WalletConnectAppMetadata | undefined;
  private client: WalletConnectSignClient | null;
  private session: WalletConnectSession | null;
  private readonly connectTimeoutMs: number;

  constructor(options: WalletConnectAdapterOptions = {}) {
    this.projectId = options.projectId;
    const chainId  = options.chainId ?? 'stellar:pubnet';

    // Validate the CAIP-2 chain identifier at construction time so callers
    // get an immediate, descriptive error instead of a silent cross-chain
    // payload submission later (fixes #157).
    if (!(chainId in SUPPORTED_CAIP2_CHAINS)) {
      const supported = Object.keys(SUPPORTED_CAIP2_CHAINS).join(', ');
      throw new Error(
        `WalletConnectAdapter: unsupported chainId '${chainId}'. ` +
        `Supported chains: ${supported}.`,
      );
    }

    this.chainId   = chainId;
    this.metadata  = options.metadata;
    this.client    = (options.client as WalletConnectSignClient) ?? null;
    this.session   = (options.session as WalletConnectSession) ?? null;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30000;
  }

  /**
   * Set or update active session.
   */
  setSession(session: WalletConnectSession | unknown): void {
    this.session = (session as WalletConnectSession) ?? null;
  }

  /**
   * Returns true if an active WalletConnect session exists.
   */
  isConnected(): boolean {
    return Boolean(this.session && this.getPublicKeyFromSession());
  }

  /**
   * Gets active public key from session or throws error if not connected.
   */
  async getPublicKey(): Promise<string> {
    const pubKey = this.getPublicKeyFromSession();
    if (!pubKey) {
      throw new Error('WalletConnect adapter is not connected. Call connect() first.');
    }
    return pubKey;
  }

  /**
   * Connect to wallet via WalletConnect v2 handshake or pairing.
   */
  async connect(): Promise<string> {
    if (this.isConnected()) {
      return this.getPublicKey();
    }

    if (this.client && typeof this.client.connect === 'function') {
      const connectResult = await this._withTimeout(
        this.client.connect({
          requiredNamespaces: {
            stellar: {
              methods: ['stellar_signTransaction', 'stellar_signXdr', 'soroban_signTransaction'],
              chains: [this.chainId],
              events: ['accountsChanged', 'chainChanged'],
            },
          },
        }),
        'WalletConnect connect() handshake'
      );

      if (connectResult.session) {
        this.session = connectResult.session;
      } else if (connectResult.approval) {
        this.session = await this._withTimeout(
          connectResult.approval(),
          'WalletConnect approval()'
        );
      }
    }

    const pubKey = this.getPublicKeyFromSession();
    if (!pubKey) {
      throw new Error('Failed to establish WalletConnect session or obtain public key.');
    }

    return pubKey;
  }

  /**
   * Races a network-bound promise against a timeout so that a dropped
   * connection during the handshake rejects cleanly instead of hanging
   * the init promise indefinitely (see #116).
   */
  private _withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${this.connectTimeoutMs}ms (possible network interruption)`));
      }, this.connectTimeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Disconnect the WalletConnect session.
   */
  async disconnect(): Promise<void> {
    if (this.client && this.session && typeof this.client.disconnect === 'function') {
      await this.client.disconnect({
        topic: this.session.topic,
        reason: { code: 6000, message: 'User disconnected' },
      });
    }
    this.session = null;
  }

  /**
   * Sign a transaction using WalletConnect v2 RPC call.
   */
  async signTransaction(
    tx: Transaction | string,
    opts?: SignTransactionOptions,
  ): Promise<Transaction | string> {
    const pubKey = await this.getPublicKey();
    const xdrString = typeof tx === 'string' ? tx : tx.toXDR();
    const passphrase = opts?.networkPassphrase;

    if (!this.client || typeof this.client.request !== 'function') {
      throw new Error('WalletConnect SignClient request handler is not available.');
    }

    const topic = this.session?.topic;
    if (!topic) {
      throw new Error('No active WalletConnect session topic found.');
    }

    // Send RPC request via WalletConnect v2
    const result = await this.client.request({
      topic,
      chainId: this.chainId,
      request: {
        method: 'stellar_signTransaction',
        params: {
          xdr: xdrString,
          accountToSign: opts?.accountToSign ?? pubKey,
          networkPassphrase: passphrase,
        },
      },
    });

    const resRecord = result as Record<string, unknown> | string | undefined;
    const signedXdr = typeof resRecord === 'string'
      ? resRecord
      : (resRecord?.['signedXdr'] ?? resRecord?.['xdr'] ?? resRecord);

    if (typeof signedXdr !== 'string') {
      throw new Error('WalletConnect response did not return valid signed XDR.');
    }

    if (typeof tx === 'string') {
      return signedXdr;
    }

    return new Transaction(signedXdr, passphrase ?? '');
  }

  /**
   * Extract account public key from CAIP-10 address format in WalletConnect session.
   * e.g., 'stellar:pubnet:GABC123...' -> 'GABC123...'
   * Uses safe fallback handling with nullish coalescing to prevent crashes from malformed formats.
   */
  private getPublicKeyFromSession(): string | null {
    if (!this.session) return null;

    // Direct account string on session
    if (typeof this.session.account === 'string') {
      return this.session.account.includes(':')
        ? this.session.account.split(':').at(-1) ?? this.session.account
        : this.session.account;
    }

    // CAIP-10 accounts in namespaces
    const namespaces = this.session.namespaces;
    if (namespaces && namespaces['stellar'] && Array.isArray(namespaces['stellar'].accounts)) {
      const fullAccount = namespaces['stellar'].accounts[0];
      if (fullAccount) {
        return fullAccount.includes(':') ? fullAccount.split(':').at(-1) ?? fullAccount : fullAccount;
      }
    }

    // Fallback: direct accounts array
    if (Array.isArray(this.session.accounts) && this.session.accounts[0]) {
      const fullAccount = this.session.accounts[0];
      return fullAccount.includes(':') ? fullAccount.split(':').at(-1) ?? fullAccount : fullAccount;
    }

    return null;
  }
}
