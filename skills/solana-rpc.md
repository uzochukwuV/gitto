# Solana RPC API & Transaction Lifecycle

## Overview

Solana's RPC API provides methods for reading network state, sending transactions, and subscribing to real-time updates. Understanding the transaction lifecycle and commitment levels is critical for building reliable applications.

## Commitment Levels

| Level | Description | Use Case |
|-------|-------------|----------|
| `processed` | Most recent block processed by node | Lowest latency, can be rolled back |
| `confirmed` | >2/3 supermajority stake vote | Balance of latency/finality |
| `finalized` | Maximum lockout, strongest confirmation | Highest guarantee, highest latency |

## Key RPC Methods

### getLatestBlockhash

Get the most recent blockhash for transaction construction:

```typescript
import { Connection } from '@solana/web3.js';

const connection = new Connection('https://api.mainnet.solana.com', 'confirmed');

const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

// Use blockhash for transaction
// lastValidBlockHeight tells when blockhash expires
```

### sendTransaction

Submit a transaction to the network:

```typescript
const signature = await connection.sendTransaction(transaction, {
  skipPreflight: false,
  preflightCommitment: 'confirmed',
  maxRetries: 5
});
```

### getSignatureStatuses

Check transaction status:

```typescript
const statuses = await connection.getSignatureStatuses([sig1, sig2, sig3]);

for (const status of statuses.value) {
  if (status) {
    console.log('Slot:', status.slot);
    console.log('Confirmations:', status.confirmations);
    console.log('Error:', status.err);
  }
}
```

### isBlockhashValid

Check if a blockhash is still valid:

```typescript
const { valid, slot } = await connection.isBlockhashValid(blockhash, 'confirmed');
```

## Transaction Lifecycle

```
1. Transaction Created
   ↓
2. Blockhash Assigned (expires after ~150 slots / 1 minute)
   ↓
3. Transaction Sent to RPC / Jito
   ↓
4. Transaction Received by Leader (TPU)
   ↓
5. Transaction Processed (in block)
   ↓
6. Transaction Confirmed (>2/3 stake vote)
   ↓
7. Transaction Finalized (max lockout)
```

## Blockhash Expiration

- Blockhash validity: ~150 slots (~1 minute on mainnet)
- After `lastValidBlockHeight`, blockhash becomes invalid
- **CRITICAL**: Never use `finalized` commitment for time-sensitive transactions
  - Finalized blockhash may be too old when you submit
  - Use `processed` or `confirmed` for fresh blockhashes

## Failure Types

| Error | Cause | Solution |
|-------|-------|----------|
| `BlockhashNotFound` | Blockhash expired | Refresh blockhash and retry |
| `FeeTooLow` | Priority fee insufficient | Increase fee |
| `TooManyComputeUnits` | Compute limit exceeded | Optimize or increase limit |
| `AccountInUse` | Account already borrowed | Retry with different account |
| `InsufficientFunds` | Not enough SOL | Fund the wallet |

## Transaction Construction

```typescript
import {
  Connection,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram
} from '@solana/web3.js';

// Get fresh blockhash
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('processed');

// Create instruction
const transferIx = SystemProgram.transfer({
  fromPubkey: payer.publicKey,
  toPubkey: recipient,
  lamports: amount
});

// Create message
const message = new TransactionMessage({
  payerKey: payer.publicKey,
  recentBlockhash: blockhash,
  instructions: [transferIx]
}).compileToV0Message();

// Create and sign transaction
const transaction = new VersionedTransaction(message);
transaction.sign([payer]);

// Send
const signature = await connection.sendTransaction(transaction);
```

## Waiting for Confirmation

```typescript
// Poll for confirmation
const confirmation = await connection.confirmTransaction(signature, 'confirmed');

// With timeout
const confirmation = await connection.confirmTransaction(
  { signature, blockhash, lastValidBlockHeight },
  { commitment: 'confirmed', searchTransactionHistory: true }
);
```

## Slot-Based Timing

- Slot time: ~400ms on mainnet (varies with network conditions)
- Leader schedule: Validators assigned to slots
- Leader rotation: Every 4 slots (slot leader changes)
- Important: Submit during your target leader's slot for best results

## getSlot and getLeaderSchedule

```typescript
// Get current slot
const currentSlot = await connection.getSlot('confirmed');

// Get leader at specific slot
const leader = await connection.getSlotLeader(currentSlot);

// Get full leader schedule
const schedule = await connection.getLeaderSchedule();
```

## Best Practices

1. **Always use fresh blockhashes**: For time-sensitive operations, use `processed` commitment
2. **Monitor blockhash expiration**: Track `lastValidBlockHeight` and refresh proactively
3. **Handle retries**: Implement exponential backoff for failed submissions
4. **Track lifecycle**: Monitor processed → confirmed → finalized progression
5. **Use Versioned Transactions**: Required for Address Lookup Tables (ALT)

## Important Notes

1. **Never use finalized for blockhash**: It can be too old for timely submission
2. **Track slot numbers**: Cross-reference with explorers for verification
3. **Measure deltas**: `confirmed_at - processed_at` indicates network health
4. **Leader timing**: Submit during the leader window for best landing probability

## References

- RPC Docs: https://solana.com/docs/rpc
- Web3.js: https://solana-labs.github.io/solana-web3.js/