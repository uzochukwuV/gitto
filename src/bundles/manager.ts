import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { BundleSubmission, LifecycleEntry, FailureType } from '../types';
import { logger, logLifecycleEntry } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

// Jito SDK imports - using actual API from jito-ts
import { searcherClient, SearcherClient } from 'jito-ts/dist/sdk/block-engine/searcher';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types';
import { DroppedReason } from 'jito-ts/dist/gen/block-engine/bundle';

export interface BundleManagerConfig {
  connection: Connection;
  blockEngineUrl: string;
  authKeypair: Keypair;
  tipperKeypair: Keypair;
  transactionLimit?: number;
}

export class BundleManager {
  private connection: Connection;
  private client: SearcherClient | null = null;
  private authKeypair: Keypair;
  private tipperKeypair: Keypair;
  private transactionLimit: number;
  private tipAccounts: string[] = [];
  private currentBlockhash: string = '';
  private lastBlockhashUpdate: Date = new Date();
  private blockhashValidUntil: number = 0;
  private activeBundles: Map<string, LifecycleEntry> = new Map();

  constructor(config: BundleManagerConfig) {
    this.connection = config.connection;
    this.tipperKeypair = config.tipperKeypair;
    this.authKeypair = config.authKeypair;
    this.transactionLimit = config.transactionLimit || 5;
    
    // Create Jito searcher client with gRPC
    this.client = searcherClient(config.blockEngineUrl, this.authKeypair);
    
    logger.info('BundleManager initialized with Jito SDK', { blockEngineUrl: config.blockEngineUrl });
  }

  async initialize(): Promise<void> {
    if (!this.client) {
      throw new Error('Jito searcher client not initialized');
    }

    // Get tip accounts from Jito using actual SDK API
    const tipResult = await this.client.getTipAccounts();
    if (tipResult.ok) {
      this.tipAccounts = tipResult.value;
      logger.info('Loaded tip accounts from Jito', { count: this.tipAccounts.length });
    } else {
      logger.warn('Failed to get tip accounts from Jito', { error: tipResult.error });
    }

    // Get initial blockhash
    await this.refreshBlockhash();
  }

  async refreshBlockhash(commitment: 'processed' | 'confirmed' = 'processed'): Promise<string> {
    try {
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash(commitment);
      this.currentBlockhash = blockhash;
      this.lastBlockhashUpdate = new Date();
      this.blockhashValidUntil = lastValidBlockHeight;
      
      logger.debug('Blockhash refreshed', { 
        blockhash: blockhash.substring(0, 10) + '...',
        lastValidBlockHeight 
      });
      
      return blockhash;
    } catch (error) {
      logger.error('Failed to refresh blockhash', { error });
      throw error;
    }
  }

  isBlockhashExpired(): boolean {
    const timeSinceUpdate = Date.now() - this.lastBlockhashUpdate.getTime();
    return timeSinceUpdate > 55000; // 55 seconds safety margin
  }

  async getTipAccounts(): Promise<string[]> {
    if (this.tipAccounts.length === 0 && this.client) {
      const result = await this.client.getTipAccounts();
      if (result.ok) {
        this.tipAccounts = result.value;
      }
    }
    return this.tipAccounts;
  }

  async calculateDynamicTip(
    historicalTips: number[],
    networkConditions: 'low' | 'medium' | 'high' = 'medium'
  ): Promise<number> {
    const avgTip = historicalTips.length > 0 
      ? historicalTips.reduce((a, b) => a + b, 0) / historicalTips.length 
      : 10000;

    let multiplier = 1.0;
    switch (networkConditions) {
      case 'low':
        multiplier = 0.8;
        break;
      case 'high':
        multiplier = 1.5;
        break;
      default:
        multiplier = 1.0;
    }

    const minTip = 1000;
    const calculatedTip = Math.max(minTip, Math.floor(avgTip * multiplier));
    
    return calculatedTip;
  }

  async submitBundle(
    transactions: VersionedTransaction[],
    tipAmount: number,
    options?: {
      skipPreflight?: boolean;
      maxRetries?: number;
    }
  ): Promise<BundleSubmission> {
    const submissionId = uuidv4();
    const submittedAt = new Date();
    
    if (!this.client) {
      throw new Error('Jito searcher client not initialized');
    }

    // Check and refresh blockhash if needed
    if (this.isBlockhashExpired()) {
      logger.info('Blockhash expired, refreshing before submission');
      await this.refreshBlockhash();
    }

    // Get tip account
    const tipAccounts = await this.getTipAccounts();
    if (tipAccounts.length === 0) {
      throw new Error('No tip accounts available');
    }
    const tipAccount = new PublicKey(tipAccounts[Math.floor(Math.random() * tipAccounts.length)]);

    // Create all transactions including tip
    const allTransactions = [...transactions];
    
    if (tipAmount > 0) {
      const tipTx = this.createTipTransaction(tipAmount, tipAccount);
      allTransactions.push(tipTx);
    }

    // Create Jito Bundle using actual Bundle class from SDK
    const bundle = new Bundle(allTransactions, this.transactionLimit);

    logger.info('Submitting bundle to Jito', { 
      submissionId,
      transactionCount: transactions.length,
      tipAmount,
      tipAccount: tipAccount.toString()
    });

    // Send bundle using actual Jito SDK sendBundle API
    const result = await this.client.sendBundle(bundle);
    
    if (!result.ok) {
      logger.error('Bundle submission to Jito failed', { 
        submissionId, 
        error: result.error 
      });
      throw result.error;
    }

    const submission: BundleSubmission = {
      uuid: result.value,
      submittedAt,
      transactions: transactions.map(tx => this.extractSignature(tx)),
      tipAmount,
      tipAccount: tipAccount.toString(),
      blockhash: this.currentBlockhash
    };

    // Create lifecycle entry
    const currentSlot = await this.connection.getSlot();
    const lifecycleEntry: LifecycleEntry = {
      id: submissionId,
      timestamp: submittedAt,
      slot: currentSlot,
      blockhash: this.currentBlockhash,
      signature: submission.transactions[0] || '',
      bundleUuid: submission.uuid,
      stages: {
        submitted: submittedAt
      },
      tipAmount,
      tipAccount: tipAccount.toString()
    };

    this.activeBundles.set(submission.uuid, lifecycleEntry);
    logLifecycleEntry(lifecycleEntry);

    logger.info('Bundle submitted to Jito successfully', { 
      submissionId,
      uuid: result.value
    });

    return submission;
  }

