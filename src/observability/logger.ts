// ─── Structured Logger ───
// Production-grade Winston logger with JSON formatting, log levels, and context injection

import winston from 'winston';
import { config } from '../config/index.ts';
import type { LogContext } from '../types/index.ts';

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

// Human-readable format for development
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss.SSS' }),
  errors({ stack: true }),
  printf(({ timestamp, level, message, context, stack, ...rest }) => {
    const ctx = context as LogContext | undefined;
    const ctxStr = ctx
      ? ` [${[ctx.agent, ctx.phase, ctx.symbol].filter(Boolean).join('|')}]`
      : '';
    const restStr = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    return `${timestamp} ${level}${ctxStr} ${message}${restStr}`;
  })
);

// JSON format for production
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

const logger = winston.createLogger({
  level: config.system.logLevel,
  format: config.system.isProduction ? prodFormat : devFormat,
  transports: [
    new winston.transports.Console({
      handleExceptions: true,
      handleRejections: true,
    }),
  ],
  exitOnError: false,
});

// File transport in production
if (config.system.isProduction) {
  logger.add(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 10_485_760, // 10 MB
      maxFiles: 5,
    })
  );
  logger.add(
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 52_428_800, // 50 MB
      maxFiles: 3,
    })
  );
}

// Context-aware logger factory
export function createLogger(context: LogContext) {
  return {
    error: (message: string, meta?: Record<string, unknown>) =>
      logger.error(message, { context, ...meta }),
    warn: (message: string, meta?: Record<string, unknown>) =>
      logger.warn(message, { context, ...meta }),
    info: (message: string, meta?: Record<string, unknown>) =>
      logger.info(message, { context, ...meta }),
    debug: (message: string, meta?: Record<string, unknown>) =>
      logger.debug(message, { context, ...meta }),
  };
}

// Root logger
export const rootLogger = createLogger({ phase: 'system' });
export { logger };