import { AgentDecision, FailureType, LifecycleEntry, NetworkHealth, TipAccountData } from '../types';
import { logger } from '../utils/logger';

export interface AgentConfig {
  minTipAmount: number;
  maxTipAmount: number;
  defaultTipAmount: number;
  blockhashRefreshBeforeMs: number;
  maxRetryAttempts: number;
  decisionConfidenceThreshold: number;
}

export class TransactionAgent {
  private config: AgentConfig;
  private decisionHistory: AgentDecision[] = [];
  private failureHistory: { type: FailureType; count: number; lastSeen: Date }[] = [];
  private recentTips: number[] = [];
  private slotHistory: { slot: number; timestamp: Date }[] = [];

  constructor(config?: Partial<AgentConfig>) {
    this.config = {
      minTipAmount: 1000,           // 0.000001 SOL
      maxTipAmount: 1000000,       // 0.001 SOL
      defaultTipAmount: 10000,     // 0.00001 SOL
      blockhashRefreshBeforeMs: 55000, // 55 seconds (blockhash valid ~60s)
      maxRetryAttempts: 3,
      decisionConfidenceThreshold: 0.7,
      ...config
    };
  }

  /**
   * Main decision-making method - analyzes current state and makes a decision
   * with multi-step chain-of-thought reasoning
   */
  async makeDecision(context: {
    currentSlot: number;
    nextLeaderSlot?: number;
    nextLeaderIdentity?: string;
    blockhashAgeMs: number;
    recentFailures: FailureType[];
    networkHealth: NetworkHealth;
    pendingTxCount: number;
    targetSlot?: number;
    retryCount?: number;
  }): Promise<AgentDecision> {
    // Build step-by-step reasoning chain
    const reasoningChain: string[] = [];
    
    logger.info('Agent analyzing decision context', context);
    reasoningChain.push(`[Step 1] Current state: slot=${context.currentSlot}, blockhashAge=${context.blockhashAgeMs}ms, pending=${context.pendingTxCount}`);

    // Decision 1: Check if we should wait for a specific leader
    if (context.nextLeaderSlot && context.currentSlot < context.nextLeaderSlot - 5) {
      const waitSlots = context.nextLeaderSlot - context.currentSlot - 5;
      reasoningChain.push(`[Step 2] Leader analysis: Next leader at slot ${context.nextLeaderSlot} (in ${waitSlots} slots). Waiting optimizes landing probability.`);
      reasoningChain.push(`[Decision] WAIT - Position for leader window`);
      return this.createDecision(
        'wait',
        `Waiting for leader slot ${context.nextLeaderSlot} (current: ${context.currentSlot})`,
        0.9,
        { waitSlots },
        reasoningChain
      );
    }
    reasoningChain.push(`[Step 2] Leader analysis: Current or past leader window - proceeding`);

    // Decision 2: Check for blockhash expiration risk
    if (context.blockhashAgeMs > this.config.blockhashRefreshBeforeMs) {
      const riskLevel = context.blockhashAgeMs > 58000 ? 'HIGH' : 'MEDIUM';
      reasoningChain.push(`[Step 3] Blockhash age: ${context.blockhashAgeMs}ms (threshold: ${this.config.blockhashRefreshBeforeMs}ms) - Risk: ${riskLevel}`);
      reasoningChain.push(`[Decision] REFRESH_BLOCKHASH - Blockhash expiring soon, must refresh`);
      return this.createDecision(
        'refresh_blockhash',
        `Blockhash is ${context.blockhashAgeMs}ms old, approaching expiration`,
        0.95,
        {},
        reasoningChain
      );
    }
    reasoningChain.push(`[Step 3] Blockhash age: ${context.blockhashAgeMs}ms - Safe (within 55s threshold)`);

    // Decision 3: Check for recent failures
    if (context.recentFailures.length > 0) {
      reasoningChain.push(`[Step 4] Failure analysis: ${context.recentFailures.length} recent failures - ${context.recentFailures.join(', ')}`);
      const lastFailure = context.recentFailures[context.recentFailures.length - 1];
      const retryDecision = await this.analyzeFailureAndDecide(lastFailure, {
        retryCount: context.recentFailures.length,
        currentSlot: context.currentSlot,
        blockhashAgeMs: context.blockhashAgeMs
      });
      if (retryDecision) {
        reasoningChain.push(`[Decision] ${retryDecision.type.toUpperCase()} - Failure-adjusted action`);
        return { ...retryDecision, reasoning: reasoningChain };
      }
    } else {
      reasoningChain.push(`[Step 4] Failure analysis: No recent failures - clean slate`);
    }

    // Decision 4: Check network health
    if (context.networkHealth.processedToConfirmedDelta > 10000) {
      reasoningChain.push(`[Step 5] Network health: processed→confirmed delta ${context.networkHealth.processedToConfirmedDelta}ms (threshold: 10000ms) - DEGRADED`);
      reasoningChain.push(`[Decision] WAIT - Network under stress, reduce submission rate`);
      return this.createDecision(
        'wait',
        `Network health poor: ${context.networkHealth.processedToConfirmedDelta}ms processed-to-confirmed delta`,
        0.8,
        { waitSlots: 10 },
        reasoningChain
      );
    }
    const healthStatus = context.networkHealth.processedToConfirmedDelta > 5000 ? 'ELEVATED' : 'NORMAL';
    reasoningChain.push(`[Step 5] Network health: Delta ${context.networkHealth.processedToConfirmedDelta}ms - Status: ${healthStatus}`);

    // Decision 5: Adjust tip based on conditions
    const suggestedTip = await this.calculateOptimalTip(context);
    if (suggestedTip !== this.config.defaultTipAmount) {
      const tipAdjustment = ((suggestedTip - this.config.defaultTipAmount) / this.config.defaultTipAmount * 100).toFixed(0);
      reasoningChain.push(`[Step 6] Tip analysis: Base=${this.config.defaultTipAmount}, Suggested=${suggestedTip} (${Number(tipAdjustment) > 0 ? '+' : ''}${tipAdjustment}%)`);
      reasoningChain.push(`[Decision] ADJUST_TIP - Tip calibration for current conditions`);
      return this.createDecision(
        'adjust_tip',
        `Adjusted tip to ${suggestedTip} based on conditions`,
        0.75,
        { tipAmount: suggestedTip },
        reasoningChain
      );
    }
    reasoningChain.push(`[Step 6] Tip analysis: Current ${suggestedTip} lamports is optimal`);

    // Default: Submit
    reasoningChain.push(`[Final] All checks passed: Blockhash fresh, network healthy, no failures`);
    reasoningChain.push(`[Decision] SUBMIT - All conditions favorable`);
    
    return this.createDecision(
      'submit',
      'All conditions favorable for submission',
      0.85,
      {},
      reasoningChain
    );
  }

