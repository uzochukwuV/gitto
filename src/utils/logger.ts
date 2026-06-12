import winston from 'winston';
import path from 'path';
import fs from 'fs';

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, ...metadata }) => {
    let msg = `${timestamp} [${level.toUpperCase()}] ${message}`;
    if (Object.keys(metadata).length > 0) {
      msg += ` ${JSON.stringify(metadata)}`;
    }
    return msg;
  })
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        logFormat
      )
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'transaction-stack.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'errors.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5
    })
  ]
});

// Lifecycle log file
const lifecycleLogPath = path.join(logsDir, 'lifecycle.jsonl');

export function logLifecycleEntry(entry: any): void {
  const line = JSON.stringify({
    timestamp: entry.timestamp,
    ...entry
  }) + '\n';
  fs.appendFileSync(lifecycleLogPath, line);
}

export function readLifecycleLog(): any[] {
  if (!fs.existsSync(lifecycleLogPath)) {
    return [];
  }
  const content = fs.readFileSync(lifecycleLogPath, 'utf-8');
  return content.trim().split('\n').map(line => JSON.parse(line));
}

export function clearLifecycleLog(): void {
  if (fs.existsSync(lifecycleLogPath)) {
    fs.unlinkSync(lifecycleLogPath);
  }
}

export default logger;