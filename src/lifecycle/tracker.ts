import { Connection, VersionedTransactionResponse } from '@solana/web3.js';
import { 
  LifecycleEntry, 
  LifecycleStage, 
  FailureType, 
  NetworkHealth 
} from '../types';
import { logger, logLifecycleEntry, readLifecycleLog } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export interface LifecycleTrackerConfig {
  connection: Connection;
  checkIntervalMs?: number;
  maxEntries?: number;
}

export class LifecycleTracker {
  private connection: Connection;
  private checkIntervalMs: number;
  private maxEntries: number;
  private entries: Map<string, LifecycleEntry> = new Map();
  private networkHealthHistory: NetworkHealth[] = [];
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(config: LifecycleTrackerConfig) {
    this.connection = config.connection;
    this.checkIntervalMs = config.checkIntervalMs || 2000;
    this.maxEntries = config.maxEntries || 1000;
  }

  async start(): Promise<void> {
    // Load existing entries from log
    const existingEntries = readLifecycleLog();
    existingEntries.forEach(entry => {
      this.entries.set(entry.id, entry);
    });

    // Start periodic check
    this.checkInterval = setInterval(() => this.checkPendingEntries(), this.checkIntervalMs);
    
    logger.info('LifecycleTracker started', { 
      existingEntries: existingEntries.length,
      checkIntervalMs: this.checkIntervalMs 
    });
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    logger.info('LifecycleTracker stopped');
  }

  createEntry(
    signature: string,
    blockhash: string,
    slot: number,
    tipAmount: number,
    tipAccount: string
  ): LifecycleEntry {
    const entry: LifecycleEntry = {
      id: uuidv4(),
      timestamp: new Date(),
      slot,
      blockhash,
      signature,
      stages: {
        submitted: new Date()
      },
      tipAmount,
      tipAccount
    };

    this.entries.set(entry.id, entry);
    logLifecycleEntry(entry);
    
    return entry;
  }

  async updateEntryProcessed(entryId: string, slot: number): Promise<void> {
    const entry = this.entries.get(entryId);
    if (entry) {
      entry.stages.processed = new Date();
      entry.slot = slot;
      logLifecycleEntry(entry);
      logger.debug('Entry processed', { entryId, slot });
    }
  }

  async updateEntryConfirmed(entryId: string, slot: number): Promise<void> {
    const entry = this.entries.get(entryId);
    if (entry) {
      entry.stages.confirmed = new Date();
      entry.slot = slot;
      logLifecycleEntry(entry);
      logger.debug('Entry confirmed', { entryId, slot });
    }
  }

  async updateEntryFinalized(entryId: string, slot: number): Promise<void> {
    const entry = this.entries.get(entryId);
    if (entry) {
      entry.stages.finalized = new Date();
      entry.slot = slot;
      logLifecycleEntry(entry);
      logger.debug('Entry finalized', { entryId, slot });
    }
  }

  markEntryFailed(
    entryId: string, 
    failureType: FailureType, 
    message: string,
    retryable: boolean = true
  ): void {
    const entry = this.entries.get(entryId);
    if (entry) {
      entry.failure = {
        type: failureType,
        message,
        retryable
      };
      logLifecycleEntry(entry);
      logger.warn('Entry marked as failed', { entryId, failureType, message });
    }
  }

  markEntryExpired(entryId: string): void {
    this.markEntryFailed(entryId, FailureType.BLOCKHASH_EXPIRED, 'Blockhash expired before confirmation', true);
  }

  async checkPendingEntries(): Promise<void> {
    const pendingEntries = Array.from(this.entries.values())
      .filter(e => !e.stages.finalized && !e.failure);

    for (const entry of pendingEntries) {
      try {
        const signatures = await this.connection.getSignatureStatuses([entry.signature], {
          searchTransactionHistory: true
        });

        const status = signatures.value[0];
        
        if (status) {
          // Check if transaction failed
          if (status.err) {
            const failureType = this.classifyError(status.err);
            this.markEntryFailed(entry.id, failureType, JSON.stringify(status.err), true);
            continue;
          }

          // Update stages based on confirmation
          const slot = (status as any).slot;
          if (slot) {
            if (!entry.stages.processed) {
              await this.updateEntryProcessed(entry.id, slot);
            }

            // Check for confirmations using confirmationStatus
            const confirmationStatus = (status as any).confirmationStatus;
            if (confirmationStatus === 'confirmed' || confirmationStatus === 'finalized') {
              if (!entry.stages.confirmed) {
                await this.updateEntryConfirmed(entry.id, slot);
              }
            }
          }

          // Check for finalization (blockhash expiration)
          if (entry.blockhash) {
            try {
              const validityResult = await this.connection.isBlockhashValid(entry.blockhash);
              if (!validityResult.value) {
                this.markEntryExpired(entry.id);
              }
            } catch (error) {
              // Ignore errors checking blockhash validity
            }
          }
        }
      } catch (error) {
        logger.debug('Error checking entry status', { entryId: entry.id, error });
      }
    }
  }

