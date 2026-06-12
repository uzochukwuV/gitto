import { Connection } from '@solana/web3.js';
import Client, { CommitmentLevel, SubscribeRequest } from '@triton-one/yellowstone-grpc';
import { SlotUpdate, LeaderInfo, ConnectionStatus } from '../types';
import { logger } from '../utils/logger';

export interface StreamingConfig {
  endpoint: string;
  token?: string;
}

export class StreamingManager {
  private client: Client | null = null;
  private connection: Connection | null = null;
  private config: StreamingConfig;
  private isConnected: boolean = false;
  private slotStream: any = null;
  private txStream: any = null;
  private lastSlot: number = 0;
  private lastHeartbeat: Date = new Date();

  private slotCallbacks: ((update: SlotUpdate) => void)[] = [];
  private leaderCallbacks: ((leader: LeaderInfo) => void)[] = [];
  private txCallbacks: ((tx: any) => void)[] = [];
  private statusCallbacks: ((status: ConnectionStatus) => void)[] = [];

  constructor(config: StreamingConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      logger.info('Connecting to Yellowstone gRPC...', { endpoint: this.config.endpoint });

      // Create Yellowstone gRPC client with auto-reconnect
      this.client = new Client(
        this.config.endpoint,
        this.config.token || '',
        {
          grpcMaxDecodingMessageSize: 64 * 1024 * 1024, // 64MiB
        },
        {
          enabled: true,
          backoff: {
            initialIntervalMs: 100,
            multiplier: 2,
            maxRetries: 10
          },
          slotRetention: 250
        }
      );

      // Connect to Yellowstone
      await this.client.connect();
      this.isConnected = true;
      this.lastHeartbeat = new Date();

      logger.info('Connected to Yellowstone gRPC');
      this.notifyStatusChange();
    } catch (error) {
      logger.error('Failed to connect to Yellowstone gRPC', { error });
      this.isConnected = false;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      // Cancel streams
      if (this.slotStream) {
        this.slotStream.cancel();
        this.slotStream = null;
      }
      if (this.txStream) {
        this.txStream.cancel();
        this.txStream = null;
      }

      // End client connection
      if (this.client) {
        // Client doesn't have an explicit end method - just set to null
        this.client = null;
      }

      this.isConnected = false;
      logger.info('Disconnected from Yellowstone gRPC');
      this.notifyStatusChange();
    } catch (error) {
      logger.error('Error disconnecting from Yellowstone', { error });
    }
  }

  async subscribeToSlots(
    commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed'
  ): Promise<void> {
    if (!this.client || !this.isConnected) {
      throw new Error('Not connected to Yellowstone');
    }

    try {
      const commitmentLevel = CommitmentLevel[commitment.toUpperCase() as keyof typeof CommitmentLevel];

      // Build subscribe request with slots only
      const request: SubscribeRequest = {
        slots: {
          client: {
            filterByCommitment: commitment !== 'finalized'
          }
        },
        transactions: {},
        transactionsStatus: {},
        accounts: {},
        entry: {},
        blocks: {},
        blocksMeta: {},
        commitment: commitmentLevel,
        accountsDataSlice: [],
        ping: { id: 1 }
      };

      // Subscribe to slot updates using Yellowstone gRPC
      this.slotStream = await this.client.subscribe(request);

      this.slotStream.on('data', (data: any) => {
        if (data.slot) {
          const slotUpdate: SlotUpdate = {
            slot: Number(data.slot.slot),
            parent: Number(data.slot.parent || 0),
            status: this.mapSlotStatus(data.slot.status),
            timestamp: new Date()
          };

          this.lastSlot = slotUpdate.slot;
          this.lastHeartbeat = new Date();

          // Notify all slot callbacks
          this.slotCallbacks.forEach(cb => cb(slotUpdate));
          logger.debug('Slot update from Yellowstone', { slot: slotUpdate.slot, status: slotUpdate.status });
        }
      });

      this.slotStream.on('error', (error: Error) => {
        logger.error('Slot stream error from Yellowstone', { error: error.message });
      });

      this.slotStream.on('end', () => {
        logger.warn('Slot stream ended from Yellowstone');
      });

      logger.info('Subscribed to slot updates via Yellowstone', { commitment });
    } catch (error) {
      logger.error('Failed to subscribe to slots via Yellowstone', { error });
      throw error;
    }
  }

  async subscribeToTransactions(
    accounts: string[] = [],
    includeFailed: boolean = true
  ): Promise<void> {
    if (!this.client || !this.isConnected) {
      throw new Error('Not connected to Yellowstone');
    }

    try {
      // Build subscribe request with transactions only
      const request: SubscribeRequest = {
        slots: {},
        transactions: {
          client: {
            vote: false,
            failed: includeFailed,
            accountInclude: accounts,
            accountExclude: [],
            accountRequired: []
          }
        },
        transactionsStatus: {
          client: {
            vote: false,
            failed: includeFailed,
            accountInclude: accounts,
            accountExclude: [],
            accountRequired: []
          }
        },
        accounts: {},
        entry: {},
        blocks: {},
        blocksMeta: {},
        commitment: CommitmentLevel.PROCESSED,
        accountsDataSlice: [],
        ping: { id: 1 }
      };

      // Subscribe to transaction updates
      this.txStream = await this.client.subscribe(request);

      this.txStream.on('data', (data: any) => {
        if (data.transaction) {
          const txData = {
            slot: data.transaction.slot,
            signature: this.extractSignature(data.transaction.transaction),
            isVote: data.transaction.transaction.is_vote || false,
            success: !data.transaction.transaction.meta?.err,
            error: data.transaction.transaction.meta?.err || null,
            logs: data.transaction.transaction.meta?.logs || []
          };

          this.txCallbacks.forEach(cb => cb(txData));
        }
      });

      this.txStream.on('error', (error: Error) => {
        logger.error('Transaction stream error from Yellowstone', { error: error.message });
      });

      this.txStream.on('end', () => {
        logger.warn('Transaction stream ended from Yellowstone');
      });

      logger.info('Subscribed to transaction updates via Yellowstone', { accounts: accounts.length });
    } catch (error) {
      logger.error('Failed to subscribe to transactions via Yellowstone', { error });
      throw error;
    }
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

  private mapSlotStatus(status: number | string): 'confirmed' | 'processed' | 'rooted' {
    if (typeof status === 'string') {
      return status as 'confirmed' | 'processed' | 'rooted';
    }
    // 0 = processed, 1 = confirmed, 2 = rooted
    switch (status) {
      case 0: return 'processed';
      case 1: return 'confirmed';
      case 2: return 'rooted';
      default: return 'confirmed';
    }
  }

  private extractSignature(transaction: any): string {
    if (transaction.signature) {
      return Buffer.from(transaction.signature).toString('hex');
    }
    return '';
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

  getClient(): Client | null {
    return this.client;
  }

  getConnection(): Connection | null {
    return this.connection;
  }
}