  /**
   * Analyzes a failure and decides on retry strategy
   */
  async analyzeFailureAndDecide(
    failureType: FailureType,
    context: {
      retryCount: number;
      currentSlot: number;
      blockhashAgeMs: number;
    }
  ): Promise<AgentDecision | null> {
    logger.info('Agent analyzing failure', { failureType, retryCount: context.retryCount });

    // Check if we've exceeded max retries
    if (context.retryCount >= this.config.maxRetryAttempts) {
      return this.createDecision(
        'wait',
        `Max retries (${this.config.maxRetryAttempts}) exceeded for ${failureType}`,
        0.9,
        { waitSlots: 50 }
      );
    }

    switch (failureType) {
      case FailureType.BLOCKHASH_EXPIRED:
        return this.createDecision(
          'refresh_blockhash',
          'Blockhash expired - refreshing before retry',
          0.95,
          { retryCount: context.retryCount + 1 }
        );

      case FailureType.FEE_TOO_LOW:
        return this.createDecision(
          'adjust_tip',
          'Fee too low - increasing tip for retry',
          0.9,
          { 
            tipAmount: Math.min(
              this.config.defaultTipAmount * 2,
              this.config.maxTipAmount
            ),
            retryCount: context.retryCount + 1
          }
        );

      case FailureType.COMPUTE_EXCEEDED:
        return this.createDecision(
          'submit',
          'Compute exceeded - reducing compute units for retry',
          0.85,
          { retryCount: context.retryCount + 1 }
        );

      case FailureType.BUNDLE_DROPPED:
      case FailureType.BUNDLE_REJECTED:
        return this.createDecision(
          'wait',
          'Bundle dropped/rejected - waiting for better conditions',
          0.8,
          { waitSlots: 5, retryCount: context.retryCount + 1 }
        );

      default:
        return this.createDecision(
          'retry',
          `Unknown failure ${failureType} - retrying with same parameters`,
          0.6,
          { retryCount: context.retryCount + 1 }
        );
    }
  }

