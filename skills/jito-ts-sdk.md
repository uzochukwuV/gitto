# Jito TypeScript SDK (jito-ts)

## Overview

The Jito TypeScript SDK (`jito-ts`) provides a client for interacting with Jito's block engine, enabling low-latency transaction sending through bundles. It supports gRPC communication for bundle submission, tip account queries, and leader information.

## Key Components

### SearcherClient

The main client for interacting with Jito's block engine:

```typescript
import { searcherClient, SearcherClient } from './sdk/block-engine/searcher';
import { Keypair } from '@solana/web3.js';

// Create a searcher client
const keypair = Keypair.fromSecretKey(new Uint8Array(/* ... */));
const client = searcherClient('mainnet.block-engine.jito.wtf', keypair);
```

### Bundle Class

Bundles are collections of transactions that execute atomically:

```typescript
import { Bundle } from './sdk/block-engine/types';
import { VersionedTransaction } from '@solana/web3.js';

const bundle = new Bundle([transaction1, transaction2], transactionLimit);
bundle.addTipTx(keypair, tipLamports, tipAccount, recentBlockhash);
```

### Main Methods

| Method | Description |
|--------|-------------|
| `sendBundle(bundle)` | Submit a bundle to the block engine, returns UUID |
| `getTipAccounts()` | Get list of tip accounts for MEV rewards |
| `getConnectedLeaders()` | Get connected validators with their slot ranges |
| `getNextScheduledLeader()` | Get next scheduled leader info |
| `onBundleResult(callback)` | Subscribe to bundle result notifications |

## Usage Examples

### Sending a Bundle

```typescript
// Get a recent blockhash
const { blockhash } = await connection.getLatestBlockhash('confirmed');

// Create tip transaction
const tipIx = SystemProgram.transfer({
  fromPubkey: keypair.publicKey,
  toPubkey: tipAccount,
  lamports: tipAmount,
});

const messageV0 = new TransactionMessage({
  payerKey: keypair.publicKey,
  recentBlockhash: blockhash,
  instructions: [tipIx],
}).compileToV0Message();

const tipTx = new VersionedTransaction(messageV0);
tipTx.sign([keypair]);

// Create and send bundle
const bundle = new Bundle([tipTx], 5);
const result = await client.sendBundle(bundle);

if (result.ok) {
  console.log('Bundle sent:', result.value); // UUID
} else {
  console.error('Failed:', result.error);
}
```

### Getting Tip Accounts

```typescript
const tipResult = await client.getTipAccounts();
if (tipResult.ok) {
  const tipAccounts = tipResult.value;
  // Use one of these accounts for MEV tips
}
```

### Listening for Bundle Results

```typescript
const cancelStream = client.onBundleResult(
  (bundleResult) => {
    if (bundleResult.finalized) {
      console.log('Bundle finalized:', bundleResult.finalized);
    } else if (bundleResult.rejected) {
      console.log('Bundle rejected:', bundleResult.rejected);
    } else if (bundleResult.processed) {
      console.log('Bundle processed:', bundleResult.processed);
    } else if (bundleResult.dropped) {
      console.log('Bundle dropped:', bundleResult.dropped);
    }
  },
  (error) => {
    console.error('Stream error:', error);
  }
);

// To cancel subscription
cancelStream();
```

## Endpoints

| Network | URL |
|---------|-----|
| Mainnet | `mainnet.block-engine.jito.wtf` |
| Mainnet (alt) | `frankfurt.mainnet.block-engine.jito.wtf` |
| Devnet | `devnet.block-engine.jito.wtf` |

## Error Handling

The SDK provides `SearcherClientError` with proper error classification:

- `UNAVAILABLE` - Service temporarily unavailable
- `RESOURCE_EXHAUSTED` - Rate limit exceeded
- `DEADLINE_EXCEEDED` - Request timeout
- `UNAUTHENTICATED` - Invalid auth credentials

## Environment Setup

```bash
export BLOCK_ENGINE_URL=mainnet.block-engine.jito.wtf
export RPC_URL=https://api.mainnet.solana.com
export AUTH_KEYPAIR_PATH=./auth_keypair.json
export BUNDLE_TRANSACTION_LIMIT=5
```

## Important Notes

1. **Bundle Atomicity**: All transactions in a bundle execute together. If any fails, all revert.
2. **Tip for Priority**: Include a tip transaction to incentivize validators to include your bundle.
3. **Leader Timing**: Submit bundles when the next scheduled leader is active for best results.
4. **Bundle Limits**: Default transaction limit is 5 per bundle.

## References

- GitHub: https://github.com/jito-labs/jito-ts
- Docs: https://docs.jito.wtf