import fs from 'fs';
import path from 'path';
import { TransactionStack } from './core/transactionStack';
import { TransactionStackConfig, LifecycleEntry, FailureType } from './types';
import { logger, logLifecycleEntry } from './utils/logger';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';

interface DemoConfig {
  rpcUrl: string;
  blockEngineUrl: string;
  geyserUrl: string;
  geyserToken: string;
  authKeypairPath: string;
  tipperKeypairPath: string;
  network: 'mainnet' | 'devnet' | 'testnet';
  numTransactions: number;
  delayBetweenTx: number;
}

function loadConfig(): DemoConfig {
  return {
    rpcUrl: process.env.RPC_URL || 'https://api.devnet.solana.com',
    blockEngineUrl: process.env.BLOCK_ENGINE_URL || 'devnet.block-engine.jito.wtf',
    geyserUrl: process.env.GEYSER_URL || 'http://sg131.rpcpool.wg:10000',
    geyserToken: process.env.GEYSER_TOKEN || '',
    authKeypairPath: process.env.AUTH_KEYPAIR_PATH || './keys/auth_keypair.json',
    tipperKeypairPath: process.env.TIPPER_KEYPAIR_PATH || './keys/tipper_keypair.json',
    network: (process.env.NETWORK as 'mainnet' | 'devnet' | 'testnet') || 'devnet',
    numTransactions: parseInt(process.env.NUM_TRANSACTIONS || '10'),
    delayBetweenTx: parseInt(process.env.DELAY_BETWEEN_TX || '5000')
  };
}

function loadKeypair(filePath: string): Uint8Array {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      return new Uint8Array(parsed);
    }
    throw new Error('Invalid keypair format');
  } catch (error) {
    logger.error(`Failed to load keypair from ${filePath}`, { error });
    throw error;
  }
}

async function createSampleTransaction(
  payer: Keypair,
  blockhash: string,
  recipient?: PublicKey
): Promise<VersionedTransaction> {
  // Create a simple transfer instruction
  const recipientKey = recipient || Keypair.generate().publicKey;
  
  const transferIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: recipientKey,
    lamports: 1000 // 0.000001 SOL
  });

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [transferIx]
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);
  transaction.sign([payer]);

  return transaction;
}

async function simulateFailure(
  entry: LifecycleEntry,
  failureType: FailureType,
  message: string
): Promise<void> {
  entry.failure = {
    type: failureType,
    message,
    retryable: true
  };
  logLifecycleEntry(entry);
  logger.warn('Simulated failure', { entryId: entry.id, failureType, message });
}

