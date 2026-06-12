import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { BundleSubmission, TipAccountData, LifecycleEntry, FailureType } from '../types';
import { logger, logLifecycleEntry } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export interface BundleManagerConfig {
  connection: Connection;
  blockEngineUrl: string;
  authKeypair: Keypair;
  tipperKeypair: Keypair;
  transactionLimit?: number;
}

// Jito tip accounts for devnet
const JITO_TIP_ACCOUNTS_DEVNET = [
  'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY', // Example tip account
];

export class BundleManager {
  private connection: Connection;
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
    
    // Initialize tip accounts
    this.tipAccounts = JITO_TIP_ACCOUNTS_DEVNET;
    
    logger.info('BundleManager initialized', { blockEngineUrl: config.blockEngineUrl });
  }

  async initialize(): Promise<void> {
    // Get initial blockhash
    await this.refreshBlockhash();
    
    // Try to fetch tip accounts from Jito API if available
    try {
      const response = await fetch(`https://${this.connection.rpcEndpoint}/api/v1/tips`);
      if (response.ok) {
        const data = await response.json() as { accounts?: string[] };
        if (data.accounts && Array.isArray(data.accounts)) {
          this.tipAccounts = data.accounts;
          logger.info('Loaded tip accounts from Jito', { count: this.tipAccounts.length });
        }
      }
    } catch (error) {
      logger.warn('Failed to fetch tip accounts from Jito API, using defaults', { error });
    }
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
    // Check if we're past the last valid block height
    // This is a simplified check - in production you'd check the actual block height
    const timeSinceUpdate = Date.now() - this.lastBlockhashUpdate.getTime();
    // Blockhash is typically valid for ~150 slots, or about 1 minute
    return timeSinceUpdate > 60000; // 60 seconds safety margin
  }

  async getTipAccounts(): Promise<string[]> {
    return this.tipAccounts;
  }

  async calculateDynamicTip(
    historicalTips: number[],
    networkConditions: 'low' | 'medium' | 'high' = 'medium'
  ): Promise<number> {
    // Calculate average from historical tips
    const avgTip = historicalTips.length > 0 
      ? historicalTips.reduce((a, b) => a + b, 0) / historicalTips.length 
      : 10000; // Default 0.00001 SOL

    // Adjust based on network conditions
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

    // Add minimum tip and round
    const minTip = 1000; // 0.000001 SOL
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
    
    // Add tip transaction if tipAmount > 0
    if (tipAmount > 0) {
      const tipTx = this.createTipTransaction(tipAmount, tipAccount);
      allTransactions.push(tipTx);
    }

    // Send bundle via RPC (simulating Jito bundle submission)
    logger.info('Submitting bundle', { 
      submissionId,
      transactionCount: transactions.length,
      tipAmount,
      tipAccount: tipAccount.toString()
    });

    try {
      // Submit each transaction to the network
      const signatures: string[] = [];
      for (const tx of allTransactions) {
        const signature = await this.connection.sendTransaction(tx, {
          skipPreflight: options?.skipPreflight ?? false,
          preflightCommitment: 'processed'
        });
        signatures.push(signature);
        logger.debug('Transaction sent', { signature });
      }

      const submission: BundleSubmission = {
        uuid: submissionId,
        submittedAt,
        transactions: signatures,
        tipAmount,
        tipAccount: tipAccount.toString(),
        blockhash: this.currentBlockhash
      };

      // Create lifecycle entry
      const lifecycleEntry: LifecycleEntry = {
        id: submissionId,
        timestamp: submittedAt,
        slot: await this.connection.getSlot(),
        blockhash: this.currentBlockhash,
        signature: signatures[0] || '',
        bundleUuid: submission.uuid,
        stages: {
          submitted: submittedAt
        },
        tipAmount,
        tipAccount: tipAccount.toString()
      };

      this.activeBundles.set(submissionId, lifecycleEntry);
      logLifecycleEntry(lifecycleEntry);

      logger.info('Bundle submitted successfully', { 
        submissionId,
        signatures: signatures.length
      });

      return submission;
    } catch (error) {
      logger.error('Bundle submission failed', { 
        submissionId, 
        error 
      });
      throw error;
    }
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

  async subscribeToBundleResults(
    callback: (result: { uuid: string; finalized?: any; processed?: any; rejected?: any; dropped?: any }) => void,
    errorCallback?: (error: Error) => void
  ): Promise<() => void> {
    // For simplicity, we'll use polling to check transaction status
    const checkStatus = async () => {
      const activeEntries = this.getActiveBundles();
      for (const entry of activeEntries) {
        if (entry.stages.finalized || entry.failure) continue;
        
        try {
          const signature = entry.signature;
          const status = await this.connection.getSignatureStatus(signature, {
            searchTransactionHistory: true
          });

          if (status.value) {
            if (status.value.err) {
              // Transaction failed
              callback({
                uuid: entry.bundleUuid || entry.id,
                rejected: { reason: JSON.stringify(status.value.err) }
              });
            } else if (status.value.confirmationStatus === 'finalized') {
              entry.stages.finalized = new Date();
              callback({
                uuid: entry.bundleUuid || entry.id,
                finalized: { slot: status.value.slot, timestamp: new Date() }
              });
              logLifecycleEntry(entry);
            } else if (status.value.confirmationStatus === 'confirmed') {
              if (!entry.stages.confirmed) {
                entry.stages.confirmed = new Date();
                logLifecycleEntry(entry);
              }
              callback({
                uuid: entry.bundleUuid || entry.id,
                processed: { slot: status.value.slot, timestamp: new Date() }
              });
            }
          }
        } catch (error) {
          // Ignore errors during status check
        }
      }
    };

    const intervalId = setInterval(checkStatus, 2000);

    return () => clearInterval(intervalId);
  }

  async getConnectedLeaders(): Promise<any> {
    // This would normally use Jito API to get connected leaders
    return null;
  }

  async getNextScheduledLeader(): Promise<{ currentSlot: number; nextLeaderSlot: number; nextLeaderIdentity: string } | null> {
    try {
      const currentSlot = await this.connection.getSlot();
      // In production, you would fetch actual leader schedule
      // For now, return a mock response
      return {
        currentSlot,
        nextLeaderSlot: currentSlot + 4, // Leader changes every 4 slots
        nextLeaderIdentity: 'MockLeader123456789'
      };
    } catch (error) {
      logger.warn('Failed to get next scheduled leader', { error });
      return null;
    }
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