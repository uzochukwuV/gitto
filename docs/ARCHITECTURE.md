# Solana Smart Transaction Stack - Architecture Document

## Overview

This document describes the architecture of the Solana Smart Transaction Infrastructure Stack, a production-ready system for intelligent transaction submission using Jito bundles, Yellowstone/Geyser streaming, and AI-assisted decision making.

## System Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         SOLANA SMART TRANSACTION STACK                      │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        External Services                             │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │   │
│  │  │   Solana    │  │    Jito     │  │ Yellowstone │  │   Solana    │ │   │
│  │  │    RPC      │  │Block Engine │  │    gRPC     │  │   Network   │ │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        Core Components                               │   │
│  │                                                                       │   │
│  │  ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐  │   │
│  │  │    Streaming     │   │      Bundle      │   │     Lifecycle    │  │   │
│  │  │     Manager      │   │      Manager     │   │      Tracker     │  │   │
│  │  │                  │   │                  │   │                  │  │   │
│  │  │ • Slot updates   │   │ • Jito SDK       │   │ • Stage tracking │  │   │
│  │  │ • Leader schedule│   │ • Bundle submit  │   │ • Failure detect │  │   │
│  │  │ • TX streaming   │   │ • Dynamic tips   │   │ • Network health│  │   │
│  │  │ • Auto-reconnect │   │ • Blockhash mgmt │   │ • Latency calc  │  │   │
│  │  └────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘  │   │
│  │           │                      │                      │           │   │
│  │           └──────────────────────┼──────────────────────┘           │   │
│  │                                  │                                   │   │
│  │                    ┌─────────────▼─────────────┐                   │   │
│  │                    │         AI Agent          │                   │   │
│  │                    │                           │                   │   │
│  │                    │ • Decision making         │                   │   │
│  │                    │ • Failure reasoning       │                   │   │
│  │                    │ • Tip intelligence        │                   │   │
│  │                    │ • Learning from outcomes  │                   │   │
│  │                    └───────────────────────────┘                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└────────────────────────────────────────────────────────────────────────────┘
```

## Components Detail

### 1. Streaming Manager

**Purpose**: Real-time monitoring of Solana network state via Yellowstone gRPC

**Responsibilities**:
- Connect to Yellowstone gRPC endpoint for real-time data
- Subscribe to slot updates with configurable commitment levels
- Monitor leader schedules and upcoming leaders
- Stream transaction notifications
- Handle auto-reconnection with exponential backoff

**Key Features**:
- Automatic reconnection with configurable backoff (initial: 100ms, max: 10 retries)
- Slot retention for replay after reconnection (default: 250 slots)
- Ping/pong keepalive for load balancer compatibility
- Backpressure handling for high-throughput scenarios

### 2. Bundle Manager

**Purpose**: Jito bundle construction, submission, and management

**Responsibilities**:
- Interact with Jito block engine via gRPC
- Construct bundles with multiple transactions
- Calculate dynamic tip amounts based on network conditions
- Manage blockhash lifecycle and refresh
- Subscribe to bundle results (finalized/processed/rejected/dropped)

### 3. Lifecycle Tracker

**Purpose**: Track transactions through all commitment stages and detect failures

**Lifecycle Stages**:
1. SUBMITTED - Bundle sent to Jito
2. PROCESSED - Included in a block
3. CONFIRMED - >2/3 supermajority stake vote
4. FINALIZED - Maximum lockout reached
5. FAILED - Transaction failed (with classification)

### 4. AI Agent

**Purpose**: Autonomous decision making for transaction submission strategy

**Decision Types**:
- submit - All conditions favorable, proceed with submission
- wait - Network conditions unfavorable, wait for better slot
- retry - Retry failed transaction with same parameters
- refresh_blockhash - Blockhash is stale, refresh before next action
- adjust_tip - Adjust tip amount based on network conditions

## Data Flow

### Transaction Submission Flow

1. User calls submitTransaction(instructions, signers)
2. AI Agent analyzes current conditions
3. If decision = 'wait' -> wait for specified slots
   If decision = 'refresh_blockhash' -> get fresh blockhash
4. Create VersionedTransaction with fresh blockhash
5. Calculate optimal tip amount (AI agent)
6. BundleManager.submitBundle() - Add tip transaction, send to Jito
7. Create LifecycleEntry
8. Subscribe to bundle result
9. On result: update lifecycle entry

### Slot Update Flow

1. Yellowstone streams slot update
2. StreamingManager receives and parses
3. Update TransactionStack state (currentSlot)
4. Notify registered callbacks
5. AI Agent uses slot info for timing decisions

## Infrastructure Decisions

### Why These Technologies?

**Jito Bundles**:
- Provides MEV protection and priority processing
- Atomic execution (all-or-nothing)
- Tip-based incentive mechanism
- Direct connection to validators for fast landing

**Yellowstone gRPC**:
- Real-time slot and transaction streaming
- Low latency (sub-second)
- Auto-reconnection support
- Compression support for large account sets

**TypeScript/Node.js**:
- Native gRPC support
- Fast iteration and development
- Strong typing for complex financial systems

## Failure Handling Strategy

| Failure | Detection | Recovery Action |
|---------|-----------|-----------------|
| Blockhash Expiry | isBlockhashValid() returns false | Refresh blockhash, retry |
| Fee Too Low | Bundle rejected with fee error | Increase tip, retry |
| Network Error | gRPC connection failure | Auto-reconnect, retry |
| Leader Skip | No confirmation within timeout | Wait for next leader, retry |
| Bundle Dropped | Bundle result = dropped | Wait briefly, resubmit |

## AI Agent Responsibilities

### Decision Criteria

**Submit When**:
- Blockhash is fresh (< 45 seconds old)
- Next leader is within 5 slots
- Network health delta < 2000ms
- No recent fee failures

**Wait When**:
- Blockhash approaching expiry (> 50 seconds)
- Network health poor (> 3000ms processed-to-confirmed)
- Recent failures (avoid compounding failures)
- Next leader > 10 slots away

**Adjust Tip When**:
- Recent fee failures (increase by 30-50%)
- High pending transaction count (increase by 20%)
- Peak hours (14:00-20:00 UTC, increase by 30%)

## Security Considerations

- Keypairs stored in local files with restricted permissions
- Never log or expose private keys
- Use separate keys for auth and tipping
- Respect Jito rate limits

## Monitoring & Observability

### Key Metrics
- Transaction success rate
- Average confirmation latency
- Blockhash refresh frequency
- AI agent decision distribution
- Failure type distribution

### Logging
- Structured JSON logging
- Log levels: error, warn, info, debug
- Separate logs for lifecycle events
- Error stack traces for debugging

## Conclusion

This architecture provides a robust, production-ready foundation for Solana transaction infrastructure. The separation of concerns between streaming, bundling, tracking, and AI decision-making allows for independent scaling and testing of each component.