async function runDemo() {
  logger.info('=== Solana Smart Transaction Stack Demo ===');
  
  const config = loadConfig();
  logger.info('Configuration loaded', { config });

  // Check for keypairs
  if (!fs.existsSync(config.authKeypairPath) || !fs.existsSync(config.tipperKeypairPath)) {
    logger.error('Keypair files not found. Please create them first.');
    logger.info('See README.md for instructions on generating keypairs.');
    
    // Create sample lifecycle log entries for demo purposes
    logger.info('Creating sample lifecycle log entries...');
    await createSampleLifecycleLog();
    return;
  }

  // Load keypairs
  const authKeypair = Keypair.fromSecretKey(loadKeypair(config.authKeypairPath));
  const tipperKeypair = Keypair.fromSecretKey(loadKeypair(config.tipperKeypairPath));

  logger.info('Keypairs loaded', {
    authPubkey: authKeypair.publicKey.toString(),
    tipperPubkey: tipperKeypair.publicKey.toString()
  });

  // Create transaction stack config
  const stackConfig: TransactionStackConfig = {
    rpcUrl: config.rpcUrl,
    blockEngineUrl: config.blockEngineUrl,
    geyserUrl: config.geyserUrl,
    geyserToken: config.geyserToken || undefined,
    authKeypairPath: config.authKeypairPath,
    tipperKeypairPath: config.tipperKeypairPath,
    network: config.network,
    maxRetries: 3,
    blockhashRefreshThreshold: 55000,
    targetCommitment: 'confirmed'
  };

  // Create and initialize transaction stack
  const stack = new TransactionStack(stackConfig);
  
  try {
    await stack.initialize(authKeypair, tipperKeypair);
    logger.info('Transaction stack initialized');

    await stack.start();
    logger.info('Transaction stack started');

    // Submit sample transactions
    logger.info(`Submitting ${config.numTransactions} transactions...`);
    
    for (let i = 0; i < config.numTransactions; i++) {
      try {
        // Create sample instructions (simple transfer)
        const instructions = [
          SystemProgram.transfer({
            fromPubkey: tipperKeypair.publicKey,
            toPubkey: Keypair.generate().publicKey,
            lamports: 1000
          })
        ];

        const entryId = await stack.submitTransaction(instructions, [tipperKeypair]);
        logger.info(`Transaction ${i + 1}/${config.numTransactions} submitted`, { entryId });

        // Simulate some failures (for demonstration)
        // In a real scenario, failures would come from actual bundle results
        if (i === 2) {
          // Simulate blockhash expiry on 3rd transaction
          const entries = (stack as any).lifecycleTracker?.getEntries();
          if (entries && entries.length > 0) {
            await simulateFailure(
              entries[entries.length - 1],
              FailureType.BLOCKHASH_EXPIRED,
              'Blockhash expired during processing'
            );
          }
        }

        if (i === 6) {
          // Simulate fee too low on 7th transaction
          const entries = (stack as any).lifecycleTracker?.getEntries();
          if (entries && entries.length > 0) {
            await simulateFailure(
              entries[entries.length - 1],
              FailureType.FEE_TOO_LOW,
              'Tip amount insufficient for priority'
            );
          }
        }

        // Get and display stats
        const stats = stack.getStats();
        logger.info('Current stats', stats);

        // Wait between transactions
        if (i < config.numTransactions - 1) {
          logger.info(`Waiting ${config.delayBetweenTx}ms before next transaction...`);
          await new Promise(resolve => setTimeout(resolve, config.delayBetweenTx));
        }

      } catch (error) {
        logger.error(`Error submitting transaction ${i + 1}`, { error });
      }
    }

    logger.info('All transactions submitted');

    // Wait a bit for confirmations
    logger.info('Waiting for confirmations...');
    await new Promise(resolve => setTimeout(resolve, 30000));

    // Display final stats
    const finalStats = stack.getStats();
    logger.info('=== Final Statistics ===', {
      total: finalStats.lifecycle.total,
      successful: finalStats.lifecycle.successful,
      failed: finalStats.lifecycle.failed,
      pending: finalStats.lifecycle.pending,
      averageLatency: `${(finalStats.lifecycle.averageLatency / 1000).toFixed(2)}s`
    });

    // Display agent reasoning
    logger.info('=== AI Agent Reasoning ===');
    logger.info(stack.getAgentReasoning());

  } catch (error) {
    logger.error('Demo failed', { error });
  } finally {
    await stack.stop();
    logger.info('Demo completed');
  }
}

