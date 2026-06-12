import { Connection } from '@solana/web3.js';
import { SlotUpdate, LeaderInfo, ConnectionStatus } from '../types';
import { logger } from '../utils/logger';

export interface StreamingConfig {
  rpcUrl: string;
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

export class StreamingManager {
  private connection: Connection | null = null;
  private config: StreamingConfig;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private lastSlot: number = 0;
  private lastHeartbeat: Date = new Date();
  private pollingInterval: NodeJS.Timeout | null = null;

  private slotCallbacks: ((update: SlotUpdate) => void)[] = [];
  private leaderCallbacks: ((leader: LeaderInfo) => void)[] = [];
  private txCallbacks: ((tx: any) => void)[] = [];
  private statusCallbacks: ((status: ConnectionStatus) => void)[] = [];

  constructor(config: StreamingConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      logger.info('Connecting to Solana RPC...', { endpoint: this.config.rpcUrl });

      this.connection = new Connection(this.config.rpcUrl, this.config.commitment || 'confirmed');
      
      // Test connection by getting current slot
      const slot = await this.connection.getSlot();
      this.lastSlot = slot;
      this.isConnected = true;
      this.lastHeartbeat = new Date();
      this.reconnectAttempts = 0;

      logger.info('Connected to Solana RPC', { slot });
      this.notifyStatusChange();
    } catch (error) {
      logger.error('Failed to connect to Solana RPC', { error });
      this.isConnected = false;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.pollingInterval) {
        clearInterval(this.pollingInterval);
        this.pollingInterval = null;
      }
      this.connection = null;
      this.isConnected = false;
      logger.info('Disconnected from Solana RPC');
      this.notifyStatusChange();
    } catch (error) {
      logger.error('Error disconnecting from Solana RPC', { error });
    }
  }

  async subscribeToSlots(
    commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed'
  ): Promise<void> {
    if (!this.connection) {
      throw new Error('Not connected to Solana RPC');
    }

    try {
      // Poll for slot updates
      this.pollingInterval = setInterval(async () => {
        try {
          const slot = await this.connection!.getSlot(commitment);
          
          if (slot !== this.lastSlot) {
            const slotUpdate: SlotUpdate = {
              slot,
              parent: 0, // Would need to get from block for actual parent
              status: commitment === 'finalized' ? 'rooted' : commitment,
              timestamp: new Date()
            };

            this.lastSlot = slot;
            this.lastHeartbeat = new Date();

            // Notify all slot callbacks
            this.slotCallbacks.forEach(cb => cb(slotUpdate));
            logger.debug('Slot update', { slot: slotUpdate.slot, status: slotUpdate.status });
          }
        } catch (error) {
          logger.debug('Error polling slot', { error: (error as Error).message });
        }
      }, 1000); // Poll every second

      logger.info('Subscribed to slot updates', { commitment });
    } catch (error) {
      logger.error('Failed to subscribe to slots', { error });
      throw error;
    }
  }

  async subscribeToTransactions(
    accounts: string[] = [],
    includeFailed: boolean = true
  ): Promise<void> {
    // For a simpler implementation without gRPC, we use the connection's onSignature subscription
    if (!this.connection) {
      throw new Error('Not connected to Solana RPC');
    }

    logger.info('Transaction subscription not implemented without gRPC', { accounts: accounts.length });
  }

  onSlotUpdate(callback: (update: SlotUpdate) => void): void {
    this.slotCallbacks.push(callback);
  }

  onLeaderUpdate(callback: (leader: LeaderInfo) => void): void {
    this.leaderCallbacks.push(callback);
  }

  onTransaction(callback: (tx: any) => void): void {
    this.txCallbacks.push(callback);
  }

  onStatusChange(callback: (status: ConnectionStatus) => void): void {
    this.statusCallbacks.push(callback);
  }

  private notifyStatusChange(): void {
    const status: ConnectionStatus = {
      rpc: this.isConnected,
      blockEngine: this.isConnected,
      geyser: this.isConnected,
      lastHeartbeat: this.lastHeartbeat
    };
    this.statusCallbacks.forEach(cb => cb(status));
  }

  getCurrentSlot(): number {
    return this.lastSlot;
  }

  getConnectionStatus(): ConnectionStatus {
    return {
      rpc: this.isConnected,
      blockEngine: this.isConnected,
      geyser: this.isConnected,
      lastHeartbeat: this.lastHeartbeat
    };
  }

  isHealthy(): boolean {
    const thirtySecondsAgo = new Date(Date.now() - 30000);
    return this.isConnected && this.lastHeartbeat > thirtySecondsAgo;
  }

  getConnection(): Connection | null {
    return this.connection;
  }
}