  /**
   * Calculates the optimal tip based on network conditions
   */
  async calculateOptimalTip(context: {
    networkHealth: NetworkHealth;
    recentFailures: FailureType[];
    pendingTxCount: number;
    timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'night';
  }): Promise<number> {
    let baseTip = this.config.defaultTipAmount;

    // Adjust based on network health
    if (context.networkHealth.processedToConfirmedDelta > 5000) {
      baseTip *= 1.5; // Network congested, need higher tips
    } else if (context.networkHealth.processedToConfirmedDelta < 2000) {
      baseTip *= 0.8; // Network is fast, can use lower tips
    }

    // Adjust based on recent failures
    const feeFailures = context.recentFailures.filter(f => f === FailureType.FEE_TOO_LOW).length;
    if (feeFailures > 0) {
      baseTip *= (1 + feeFailures * 0.3); // Increase tip if we've had fee failures
    }

    // Adjust based on pending transactions
    if (context.pendingTxCount > 5) {
      baseTip *= 1.2; // More competition, need higher tips
    }

    // Adjust based on time of day (rough estimate of network activity)
    const hour = new Date().getHours();
    if (hour >= 14 && hour <= 20) {
      baseTip *= 1.3; // Peak trading hours
    } else if (hour >= 0 && hour <= 6) {
      baseTip *= 0.7; // Low activity period
    }

    // Ensure within bounds
    return Math.max(
      this.config.minTipAmount,
      Math.min(this.config.maxTipAmount, Math.floor(baseTip))
    );
  }

  /**
   * Learns from recent transactions to improve decisions
   */
  learnFromOutcome(entry: LifecycleEntry): void {
    // Record tip for future reference
    this.recentTips.push(entry.tipAmount);
    if (this.recentTips.length > 100) {
      this.recentTips.shift();
    }

    // Record failure if applicable
    if (entry.failure) {
      const existing = this.failureHistory.find(f => f.type === entry.failure!.type);
      if (existing) {
        existing.count++;
        existing.lastSeen = new Date();
      } else {
        this.failureHistory.push({
          type: entry.failure.type,
          count: 1,
          lastSeen: new Date()
        });
      }
    }

    // Record slot for leader analysis
    this.slotHistory.push({ slot: entry.slot, timestamp: new Date() });
    if (this.slotHistory.length > 1000) {
      this.slotHistory.shift();
    }

    logger.debug('Agent learned from outcome', { 
      entryId: entry.id,
      tip: entry.tipAmount,
      success: !!entry.stages.finalized,
      failureType: entry.failure?.type
    });
  }

  /**
   * Gets reasoning for the last decision
   */
  getLastDecisionReasoning(): string {
    const lastDecision = this.decisionHistory[this.decisionHistory.length - 1];
    if (!lastDecision) {
      return 'No decisions made yet';
    }

    let reasoning = `Decision: ${lastDecision.type.toUpperCase()}\n`;
    reasoning += `Reason: ${lastDecision.reason}\n`;
    reasoning += `Confidence: ${(lastDecision.confidence * 100).toFixed(1)}%\n`;
    reasoning += `Timestamp: ${lastDecision.timestamp.toISOString()}\n`;

    if (lastDecision.action.tipAmount) {
      reasoning += `Suggested tip: ${lastDecision.action.tipAmount}\n`;
    }
    if (lastDecision.action.waitSlots) {
      reasoning += `Wait slots: ${lastDecision.action.waitSlots}\n`;
    }
    if (lastDecision.action.retryCount !== undefined) {
      reasoning += `Retry count: ${lastDecision.action.retryCount}\n`;
    }

    return reasoning;
  }