async function createSampleLifecycleLog(): Promise<void> {
  // Create sample lifecycle entries for demonstration
  const sampleEntries: LifecycleEntry[] = [
    {
      id: uuidv4(),
      timestamp: new Date('2024-01-15T10:30:00.000Z'),
      slot: 180000000,
      blockhash: '5N5v1HQq5EFui4yaPRBAN8cF23KWdJWhvvTnNu97JEH8',
      signature: '3po7J8J4kP5xPQvNhqGkYfVJbJv7mN9pQsT4wX8cK9d',
      bundleUuid: 'bundle-001',
      stages: {
        submitted: new Date('2024-01-15T10:30:00.000Z'),
        processed: new Date('2024-01-15T10:30:01.234Z'),
        confirmed: new Date('2024-01-15T10:30:02.456Z'),
        finalized: new Date('2024-01-15T10:30:05.789Z')
      },
      tipAmount: 10000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY'
    },
    {
      id: uuidv4(),
      timestamp: new Date('2024-01-15T10:30:10.000Z'),
      slot: 180000001,
      blockhash: '7X8mN2kP4qL9fVJbJv7mN9pQsT4wX8cK9d',
      signature: '4qr8K9L5nQvNhqGkYfVJbJv7mN9pQsT4wX8cK9d',
      bundleUuid: 'bundle-002',
      stages: {
        submitted: new Date('2024-01-15T10:30:10.000Z'),
        processed: new Date('2024-01-15T10:30:11.567Z'),
        confirmed: new Date('2024-01-15T10:30:13.890Z'),
        finalized: new Date('2024-01-15T10:30:18.234Z')
      },
      tipAmount: 15000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY'
    },
    {
      id: uuidv4(),
      timestamp: new Date('2024-01-15T10:30:20.000Z'),
      slot: 180000002,
      blockhash: '9A2mP5kQ8nL7fTJbJv7mN9pQsT4wX8cK9d',
      signature: '5rs9L6nOqRvhqHkYfVJbJv7mN9pQsT4wX8cK9d',
      bundleUuid: 'bundle-003',
      stages: {
        submitted: new Date('2024-01-15T10:30:20.000Z'),
        processed: new Date('2024-01-15T10:30:21.123Z')
      },
      tipAmount: 12000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY',
      failure: {
        type: FailureType.BLOCKHASH_EXPIRED,
        message: 'Blockhash expired before transaction was processed',
        retryable: true
      }
    },
    {
      id: uuidv4(),
      timestamp: new Date('2024-01-15T10:30:30.000Z'),
      slot: 180000003,
      blockhash: '3B6nR8kT7mL5fVJbJv7mN9pQsT4wX8cK9d',
      signature: '6tu0L7nPrSvhqHkYfVJbJv7mN9pQsT4wX8cK9d',
      bundleUuid: 'bundle-004',
      stages: {
        submitted: new Date('2024-01-15T10:30:30.000Z'),
        processed: new Date('2024-01-15T10:30:31.456Z'),
        confirmed: new Date('2024-01-15T10:30:33.789Z'),
        finalized: new Date('2024-01-15T10:30:38.012Z')
      },
      tipAmount: 8000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY'
    },
    {
      id: uuidv4(),
      timestamp: new Date('2024-01-15T10:30:40.000Z'),
      slot: 180000004,
      blockhash: '6C9oR5kT9mL8fVJbJv7mN9pQsT4wX8cK9d',
      signature: '7uv1L8nQsTvhqHkYfVJbJv7mN9pQsT4wX8cK9d',
      bundleUuid: 'bundle-005',
      stages: {
        submitted: new Date('2024-01-15T10:30:40.000Z'),
        processed: new Date('2024-01-15T10:30:41.890Z'),
        confirmed: new Date('2024-01-15T10:30:44.234Z'),
        finalized: new Date('2024-01-15T10:30:49.567Z')
      },
      tipAmount: 20000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY'
    },
    {
      id: uuidv4(),
      timestamp: new Date('2024-01-15T10:30:50.000Z'),
      slot: 180000005,
      blockhash: '8D1pR6kU0mN9fVJbJv7mN9pQsT4wX8cK9d',
      signature: '8vw2L9nRuUvhqHkYfVJbJv7mN9pQsT4wX8cK9d',
      bundleUuid: 'bundle-006',
      stages: {
        submitted: new Date('2024-01-15T10:30:50.000Z')
      },
      tipAmount: 5000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY',
      failure: {
        type: FailureType.FEE_TOO_LOW,
        message: 'Tip amount insufficient for priority during high congestion',
        retryable: true
      }
    },
    {
      id: uuidv4(),
      timestamp: new Date('2024-01-15T10:31:00.000Z'),
      slot: 180000006,
      blockhash: '1E4qS7kV1mO0gVJbJv7mN9pQsT4wX8cK9d',
      signature: '9wx3L0nSvVvhqHkYfVJbJv7mN9pQsT4wX8cK9d',
      bundleUuid: 'bundle-007',
      stages: {
        submitted: new Date('2024-01-15T10:31:00.000Z'),
        processed: new Date('2024-01-15T10:31:01.234Z'),
        confirmed: new Date('2024-01-15T10:31:03.456Z'),
        finalized: new Date('2024-01-15T10:31:08.789Z')
      },
      tipAmount: 25000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY'
    },
    {
      id: uuidv4(),
      timestamp: new Date('2024-01-15T10:31:10.000Z'),
      slot: 180000007,
      blockhash: '4F7rT8kW2nP1hVJbJv7mN9pQsT4wX8cK9d',
      signature: '0xy4L1nTwVwhqHkYfVJbJv7mN9pQsT4wX8cK9d',
      bundleUuid: 'bundle-008',
      stages: {
        submitted: new Date('2024-01-15T10:31:10.000Z'),
        processed: new Date('2024-01-15T10:31:11.567Z'),
        confirmed: new Date('2024-01-15T10:31:14.890Z'),
        finalized: new Date('2024-01-15T10:31:20.123Z')
      },
      tipAmount: 18000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY'
    },
    {
      id: uuidv4(),
      timestamp: new Date('2024-01-15T10:31:20.000Z'),
      slot: 180000008,
      blockhash: '7J0uS9kX3nQ2iVJbJv7mN9pQsT4wX8cK9d',
      signature: '1yz5L2nUxVwhqHkYfVJbJv7mN9pQsT4wX8cK9d',
      bundleUuid: 'bundle-009',
      stages: {
        submitted: new Date('2024-01-15T10:31:20.000Z'),
        processed: new Date('2024-01-15T10:31:21.890Z'),
        confirmed: new Date('2024-01-15T10:31:25.234Z'),
        finalized: new Date('2024-01-15T10:31:31.567Z')
      },
      tipAmount: 15000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY'
    },
    {
      id: uuidv4(),
      timestamp: new Date('2024-01-15T10:31:30.000Z'),
      slot: 180000009,
      blockhash: '2A5vT0lY4nR3jVJbJv7mN9pQsT4wX8cK9d',
      signature: '2za6L3nVyVwhqHkYfVJbJv7mN9pQsT4wX8cK9d',
      bundleUuid: 'bundle-010',
      stages: {
        submitted: new Date('2024-01-15T10:31:30.000Z'),
        processed: new Date('2024-01-15T10:31:31.456Z'),
        confirmed: new Date('2024-01-15T10:31:34.789Z'),
        finalized: new Date('2024-01-15T10:31:41.012Z')
      },
      tipAmount: 22000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY'
    }
  ];

  // Log all sample entries
  for (const entry of sampleEntries) {
    logLifecycleEntry(entry);
  }

  logger.info(`Created ${sampleEntries.length} sample lifecycle log entries`);
  logger.info('Sample log includes:');
  logger.info(`  - 8 successful submissions (with full commitment progression)`);
  logger.info(`  - 2 failure cases:`);
  logger.info(`    - Entry 3: BLOCKHASH_EXPIRED (blockhash expired during processing)`);
  logger.info(`    - Entry 6: FEE_TOO_LOW (tip insufficient during congestion)`);
  
  // Calculate and display statistics
  const successful = sampleEntries.filter(e => e.stages.finalized && !e.failure);
  const failed = sampleEntries.filter(e => e.failure);
  
  // Calculate average latencies
  let totalProcessedToConfirmed = 0;
  let totalConfirmedToFinalized = 0;
  let latencyCount = 0;

  for (const entry of successful) {
    if (entry.stages.processed && entry.stages.confirmed) {
      totalProcessedToConfirmed += entry.stages.confirmed.getTime() - entry.stages.processed.getTime();
      latencyCount++;
    }
    if (entry.stages.confirmed && entry.stages.finalized) {
      totalConfirmedToFinalized += entry.stages.finalized.getTime() - entry.stages.confirmed.getTime();
    }
  }

  logger.info('=== Sample Statistics ===');
  logger.info(`Total submissions: ${sampleEntries.length}`);
  logger.info(`Successful: ${successful.length}`);
  logger.info(`Failed: ${failed.length}`);
  logger.info(`Average processed-to-confirmed delta: ${(totalProcessedToConfirmed / latencyCount).toFixed(2)}ms`);
  logger.info(`Average confirmed-to-finalized delta: ${(totalConfirmedToFinalized / latencyCount).toFixed(2)}ms`);
}

// Run demo or create sample log
const args = process.argv.slice(2);
if (args.includes('--sample')) {
  createSampleLifecycleLog().catch(console.error);
} else {
  runDemo().catch(console.error);
}

export { runDemo, createSampleLifecycleLog };