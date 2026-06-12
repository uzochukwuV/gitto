import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { StreamingManager } from '../streaming/manager';
import { BundleManager } from '../bundles/manager';
import { LifecycleTracker } from '../lifecycle/tracker';
import { TransactionAgent } from '../ai/agent';
import { 
  TransactionStackConfig, 
  TransactionStackState, 
  LifecycleEntry, 
  SlotUpdate,
  FailureType,
  AgentDecision
} from '../types';
import { logger } from '../utils/logger';

export class TransactionStack {
  private config: TransactionStackConfig;
  private connection: Connection;
  private streamingManager: StreamingManager;
  private bundleManager: BundleManager;
  private lifecycleTracker: LifecycleTracker;
  private agent: TransactionAgent;
  private state: TransactionStackState;
  private isRunning: boolean = false;
  private decisionInterval: NodeJS.Timeout | null = null;

  constructor(config: TransactionStackConfig) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, config.targetCommitment);
    
    this.state = {
      status: 'idle',
      currentSlot: 0,
      pendingTransactions: 0,
      activeBundles: 0
    };

    // Initialize components
    this.streamingManager = new StreamingManager({
      rpcUrl: config.rpcUrl,
      commitment: config.targetCommitment
    });

    // Agent will be initialized after bundle manager
    this.agent = new TransactionAgent();
    this.lifecycleTracker = new LifecycleTracker({
      connection: this.connection,
      checkIntervalMs: 2000
    });
    this.bundleManager = {} as BundleManager;
  }

  async initialize(
    authKeypair: Keypair, 
    tipperKeypair: Keypair
  ): Promise<void> {
    logger.info('Initializing TransactionStack...', { config: this.config });

    try {
      // Initialize bundle manager
      this.bundleManager = new BundleManager({
        connection: this.connection,
        blockEngineUrl: this.config.blockEngineUrl,
        authKeypair,
        tipperKeypair,
        transactionLimit: 5
      });
      await this.bundleManager.initialize();

      // Connect to streaming
      await this.streamingManager.connect();

      // Subscribe to slot updates
      await this.streamingManager.subscribeToSlots(this.config.targetCommitment);

      // Set up slot callback to update state
      this.streamingManager.onSlotUpdate((update: SlotUpdate) => {
        this.state.currentSlot = update.slot;
        logger.debug('Slot update', { slot: update.slot, status: update.status });
      });

      // Start lifecycle tracker
      await this.lifecycleTracker.start();

      // Subscribe to bundle results
      this.bundleManager.subscribeToBundleResults(
        (result) => this.handleBundleResult(result),
        (error) => logger.error('Bundle result error', { error })
      );

      this.state.status = 'idle';
      logger.info('TransactionStack initialized successfully');
    } catch (error) {
      this.state.status = 'error';
      this.state.lastError = (error as Error).message;
      logger.error('Failed to initialize TransactionStack', { error });
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('TransactionStack already running');
      return;
    }

    logger.info('Starting TransactionStack...');
    this.isRunning = true;
    this.state.status = 'running';

    // Start decision loop
    this.decisionInterval = setInterval(
      () => this.runDecisionCycle(),
      1000 // Run every second
    );

    logger.info('TransactionStack started');
  }

  async stop(): Promise<void> {
    logger.info('Stopping TransactionStack...');
    this.isRunning = false;
    this.state.status = 'idle';

    if (this.decisionInterval) {
      clearInterval(this.decisionInterval);
      this.decisionInterval = null;
    }

    await this.streamingManager.disconnect();
    this.lifecycleTracker.stop();

    logger.info('TransactionStack stopped');
  }

  async submitTransaction(
    instructions: any[],
    signers: Keypair[],
    options?: {
      priorityFee?: number;
      computeUnits?: number;
      targetSlot?: number;
    }
  ): Promise<string> {
    logger.info('Submitting transaction', { 
      instructionCount: instructions.length,
      targetSlot: options?.targetSlot 
    });

    // Get fresh blockhash
    const blockhash = await this.bundleManager.refreshBlockhash('processed');
    
    // Create versioned transaction
    const { TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
    
    const message = new TransactionMessage({
      payerKey: signers[0].publicKey,
      recentBlockhash: blockhash,
      instructions
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);
    transaction.sign(signers);

    // Get decision from agent
    const decision = await this.agent.makeDecision({
      currentSlot: this.state.currentSlot,
      nextLeaderSlot: this.state.nextLeaderSlot,
      blockhashAgeMs: Date.now() - this.bundleManager.getBlockhashInfo().lastUpdated.getTime(),
      recentFailures: this.getRecentFailureTypes(),
      networkHealth: this.lifecycleTracker.calculateNetworkHealth(),
      pendingTxCount: this.state.pendingTransactions,
      targetSlot: options?.targetSlot
    });

    logger.info('Agent decision', { 
      type: decision.type,
      reason: decision.reason,
      confidence: decision.confidence
    });

    // Execute agent decision
    if (decision.type === 'wait' && decision.action.waitSlots) {
      logger.info('Agent decided to wait', { waitSlots: decision.action.waitSlots });
      // In a real implementation, you'd queue the transaction and wait
      // For this demo, we'll just wait a bit
      await new Promise(resolve => setTimeout(resolve, decision.action.waitSlots! * 400));
    }

    if (decision.type === 'refresh_blockhash') {
      logger.info('Agent decided to refresh blockhash');
      await this.bundleManager.refreshBlockhash('processed');
    }

    // Calculate tip based on agent decision
    const tipAmount = decision.action.tipAmount || await this.agent.calculateOptimalTip({
      networkHealth: this.lifecycleTracker.calculateNetworkHealth(),
      recentFailures: this.getRecentFailureTypes(),
      pendingTxCount: this.state.pendingTransactions
    });

    // Submit bundle
    const submission = await this.bundleManager.submitBundle(
      [transaction],
      tipAmount
    );

    // Create lifecycle entry
    const entry = this.lifecycleTracker.createEntry(
      submission.transactions[0],
      submission.blockhash,
      this.state.currentSlot,
      tipAmount,
      submission.tipAccount
    );

    this.state.pendingTransactions++;
    this.state.activeBundles++;

    logger.info('Transaction submitted', { 
      entryId: entry.id,
      bundleUuid: submission.uuid,
      tipAmount 
    });

    return entry.id;
  }

  private async runDecisionCycle(): Promise<void> {
    if (!this.isRunning) return;

    try {
      // Get leader info
      const leaderInfo = await this.bundleManager.getNextScheduledLeader();
      if (leaderInfo) {
        this.state.nextLeaderSlot = leaderInfo.nextLeaderSlot;
        this.state.nextLeaderIdentity = leaderInfo.nextLeaderIdentity;
      }

      // Get network health
      const networkHealth = this.lifecycleTracker.calculateNetworkHealth();
      
      // Make decision
      const decision = await this.agent.makeDecision({
        currentSlot: this.state.currentSlot,
        nextLeaderSlot: this.state.nextLeaderSlot,
        nextLeaderIdentity: this.state.nextLeaderIdentity,
        blockhashAgeMs: Date.now() - this.bundleManager.getBlockhashInfo().lastUpdated.getTime(),
        recentFailures: this.getRecentFailureTypes(),
        networkHealth,
        pendingTxCount: this.state.pendingTransactions
      });

      // Log decision for visibility
      if (decision.type !== 'submit') {
        logger.info('Agent decision cycle', { 
          type: decision.type,
          reason: decision.reason,
          confidence: decision.confidence
        });
      }

      // Execute decision
      await this.executeDecision(decision);

    } catch (error) {
      logger.error('Error in decision cycle', { error });
    }
  }

  private async executeDecision(decision: AgentDecision): Promise<void> {
    switch (decision.type) {
      case 'refresh_blockhash':
        await this.bundleManager.refreshBlockhash('processed');
        break;

      case 'wait':
        if (decision.action.waitSlots) {
          // Wait for specified slots
          const targetSlot = this.state.currentSlot + decision.action.waitSlots;
          while (this.state.currentSlot < targetSlot && this.isRunning) {
            await new Promise(resolve => setTimeout(resolve, 400));
          }
        }
        break;

      case 'adjust_tip':
        // This would affect future submissions
        logger.debug('Tip adjustment decision', { tipAmount: decision.action.tipAmount });
        break;

      default:
        // 'submit' - no action needed
        break;
    }
  }

  private async handleBundleResult(result: any): Promise<void> {
    logger.info('Bundle result received', { result });

    this.state.activeBundles = Math.max(0, this.state.activeBundles - 1);

    if (result.finalized) {
      logger.info('Bundle finalized', { 
        uuid: result.uuid,
        slot: result.finalized.slot 
      });
    } else if (result.processed) {
      logger.info('Bundle processed', { 
        uuid: result.uuid,
        slot: result.processed.slot 
      });
    } else if (result.rejected) {
      logger.warn('Bundle rejected', { 
        uuid: result.uuid,
        reason: result.rejected.reason 
      });
      
      // Trigger agent to analyze failure
      await this.handleFailure(result.uuid, FailureType.BUNDLE_REJECTED, result.rejected.reason);
    } else if (result.dropped) {
      logger.warn('Bundle dropped', { 
        uuid: result.uuid,
        reason: result.dropped.reason 
      });
      
      await this.handleFailure(result.uuid, FailureType.BUNDLE_DROPPED, result.dropped.reason);
    }
  }

  private async handleFailure(
    bundleUuid: string, 
    failureType: FailureType, 
    message: string
  ): Promise<void> {
    // Find the entry
    const entries = this.lifecycleTracker.getEntries();
    const entry = entries.find(e => e.bundleUuid === bundleUuid);

    if (entry) {
      // Analyze failure with agent
      const analysis = this.agent.analyzeFailure(entry);
      logger.info('Agent failure analysis', analysis);

      // Mark as failed
      this.lifecycleTracker.markEntryFailed(entry.id, failureType, message, true);

      // Learn from failure
      this.agent.learnFromOutcome(entry);

      // If retryable, the agent will decide on next action
      if (entry.failure?.retryable) {
        // Agent will handle retry decision in next cycle
        logger.info('Failure marked for agent retry decision', { entryId: entry.id });
      }
    }
  }

  private getRecentFailureTypes(): FailureType[] {
    return this.lifecycleTracker.getFailedEntries()
      .slice(-5) // Last 5 failures
      .map(e => e.failure?.type || FailureType.UNKNOWN);
  }

  getState(): TransactionStackState {
    return {
      ...this.state,
      pendingTransactions: this.state.pendingTransactions,
      activeBundles: this.state.activeBundles
    };
  }

  getStats(): {
    stack: TransactionStackState;
    lifecycle: {
      total: number;
      successful: number;
      failed: number;
      pending: number;
      averageLatency: number;
    };
    agent: {
      totalDecisions: number;
      decisionTypes: Record<string, number>;
      failureStats: { type: FailureType; count: number }[];
      averageTip: number;
      recentSuccessRate: number;
    };
    bundleManager: {
      activeBundles: number;
      currentBlockhash: string;
    };
  } {
    return {
      stack: this.getState(),
      lifecycle: this.lifecycleTracker.getStats(),
      agent: this.agent.getAgentStats(),
      bundleManager: {
        activeBundles: this.bundleManager.getActiveBundles().length,
        currentBlockhash: this.bundleManager.getCurrentBlockhash().substring(0, 10) + '...'
      }
    };
  }

  getAgentReasoning(): string {
    return this.agent.getLastDecisionReasoning();
  }
}