  private classifyError(error: any): FailureType {
    if (!error) return FailureType.UNKNOWN;

    // Check for specific error codes
    const errorStr = JSON.stringify(error).toLowerCase();

    if (errorStr.includes('blockhash') && errorStr.includes('not found')) {
      return FailureType.BLOCKHASH_EXPIRED;
    }
    if (errorStr.includes('fees') || errorStr.includes('too low')) {
      return FailureType.FEE_TOO_LOW;
    }
    if (errorStr.includes('compute') || errorStr.includes('exceeded')) {
      return FailureType.COMPUTE_EXCEEDED;
    }
    if (errorStr.includes('bundle') || errorStr.includes('rejected')) {
      return FailureType.BUNDLE_REJECTED;
    }

    return FailureType.UNKNOWN;
  }

  calculateNetworkHealth(): NetworkHealth {
    const recentEntries = Array.from(this.entries.values())
      .filter(e => e.stages.processed && e.stages.confirmed)
      .slice(-20); // Last 20 entries

    let totalProcessedToConfirmed = 0;
    let totalConfirmedToFinalized = 0;
    let count = 0;

    for (const entry of recentEntries) {
      if (entry.stages.processed && entry.stages.confirmed) {
        totalProcessedToConfirmed += 
          entry.stages.confirmed.getTime() - entry.stages.processed.getTime();
        count++;
      }
      if (entry.stages.confirmed && entry.stages.finalized) {
        totalConfirmedToFinalized += 
          entry.stages.finalized.getTime() - entry.stages.confirmed.getTime();
      }
    }

    return {
      processedToConfirmedDelta: count > 0 ? totalProcessedToConfirmed / count : 0,
      confirmedToFinalizedDelta: count > 0 ? totalConfirmedToFinalized / count : 0,
      currentSlot: 0, // Will be updated from streaming
      slotProduction: 0,
      lastUpdated: new Date()
    };
  }

  getEntries(): LifecycleEntry[] {
    return Array.from(this.entries.values());
  }

  getSuccessfulEntries(): LifecycleEntry[] {
    return Array.from(this.entries.values())
      .filter(e => e.stages.finalized && !e.failure);
  }

  getFailedEntries(): LifecycleEntry[] {
    return Array.from(this.entries.values())
      .filter(e => e.failure);
  }

  getEntryBySignature(signature: string): LifecycleEntry | undefined {
    return Array.from(this.entries.values()).find(e => e.signature === signature);
  }

  getStats(): {
    total: number;
    successful: number;
    failed: number;
    pending: number;
    averageLatency: number;
  } {
    const entries = Array.from(this.entries.values());
    const successful = entries.filter(e => e.stages.finalized);
    const failed = entries.filter(e => e.failure);
    const pending = entries.filter(e => !e.stages.finalized && !e.failure);

    let totalLatency = 0;
    let latencyCount = 0;

    for (const entry of successful) {
      if (entry.stages.submitted && entry.stages.finalized) {
        totalLatency += entry.stages.finalized.getTime() - entry.stages.submitted.getTime();
        latencyCount++;
      }
    }

    return {
      total: entries.length,
      successful: successful.length,
      failed: failed.length,
      pending: pending.length,
      averageLatency: latencyCount > 0 ? totalLatency / latencyCount : 0
    };
  }

  clearOldEntries(keepCount: number = 100): void {
    const entries = Array.from(this.entries.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    
    if (entries.length > keepCount) {
      const toRemove = entries.slice(keepCount);
      toRemove.forEach(e => this.entries.delete(e.id));
      logger.info('Cleared old entries', { removed: toRemove.length, kept: keepCount });
    }
  }
}