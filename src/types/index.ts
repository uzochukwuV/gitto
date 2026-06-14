// Transaction lifecycle stages
export enum LifecycleStage {
  CREATED = 'created',
  SUBMITTED = 'submitted',
  PROCESSED = 'processed',
  CONFIRMED = 'confirmed',
  FINALIZED = 'finalized',
  FAILED = 'failed',
  EXPIRED = 'expired'
}

// Failure classification types
export enum FailureType {
  BLOCKHASH_EXPIRED = 'blockhash_expired',
  FEE_TOO_LOW = 'fee_too_low',
  COMPUTE_EXCEEDED = 'compute_exceeded',
  BUNDLE_REJECTED = 'bundle_rejected',
  BUNDLE_DROPPED = 'bundle_dropped',
  NETWORK_ERROR = 'network_error',
  TIMEOUT = 'timeout',
  UNKNOWN = 'unknown'
}

// Lifecycle log entry interface
export interface LifecycleEntry {
  id: string;
  timestamp: Date;
  slot: number;
  blockhash: string;
  signature: string;
  bundleUuid?: string;
  stages: {
    submitted?: Date;
    processed?: Date;
    confirmed?: Date;
    finalized?: Date;
  };
  tipAmount: number;
  tipAccount: string;
  failure?: {
    type: FailureType;
    message: string;
    retryable: boolean;
  };
  metadata?: Record<string, unknown>;
}

// Slot update from Yellowstone/Geyser
export interface SlotUpdate {
  slot: number;
  parent: number;
  status: 'confirmed' | 'processed' | 'rooted';
  timestamp: Date;
}

// Leader information
export interface LeaderInfo {
  identity: string;
  firstSlot: number;
  lastSlot: number;
  isConnected: boolean;
}

// Tip account data
export interface TipAccountData {
  account: string;
  recentTips: number[];
  averageTip: number;
  lastUpdated: Date;
}

// Bundle submission result
export interface BundleSubmission {
  uuid: string;
  submittedAt: Date;
  transactions: string[];
  tipAmount: number;
  tipAccount: string;
  blockhash: string;
}

// Bundle result from Jito
export interface BundleResult {
  uuid: string;
  finalized?: {
    slot: number;
    timestamp: Date;
  };
  processed?: {
    slot: number;
    timestamp: Date;
  };
  rejected?: {
    reason: string;
    slot?: number;
  };
  dropped?: {
    reason: string;
  };
}

// Network health metrics
export interface NetworkHealth {
  processedToConfirmedDelta: number;
  confirmedToFinalizedDelta: number;
  currentSlot: number;
  slotProduction: number;
  lastUpdated: Date;
}

// AI agent decision
export interface AgentDecision {
  type: 'submit' | 'wait' | 'retry' | 'adjust_tip' | 'refresh_blockhash';
  reason: string;
  confidence: number;
  action: {
    tipAmount?: number;
    blockhash?: string;
    retryCount?: number;
    waitSlots?: number;
  };
  timestamp: Date;
}

// Configuration for the transaction stack
export interface TransactionStackConfig {
  rpcUrl: string;
  blockEngineUrl: string;
  geyserUrl: string;
  geyserToken?: string;
  authKeypairPath: string;
  tipperKeypairPath: string;
  network: 'mainnet' | 'devnet' | 'testnet';
  maxRetries: number;
  blockhashRefreshThreshold: number;
  targetCommitment: 'processed' | 'confirmed' | 'finalized';
}

// Transaction to be submitted
export interface TransactionRequest {
  instructions: any[];
  signers: any[];
  priorityFee?: number;
  computeUnits?: number;
  metadata?: Record<string, unknown>;
}

// Connection status
export interface ConnectionStatus {
  rpc: boolean;
  blockEngine: boolean;
  geyser: boolean;
  lastHeartbeat: Date;
}

// State of the transaction stack
export interface TransactionStackState {
  status: 'idle' | 'running' | 'paused' | 'error';
  currentSlot: number;
  nextLeaderSlot?: number;
  nextLeaderIdentity?: string;
  pendingTransactions: number;
  activeBundles: number;
  lastError?: string;
}