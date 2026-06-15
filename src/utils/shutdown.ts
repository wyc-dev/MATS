// ─── Graceful Shutdown Manager ───
// Orchestrates orderly shutdown of all system components

import { rootLogger } from '../observability/logger.ts';

type ShutdownHandler = {
  name: string;
  priority: number; // lower = shutdown first
  handler: () => Promise<void>;
};

const handlers: ShutdownHandler[] = [];
let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function registerShutdownHandler(
  name: string,
  handler: () => Promise<void>,
  priority = 100
): void {
  handlers.push({ name, handler, priority });
  handlers.sort((a, b) => a.priority - b.priority);
}

export async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    rootLogger.warn(`Shutdown already in progress, ignoring signal: ${signal}`);
    return;
  }

  shuttingDown = true;
  rootLogger.info(`🛑 Received ${signal}. Initiating graceful shutdown...`);

  const startTime = Date.now();

  for (const { name, handler, priority } of handlers) {
    try {
      rootLogger.info(`  Shutting down [${name}] (priority: ${priority})...`);
      await Promise.race([
        handler(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Shutdown timeout')), 10_000)
        ),
      ]);
      rootLogger.info(`  ✓ [${name}] shutdown complete.`);
    } catch (err) {
      rootLogger.error(`  ✗ [${name}] shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const elapsed = Date.now() - startTime;
  rootLogger.info(`✅ Graceful shutdown complete (${elapsed}ms). Goodbye.`);
  process.exit(0);
}

export function setupShutdownHandlers(): void {
  // SIGINT (Ctrl+C) and SIGTERM (kill)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void gracefulShutdown(signal);
    });
  }

  // Unhandled errors — log and attempt shutdown
  process.on('uncaughtException', (error) => {
    rootLogger.error(`Uncaught exception: ${error.message}`, { stack: error.stack });
    void gracefulShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    rootLogger.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });

  rootLogger.info('Shutdown handlers registered.');
}