  private createTipTransaction(tipLamports: number, tipAccount: PublicKey): VersionedTransaction {
    const tipIx = SystemProgram.transfer({
      fromPubkey: this.tipperKeypair.publicKey,
      toPubkey: tipAccount,
      lamports: tipLamports
    });

    const message = new TransactionMessage({
      payerKey: this.tipperKeypair.publicKey,
      recentBlockhash: this.currentBlockhash,
      instructions: [tipIx]
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);
    transaction.sign([this.tipperKeypair]);
    
    return transaction;
  }

  private extractSignature(tx: VersionedTransaction): string {
    if (tx.signatures && tx.signatures.length > 0) {
      return Buffer.from(tx.signatures[0]).toString('hex');
    }
    return '';
  }

  private getDroppedReasonString(reason: DroppedReason): string {
    switch (reason) {
      case DroppedReason.BlockhashExpired:
        return 'Blockhash expired';
      case DroppedReason.PartiallyProcessed:
        return 'Partially processed';
      case DroppedReason.NotFinalized:
        return 'Not finalized';
      default:
        return 'Unknown reason';
    }
  }

  async subscribeToBundleResults(
    callback: (result: {
      bundleId: string;
      finalized?: { timestamp: Date };
      processed?: { slot: number; timestamp: Date };
      rejected?: { reason: string };
      dropped?: { reason: string };
    }) => void,
    errorCallback?: (error: Error) => void
  ): Promise<() => void> {
    if (!this.client) {
      throw new Error('Jito searcher client not initialized');
    }

    // Use Jito's onBundleResult streaming API for real-time bundle results
    const cancelStream = this.client.onBundleResult(
      (bundleResult) => {
        logger.debug('Bundle result received from Jito', { bundleResult });

        // Update lifecycle entry using bundleId
        const entry = this.activeBundles.get(bundleResult.bundleId);
        if (entry) {
          if (bundleResult.finalized) {
            entry.stages.finalized = new Date();
            callback({
              bundleId: bundleResult.bundleId,
              finalized: { timestamp: new Date() }
            });
          } else if (bundleResult.processed) {
            entry.stages.processed = new Date();
            entry.metadata = { processedSlot: bundleResult.processed.slot };
            callback({
              bundleId: bundleResult.bundleId,
              processed: { slot: bundleResult.processed.slot, timestamp: new Date() }
            });
          } else if (bundleResult.rejected) {
            entry.failure = {
              type: FailureType.BUNDLE_REJECTED,
              message: 'Bundle rejected by Jito',
              retryable: true
            };
            callback({
              bundleId: bundleResult.bundleId,
              rejected: { reason: 'Bundle rejected by Jito' }
            });
          } else if (bundleResult.dropped) {
            entry.failure = {
              type: FailureType.BUNDLE_DROPPED,
              message: this.getDroppedReasonString(bundleResult.dropped.reason),
              retryable: true
            };
            callback({
              bundleId: bundleResult.bundleId,
              dropped: { reason: this.getDroppedReasonString(bundleResult.dropped.reason) }
            });
          }
          logLifecycleEntry(entry);
        }
      },
      (error) => {
        logger.error('Bundle result stream error from Jito', { error: error.message });
        if (errorCallback) {
          errorCallback(error);
        }
      }
    );

    return cancelStream;
  }

  async getConnectedLeaders(): Promise<Record<string, any> | null> {
    if (!this.client) {
      return null;
    }

    // Use actual Jito SDK API to get connected leaders
    const result = await this.client.getConnectedLeaders();
    if (result.ok) {
      return result.value;
    }
    logger.warn('Failed to get connected leaders from Jito', { error: result.error });
    return null;
  }

  async getNextScheduledLeader(): Promise<{ currentSlot: number; nextLeaderSlot: number; nextLeaderIdentity: string } | null> {
    if (!this.client) {
      return null;
    }

    // Use actual Jito SDK API to get next scheduled leader
    const result = await this.client.getNextScheduledLeader();
    if (result.ok) {
      return result.value;
    }
    logger.warn('Failed to get next scheduled leader from Jito', { error: result.error });
    return null;
  }

  getActiveBundles(): LifecycleEntry[] {
    return Array.from(this.activeBundles.values());
  }

  getCurrentBlockhash(): string {
    return this.currentBlockhash;
  }

  getBlockhashInfo(): { blockhash: string; lastUpdated: Date; validUntil: number } {
    return {
      blockhash: this.currentBlockhash,
      lastUpdated: this.lastBlockhashUpdate,
      validUntil: this.blockhashValidUntil
    };
  }
}