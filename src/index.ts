import fs from 'fs';
import path from 'path';
import { TransactionStack } from './core/transactionStack';
import { TransactionStackConfig } from './types';
import { logger } from './utils/logger';

// Load environment variables
require('dotenv').config();

interface Config {
  rpcUrl: string;
  blockEngineUrl: string;
  geyserUrl: string;
  geyserToken: string;
  authKeypairPath: string;
  tipperKeypairPath: string;
  network: 'mainnet' | 'devnet' | 'testnet';
}

function loadConfig(): Config {
  // Check for required environment variables
  const required = ['RPC_URL', 'BLOCK_ENGINE_URL', 'GEYSER_URL', 'AUTH_KEYPAIR_PATH', 'TIPPER_KEYPAIR_PATH'];
  
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  return {
    rpcUrl: process.env.RPC_URL!,
    blockEngineUrl: process.env.BLOCK_ENGINE_URL!,
    geyserUrl: process.env.GEYSER_URL!,
    geyserToken: process.env.GEYSER_TOKEN || '',
    authKeypairPath: process.env.AUTH_KEYPAIR_PATH!,
    tipperKeypairPath: process.env.TIPPER_KEYPAIR_PATH!,
    network: (process.env.NETWORK as 'mainnet' | 'devnet' | 'testnet') || 'devnet'
  };
}

function loadKeypair(path: string): any {
  try {
    const data = fs.readFileSync(path, 'utf-8');
    // Try JSON format first (array of numbers)
    try {
      return JSON.parse(data);
    } catch {
      // Try base58 format
      return data.trim();
    }
  } catch (error) {
    throw new Error(`Failed to load keypair from ${path}: ${(error as Error).message}`);
  }
}

async function main() {
  logger.info('Starting Solana Smart Transaction Stack...');

  try {
    // Load configuration
    const config = loadConfig();
    logger.info('Configuration loaded', { network: config.network });

    // Load keypairs
    const authKeypairData = loadKeypair(config.authKeypairPath);
    const tipperKeypairData = loadKeypair(config.tipperKeypairPath);

    // Create keypairs
    const { Keypair } = await import('@solana/web3.js');
    const authKeypair = Keypair.fromSecretKey(new Uint8Array(authKeypairData));
    const tipperKeypair = Keypair.fromSecretKey(new Uint8Array(tipperKeypairData));

    logger.info('Keypairs loaded', {
      authPubkey: authKeypair.publicKey.toString(),
      tipperPubkey: tipperKeypair.publicKey.toString()
    });

    // Create transaction stack configuration
    const stackConfig: TransactionStackConfig = {
      rpcUrl: config.rpcUrl,
      blockEngineUrl: config.blockEngineUrl,
      geyserUrl: config.geyserUrl,
      geyserToken: config.geyserToken || undefined,
      authKeypairPath: config.authKeypairPath,
      tipperKeypairPath: config.tipperKeypairPath,
      network: config.network,
      maxRetries: 3,
      blockhashRefreshThreshold: 55000, // 55 seconds
      targetCommitment: 'confirmed'
    };

    // Create and initialize transaction stack
    const stack = new TransactionStack(stackConfig);
    await stack.initialize(authKeypair, tipperKeypair);

    // Start the stack
    await stack.start();

    logger.info('Transaction Stack is running');

    // Log stats periodically
    setInterval(() => {
      const stats = stack.getStats();
      logger.debug('Stack stats', stats);
    }, 30000); // Every 30 seconds

    // Log agent reasoning periodically
    setInterval(() => {
      const reasoning = stack.getAgentReasoning();
      logger.debug('Agent reasoning', { reasoning });
    }, 60000); // Every minute

    // Graceful shutdown
    const shutdown = async () => {
      logger.info('Shutting down...');
      await stack.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (error) {
    logger.error('Failed to start transaction stack', { error });
    process.exit(1);
  }
}

main().catch(console.error);

export { TransactionStack, loadConfig, loadKeypair };