  /**
   * Gets statistics about agent performance
   */
  getAgentStats(): {
    totalDecisions: number;
    decisionTypes: Record<string, number>;
    failureStats: { type: FailureType; count: number }[];
    averageTip: number;
    recentSuccessRate: number;
  } {
    const decisionTypes: Record<string, number> = {};
    this.decisionHistory.forEach(d => {
      decisionTypes[d.type] = (decisionTypes[d.type] || 0) + 1;
    });

    const avgTip = this.recentTips.length > 0
      ? this.recentTips.reduce((a, b) => a + b, 0) / this.recentTips.length
      : this.config.defaultTipAmount;

    return {
      totalDecisions: this.decisionHistory.length,
      decisionTypes,
      failureStats: this.failureHistory.map(f => ({ type: f.type, count: f.count })),
      averageTip: avgTip,
      recentSuccessRate: this.calculateRecentSuccessRate()
    };
  }

  private createDecision(
    type: AgentDecision['type'],
    reason: string,
    confidence: number,
    action: AgentDecision['action'],
    reasoningChain?: string[]
  ): AgentDecision {
    const decision: AgentDecision = {
      type,
      reason,
      confidence,
      action,
      reasoning: reasoningChain || [reason],
      timestamp: new Date()
    };

    this.decisionHistory.push(decision);
    
    // Keep decision history bounded
    if (this.decisionHistory.length > 1000) {
      this.decisionHistory.shift();
    }

    logger.info('Agent made decision', { type, reason, confidence, reasoning: decision.reasoning });

    return decision;
  }

  private calculateRecentSuccessRate(): number {
    const recentDecisions = this.decisionHistory.slice(-50);
    if (recentDecisions.length === 0) return 1.0;

    const submitDecisions = recentDecisions.filter(d => d.type === 'submit');
    if (submitDecisions.length === 0) return 1.0;

    // This is simplified - in production you'd track actual success/failure
    return submitDecisions.length / recentDecisions.length;
  }

  /**
   * Analyzes why a transaction failed and determines corrective action
   */
  analyzeFailure(entry: LifecycleEntry): {
    rootCause: string;
    correctiveAction: string;
    confidence: number;
  } {
    if (!entry.failure) {
      return {
        rootCause: 'No failure recorded',
        correctiveAction: 'No action needed',
        confidence: 1.0
      };
    }

    const failureType = entry.failure.type;
    const failureMessage = entry.failure.message;

    switch (failureType) {
      case FailureType.BLOCKHASH_EXPIRED:
        return {
          rootCause: 'Blockhash expired before transaction was processed',
          correctiveAction: 'Refresh blockhash and resubmit immediately. Consider reducing submission-to-processing time.',
          confidence: 0.95
        };

      case FailureType.FEE_TOO_LOW:
        return {
          rootCause: `Tip amount (${entry.tipAmount}) was insufficient to compete with other transactions`,
          correctiveAction: `Increase tip to at least ${Math.floor(entry.tipAmount * 1.5)}. Consider dynamic tip calculation.`,
          confidence: 0.9
        };

      case FailureType.COMPUTE_EXCEEDED:
        return {
          rootCause: 'Transaction exceeded compute unit limit',
          correctiveAction: 'Optimize transaction instructions or increase compute budget.',
          confidence: 0.85
        };

      case FailureType.BUNDLE_REJECTED:
        return {
          rootCause: 'Bundle was rejected by the Jito relayer',
          correctiveAction: 'Check bundle format and content. Ensure tip is included. Retry with adjusted parameters.',
          confidence: 0.8
        };

      case FailureType.BUNDLE_DROPPED:
        return {
          rootCause: 'Bundle was dropped after submission (possibly timing issue)',
          correctiveAction: 'Submit earlier in the leader window. Increase tip for priority.',
          confidence: 0.75
        };

      default:
        return {
          rootCause: `Unknown failure: ${failureMessage}`,
          correctiveAction: 'Review transaction parameters and retry.',
          confidence: 0.5
        };
    }
  }
}