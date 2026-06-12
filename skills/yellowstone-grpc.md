# Yellowstone gRPC (Geyser Streaming)

## Overview

Yellowstone is a high-performance gRPC interface for Solana's Geyser plugin, maintained by Triton One. It provides real-time streaming of slots, blocks, transactions, and account updates with very low latency.

## Key Components

### Client Connection

```typescript
import Client, { CommitmentLevel } from '@triton-one/yellowstone-grpc';

const client = new Client(
  'https://api.rpcpool.com',
  'your-token',
  { grpcMaxDecodingMessageSize: 64 * 1024 * 1024 },
  { enabled: true, backoff: { initialIntervalMs: 100, multiplier: 2, maxRetries: 10 }, slotRetention: 250 }
);

await client.connect();
```

### Subscription Types

| Type | Description |
|------|-------------|
| `slots` | Real-time slot updates with commitment levels |
| `accounts` | Account data changes |
| `transactions` | Transaction notifications (pre-execution) |
| `transactionsStatus` | Transaction execution results |
| `blocks` | Complete block data |
| `blocksMeta` | Block metadata only |
| `entry` | Entry notifications |

## Commitment Levels

```typescript
enum CommitmentLevel {
  PROCESSED = 'processed',
  CONFIRMED = 'confirmed',
  FINALIZED = 'finalized'
}
```

- **PROCESSED**: Node's most recent processed block (can be rolled back)
- **CONFIRMED**: Super-majority vote (>2/3 of stake)
- **FINALIZED**: Maximum lockout, strongest confirmation

## Usage Examples

### Subscribe to Slots

```typescript
const stream = await client.subscribe({
  slots: { client: { filterByCommitment: false } },
  commitment: CommitmentLevel.CONFIRMED
});

stream.on('data', (data) => {
  if (data.slot) {
    console.log('Slot update:', data.slot.slot, 'status:', data.slot.status);
  }
});
```

### Subscribe to Transactions

```typescript
const stream = await client.subscribe({
  transactions: {
    client: {
      vote: false,
      failed: true,
      accountInclude: ['PublicKey1', 'PublicKey2'],
      accountExclude: [],
      accountRequired: []
    }
  },
  commitment: CommitmentLevel.PROCESSED
});

stream.on('data', (data) => {
  if (data.transaction) {
    const { slot, transaction } = data.transaction;
    const sig = Buffer.from(transaction.signature).toString('hex');
    console.log(`Transaction ${sig} in slot ${slot}`);
  }
});
```

### Subscribe to Accounts

```typescript
const stream = await client.subscribe({
  accounts: {
    client: {
      account: ['PublicKey1', 'PublicKey2'],
      owner: [],
      filters: []
    }
  }
});
```

### Auto-Reconnect

```typescript
const client = new Client(endpoint, token, {}, {
  enabled: true,
  backoff: {
    initialIntervalMs: 100,
    multiplier: 2,
    maxRetries: 10
  },
  slotRetention: 250
});

await client.connect();
const stream = await client.subscribe(request, { priority: 1 });
```

## Unary Methods

| Method | Description |
|--------|-------------|
| `ping(pingId)` | Keep connection alive |
| `getLatestBlockhash(commitment?)` | Get current blockhash and last valid height |
| `getBlockHeight(commitment?)` | Get current block height |
| `getSlot(commitment?)` | Get current slot |
| `isBlockhashValid(blockhash)` | Check if blockhash is still valid |
| `getVersion()` | Get server version info |
| `subscribeReplayInfo()` | Get first available slot |

## Endpoints

| Environment | URL | Token Required |
|-------------|-----|----------------|
| Mainnet (Public) | `http://sg131.rpcpool.wg:10000` | No |
| Mainnet (Premium) | `https://api.rpcpool.com` | Yes |
| Devnet (Public) | Check docs | No |

## Filters

### Account Filters

```typescript
{
  account: ['Pubkey1', 'Pubkey2'],  // Match specific accounts
  owner: ['ProgramId'],               // Match accounts owned by program
  filters: [
    { datasize: 165 },                // Match by data size
    { memcmp: { offset: 0, base58: 'data' } }  // Match by data prefix
  ]
}
```

### Transaction Filters

```typescript
{
  vote: false,           // Exclude vote transactions
  failed: true,          // Include failed transactions
  accountInclude: [],    // Match transactions with these accounts
  accountExclude: [],    // Exclude transactions with these accounts
  accountRequired: []    // Only match if all accounts present
}
```

## Reconnection Handling

The client supports automatic reconnection with configurable backoff:

```typescript
const reconnectOptions = {
  enabled: true,
  backoff: {
    initialIntervalMs: 100,   // Initial retry delay
    multiplier: 2,            // Delay multiplier on each retry
    maxRetries: 10            // Maximum retry attempts
  },
  slotRetention: 250          // Slots to keep for replay
};
```

## Ping/Pong for Load Balancers

Some load balancers close idle connections. Use the ping field:

```typescript
await client.subscribe({
  ping: { id: 'keep-alive' },
  // ... other subscriptions
});
```

The server sends pings every 15 seconds; reply with the same ping.

## Important Notes

1. **Slot Retention**: Configure how many slots to retain for replay after reconnection.
2. **Backpressure**: Handle stream data appropriately to avoid memory issues.
3. **Compression**: For large account sets, use cuckoo filter compression.
4. **Latency**: Processed commitment provides lowest latency but least finality.

## References

- GitHub: https://github.com/rpcpool/yellowstone-grpc
- Docs: https://docs.triton.one/project-yellowstone/dragons-mouth-grpc-subscriptions