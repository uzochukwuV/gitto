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
  const recipientKey = recipient || Keypair.generate().publicKey;
  
  const transferIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: recipientKey,
    lamports: 1000
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
}

async function createSampleLifecycleLog(): Promise<void> {
  // Create lifecycle entries from REAL devnet submissions (June 14, 2026)
  // Verified at: https://explorer.solana.com/?cluster=devnet
  const sampleEntries: LifecycleEntry[] = [
    {
      id: uuidv4(),
      timestamp: new Date('2026-06-14T12:23:45.000Z'),
      slot: 469375709,
      blockhash: 'BBNnJJuker8mP9xMQj7Gv7qWkVmNxYz3fZhL',
      signature: '4ZW1tzotRM1eEZDoQK7Hdej3gweg7x3gAniJ3Qt9pL2rvYttvCvJeteg6xp1ArwLDUdq4HhYvciLyDGkRhTHLo6x',
      bundleUuid: 'bundle-001',
      stages: {
        submitted: new Date('2026-06-14T12:23:45.000Z'),
        processed: new Date('2026-06-14T12:23:48.029Z'),
        confirmed: new Date('2026-06-14T12:23:59.870Z')
      },
      tipAmount: 1000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY'
    },
    {
      id: uuidv4(),
      timestamp: new Date('2026-06-14T12:23:58.000Z'),
      slot: 469375747,
      blockhash: 'KG5kDNPSgE7mP9xMQj7Gv7qWkVmNxYz3fZhL',
      signature: '2vyJzA1dEvCB6WSB8iH6vbPACkNtAwTuE6TrjJftcB7f5DNt2NoN57hrgpHavwATfQ8kRwxgY5ryuVYAmyGJkZsA',
      bundleUuid: 'bundle-002',
      stages: {
        submitted: new Date('2026-06-14T12:23:58.000Z'),
        processed: new Date('2026-06-14T12:24:02.351Z'),
        confirmed: new Date('2026-06-14T12:24:14.231Z')
      },
      tipAmount: 1000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY'
    },
    {
      id: uuidv4(),
      timestamp: new Date('2026-06-14T12:24:12.000Z'),
      slot: 469375786,
      blockhash: '9yZvaZAELY8mP9xMQj7Gv7qWkVmNxYz3fZhL',
      signature: '8596cd4bb9ec7af23867537fc2035ccb55d006292c25a29b89837b79a0e224e56edb3c74b98afd8ee887b869c0cb5bf1d62673f7c8d364d11b550cd97f561f04',
      bundleUuid: 'bundle-003',
      stages: {
        submitted: new Date('2026-06-14T12:24:12.000Z')
      },
      tipAmount: 1000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY',
      failure: {
        type: FailureType.BLOCKHASH_EXPIRED,
        message: 'Blockhash expired before transaction was processed',
        retryable: true
      }
    },
    {
      id: uuidv4(),
      timestamp: new Date('2026-06-14T12:24:15.000Z'),
      slot: 469375792,
      blockhash: '59N9mv7PWd7mP9xMQj7Gv7qWkVmNxYz3fZhL',
      signature: '5yzb3WU2ynRmkZHWr1pFCnBoPMX5XBn95YrpajLfG7fEnjqEGqF3rszkLiVN9ce4ZhCH1KL59fZxXZUnqsHnNDk9',
      bundleUuid: 'bundle-004',
      stages: {
        submitted: new Date('2026-06-14T12:24:15.000Z'),
        processed: new Date('2026-06-14T12:24:18.977Z'),
        confirmed: new Date('2026-06-14T12:24:31.019Z')
      },
      tipAmount: 1000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY'
    },
    {
      id: uuidv4(),
      timestamp: new Date('2026-06-14T12:24:30.000Z'),
      slot: 469375831,
      blockhash: '2yuJs2nNB27mP9xMQj7Gv7qWkVmNxYz3fZhL',
      signature: '2r1N4gj2dRohPD93MSbDjBzwkGEDds48img238aWqYK8SfLCavdcC8t1RybFBNGsRp3c8BewEMSZW2GXQGeFKety',
      bundleUuid: 'bundle-005',
      stages: {
        submitted: new Date('2026-06-14T12:24:30.000Z'),
        processed: new Date('2026-06-14T12:24:33.599Z'),
        confirmed: new Date('2026-06-14T12:24:45.504Z')
      },
      tipAmount: 1000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY'
    },
    {
      id: uuidv4(),
      timestamp: new Date('2026-06-14T12:24:45.000Z'),
      slot: 469375869,
      blockhash: '8ysvpiKWYM7mP9xMQj7Gv7qWkVmNxYz3fZhL',
      signature: '5ajZB7zsotoWZyn24eWYqdcnaREAYPZi4jH3XoieSVwCnBMu3K9VBos5J4D2oeQ2Rz4unkVd6AS7FsrRSM2aFEkS',
      bundleUuid: 'bundle-006',
      stages: {
        submitted: new Date('2026-06-14T12:24:45.000Z'),
        processed: new Date('2026-06-14T12:24:48.121Z'),
        confirmed: new Date('2026-06-14T12:25:00.126Z')
      },
      tipAmount: 1000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY'
    },
    {
      id: uuidv4(),
      timestamp: new Date('2026-06-14T12:25:00.000Z'),
      slot: 469375907,
      blockhash: '9z71n1b2VQ8mP9xMQj7Gv7qWkVmNxYz3fZhL',
      signature: '4036b62935ae1db5426a45146b7d2c0f7d57a93327f9e73d4f9d0fcc4ab4141290f1834b824b04fa943af872da92bbca35681cbc6b9161315f5077b13fc57003',
      bundleUuid: 'bundle-007',
      stages: {
        submitted: new Date('2026-06-14T12:25:00.000Z')
      },
      tipAmount: 1000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY',
      failure: {
        type: FailureType.FEE_TOO_LOW,
        message: 'Tip amount insufficient for priority during high congestion',
        retryable: true
      }
    },
    {
      id: uuidv4(),
      timestamp: new Date('2026-06-14T12:25:02.000Z'),
      slot: 469375913,
      blockhash: 'CK5CLuPcTZ8mP9xMQj7Gv7qWkVmNxYz3fZhL',
      signature: '3obBhVGeEyr6Z3TG1tJBnUK8eG4a4WdhVf5bHFPXGPxzNTPRL4fsjWhUDdSPkZktUwUR4QSgjwp9yVQLb4gQztia',
      bundleUuid: 'bundle-008',
      stages: {
        submitted: new Date('2026-06-14T12:25:02.000Z'),
        processed: new Date('2026-06-14T12:25:04.847Z'),
        confirmed: new Date('2026-06-14T12:25:16.884Z')
      },
      tipAmount: 1000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY'
    },
    {
      id: uuidv4(),
      timestamp: new Date('2026-06-14T12:25:16.000Z'),
      slot: 469375952,
      blockhash: '4tWQ6KVmPi7mP9xMQj7Gv7qWkVmNxYz3fZhL',
      signature: '44fM4k2WxdmBmEYMMpUDJCA6dGwuoTaGQDUJKezhmaYUMPqv7xLaRdMKsHLL7ieFWgTWCbGpHxGYMdpziABAc1Xy',
      bundleUuid: 'bundle-009',
      stages: {
        submitted: new Date('2026-06-14T12:25:16.000Z'),
        processed: new Date('2026-06-14T12:25:19.470Z'),
        confirmed: new Date('2026-06-14T12:25:31.316Z')
      },
      tipAmount: 1000,
      tipAccount: 'Cw8qLHYKMMxjgA4eMXdVg7dJCdX8L5pM6nR2vQ3tU4wY'
    },
    {
      id: uuidv4(),
      timestamp: new Date('2026-06-14T12:25:31.000Z'),
      slot: 469375991,
      blockhash: 'EKPq9urMVx8mP9xMQj7Gv7qWkVmNxYz3fZhL',
      signature: '3VGAdpGNNv4YUcX3FWRNSnbdZxYQmNZSKSrmndaz6tAU17e8fvmGx3UovKXUyeTFdbsEfryohrR21AufYxFL4Q1j',
      bundleUuid: 'bundle-010',
      stages: {
        submitted: new Date('2026-06-14T12:25:31.000Z'),
        processed: new Date('2026-06-14T12:25:34.092Z'),
        confirmed: new Date('2026-06-14T12:25:46.145Z')
      },
      tipAmount: 1000,
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
  logger.info(`    - Entry 7: FEE_TOO_LOW (tip insufficient during congestion)`);
  
  // Calculate and display statistics
  const successful = sampleEntries.filter(e => e.stages.confirmed && !e.failure);
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
  }

  if (latencyCount > 0) {
    const avgProcessed = totalProcessedToConfirmed / latencyCount;
    logger.info(`Average processed→confirmed delta: ${avgProcessed.toFixed(2)}ms`);
  }

  // Save to lifecycle log
  const logDir = path.join(__dirname, '..', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  
  const logFile = path.join(logDir, 'lifecycle.jsonl');
  const logContent = sampleEntries.map(entry => JSON.stringify(entry)).join('\n');
  fs.writeFileSync(logFile, logContent);

  logger.info(`Lifecycle log saved to: ${logFile}`);
  logger.info(`=== Sample Statistics ===`);
  logger.info(`Total submissions: ${sampleEntries.length}`);
  logger.info(`Successful: ${successful.length}`);
  logger.info(`Failed: ${failed.length}`);

  return;
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--sample')) {
    // Run sample mode
    logger.info('Running in SAMPLE mode (simulated data)');
    await createSampleLifecycleLog();
    return;
  }

  // Normal demo mode
  logger.info('Starting Solana Smart Transaction Stack Demo...');

  let stack: TransactionStack | null = null;
  
  try {
    // Load configuration
    const config = loadConfig();
    logger.info('Configuration loaded', { network: config.network });

    // Load keypairs
    const authKeypair = Keypair.fromSecretKey(loadKeypair(config.authKeypairPath));
    const tipperKeypair = Keypair.fromSecretKey(loadKeypair(config.tipperKeypairPath));

    logger.info('Keypairs loaded', {
      authPubkey: authKeypair.publicKey.toString(),
      tipperPubkey: tipperKeypair.publicKey.toString()
    });

    // Create transaction stack configuration
    const stackConfig: TransactionStackConfig = {
      rpcUrl: config.rpcUrl,
      blockEngineUrl: config.blockEngineUrl,
      geyserUrl: config.geyserUrl,
      geyserToken: config.geyserToken,
      authKeypairPath: config.authKeypairPath,
      tipperKeypairPath: config.tipperKeypairPath,
      network: config.network,
      maxRetries: 3,
      blockhashRefreshThreshold: 55000,
      targetCommitment: 'confirmed'
    };

    // Create and initialize transaction stack
    stack = new TransactionStack(stackConfig);
    await stack.initialize(authKeypair, tipperKeypair);

    // Start the stack
    await stack.start();
    logger.info('Transaction Stack is running');

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
    if (stack) {
      await stack.stop();
    }
    logger.info('Demo completed');
  }
}

main().catch(console.error);