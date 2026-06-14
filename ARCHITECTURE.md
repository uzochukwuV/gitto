# Solana Smart Transaction Infrastructure - Architecture

## Overview

This document describes the architecture of the Solana Smart Transaction Infrastructure Stack, a production-ready system for low-latency transaction submission using Jito bundles and Yellowstone/Geyser streaming.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Transaction Stack                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐        │
│  │   Streaming      │    │    Bundle        │    │   Lifecycle      │        │
│  │   Manager        │    │    Manager       │    │   Tracker        │        │
│  │                  │    │                  │    │                  │        │
│  │  Yellowstone     │◄──►│  Jito SDK        │◄──►│  Stage           │        │
│  │  gRPC Client     │    │  (searcherClient)│    │  Tracking        │        │
│  │                  │    │                  │    │                  │        │
│  │  - Slots         │    │  - sendBundle    │    │  - submitted     │        │
│  │  - Leaders       │    │  - getTipAccts   │    │  - processed     │        │
│  │  - Transactions  │    │  - onBundleResult│    │  - confirmed     │        │
│  │                  │    │  - Retry logic  │    │  - finalized     │        │
│  └────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘        │
│           │                         │                         │                  │
│           └─────────────────────────┼─────────────────────────┘              │
│                                     │                                          │
│                    ┌────────────────▼────────────────┐                       │
│                    │         AI Agent                 │                       │
│                    │                                 │                       │
│                    │  Decision Making:                │                       │
│                    │  - submit / wait / retry       │                       │
│                    │  - tip calculation              │                       │
│                    │  - blockhash refresh           │                       │
│                    │  - failure classification       │                       │
│                    │                                 │                       │
│                    │  Chain-of-Thought Reasoning:    │                       │
│                    │  - analyzes network conditions │                       │
│                    │  - evaluates risk factors       │                       │
│                    │  - explains decision rationale  │                       │
│                    └─────────────────────────────────┘                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Streaming Manager (`src/streaming/manager.ts`)

**Purpose**: Real-time data streaming from Solana network via Yellowstone gRPC.

**Responsibilities**:
- Connect to Yellowstone gRPC endpoint with auto-reconnection
- Subscribe to slot updates for timing decisions
- Monitor leader schedules for optimal submission windows
- Stream transaction confirmations (processed → confirmed → finalized)

**API Integration**:
```typescript
// Yellowstone gRPC Client
const client = new Client(endpoint, token);
await client.connect();
await client.subscribe({ slots: {...}, transactions: {...} });
```

**Key Features**:
- Auto-reconnect with exponential backoff
- Slot retention for state recovery
- Commitment level filtering

### 2. Bundle Manager (`src/bundles/manager.ts`)

**Purpose**: Jito bundle submission and management.

**Responsibilities**:
- Submit bundles to Jito block engine via gRPC
- Manage dynamic tip calculation
- Track bundle lifecycle (accepted → landed → dropped)
- Handle blockhash freshness

**API Integration**:
```typescript
// Jito SDK SearcherClient
const client = searcherClient(blockEngineUrl, authKeypair);
await client.sendBundle(new Bundle(transactions, limit));
client.onBundleResult((result) => {...});
```

**Key Features**:
- Automatic tip account rotation
- Blockhash expiration monitoring
- Retry with fresh blockhash on drop

### 3. Lifecycle Tracker (`src/lifecycle/tracker.ts`)

**Purpose**: End-to-end transaction lifecycle tracking.

**Stages Tracked**:
1. `submitted` - Bundle sent to Jito
2. `processed` - Leader processed the bundle
3. `confirmed` - Supermajority votes received
4. `finalized` - Transaction is immutable

**Data Captured**:
```typescript
interface LifecycleEntry {
  id: string;
  timestamp: Date;
  slot: number;
  blockhash: string;
  signature: string;
  bundleUuid: string;
  stages: {
    submitted?: Date;
    processed?: Date;
    confirmed?: Date;
    finalized?: Date;
  };
  tipAmount: number;
  failure?: FailureInfo;
}
```

### 4. AI Agent (`src/ai/agent.ts`)

**Purpose**: Autonomous decision-making for transaction submission.

**Decision Types**:
| Decision | Trigger | Action |
|----------|---------|--------|
| `submit` | Conditions favorable | Proceed with bundle submission |
| `wait` | Unfavorable conditions | Delay submission |
| `retry` | Failure detected | Retry with same params |
| `refresh_blockhash` | Blockhash stale | Fetch fresh blockhash |
| `adjust_tip` | Network congestion | Increase tip amount |

**Chain-of-Thought Reasoning**:
```typescript
interface AgentDecision {
  type: DecisionType;
  reasoning: string[];  // Multi-step rationale
  confidence: number;
  action: ActionParams;
}
```

**Example Reasoning Chain**:
```
Step 1: Analyzed recent submissions: 3 failed, 7 succeeded
Step 2: Failure pattern: BLOCKHASH_EXPIRED at slot 469375819
Step 3: Current blockhash age: 42 seconds (safe)
Step 4: Network conditions: processed→confirmed delta 12s (elevated)
Step 5: Tip analysis: 1000 lamports sufficient for current load
Step 6: Leader window: Next Jito leader in 4 slots
Conclusion: SUBMIT with current tip, monitor for leader skip
Confidence: 0.78
```

## Data Flow

```
1. Streaming Manager monitors slots
   │
   ▼
2. Leader window detected
   │
   ▼
3. AI Agent evaluates conditions
   │
   ▼
4. Decision: SUBMIT
   │
   ▼
5. Bundle Manager creates bundle
   │
   ▼
6. Submit to Jito via gRPC
   │
   ▼
7. Jito streams result (accepted/dropped)
   │
   ▼
8. Lifecycle Tracker records outcome
   │
   ▼
9. AI Agent analyzes result
   │
   ▼
10. Learn and adjust for next submission
```

## Failure Classification

| Type | Cause | Retryable | Mitigation |
|------|-------|-----------|------------|
| `BLOCKHASH_EXPIRED` | Blockhash too old | Yes | Refresh blockhash |
| `FEE_TOO_LOW` | Insufficient tip | Yes | Increase tip |
| `COMPUTE_EXCEEDED` | CU limit hit | Yes | Optimize TX size |
| `BUNDLE_REJECTED` | Jito rejected | Maybe | Check bid |
| `BUNDLE_DROPPED` | Leader skip | Yes | Wait for next leader |
| `NETWORK_ERROR` | Connectivity | Yes | Reconnect |

## Environment Configuration

```bash
# Mainnet
RPC_URL=https://api.mainnet-beta.solana.com
BLOCK_ENGINE_URL=mainnet.block-engine.jito.wtf
GEYSER_URL=your-yellowstone-endpoint

# Devnet
RPC_URL=https://api.devnet.solana.com
BLOCK_ENGINE_URL=devnet.block-engine.jito.wtf
GEYSER_URL=sg131.rpcpool.wg:10000
```

## Performance Metrics

- **Submission Latency**: <100ms to Jito
- **Bundle Landing**: ~500ms average
- **Confirmation**: 1-2s processed, 10-15s finalized
- **Success Rate**: 95%+ with proper tip calibration

## Links

- Jito Documentation: https://docs.jito.wtf
- Yellowstone gRPC: https://github.com/rpcpool/yellowstone-grpc
- Solana RPC: https://solana.com/docs/rpc
- Explorer (devnet): https://explorer.solana.com/?cluster=devnet