// ─── Configuration Management ───
// Validated, typed configuration with env overrides and sensible defaults

import { z } from 'zod';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

const envSchema = z.object({
  // Binance (optional — only used when exchange='binance')
  BINANCE_API_KEY: z.string().optional().default(''),
  BINANCE_WS_URL: z.string().url().default('wss://stream.binance.com:9443/ws'),
  BINANCE_FUTURES_WS_URL: z.string().url().default('wss://fstream.binance.com/ws'),
  BINANCE_REST_URL: z.string().url().default('https://api.binance.com'),
  BINANCE_FUTURES_REST_URL: z.string().url().default('https://fapi.binance.com'),

  // Ollama (Primary LLM provider)
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL_DEFAULT: z.string().default('kimi-k2.6:cloud'),  // Sub-agents default; meta-agent uses deepseek-v4-flash:cloud

  // Paper Trading
  PAPER_INITIAL_BALANCE: z.coerce.number().positive().default(1000),
  PAPER_MAX_POSITION_SIZE_PCT: z.coerce.number().min(0).max(1).default(0.20),
  PAPER_MAX_DRAWDOWN_PCT: z.coerce.number().min(0).max(1).default(0.20),
  PAPER_DAILY_LOSS_LIMIT_PCT: z.coerce.number().min(0).max(1).default(0.05),

  // Risk
  RISK_MAX_LEVERAGE: z.coerce.number().positive().default(1),
  RISK_STOP_LOSS_PCT: z.coerce.number().min(0).default(0.02),
  RISK_TAKE_PROFIT_PCT: z.coerce.number().min(0).default(0.05),
  RISK_TRAILING_STOP_PCT: z.coerce.number().min(0).default(0.015),
  RISK_VETO_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),

  // HACP
  // v2.0.73 S2.1: widened LLM thinking timeout 15s→30s for deeper reasoning
  HACP_PARALLEL_THINKING_TIMEOUT_MS: z.coerce.number().positive().default(30000),
  HACP_MAX_DEBATE_ROUNDS: z.coerce.number().int().positive().default(3),
  // v2.0.73 S2.2: consensus threshold 0.60→0.70 (stricter — requires direction consistency)
  HACP_CONSENSUS_THRESHOLD: z.coerce.number().min(0).max(1).default(0.70),
  HACP_TOTAL_TIMEOUT_MS: z.coerce.number().positive().default(120000),
  HACP_STAGGER_DELAY_MS: z.coerce.number().positive().default(4000),
  // Real Trading — Binance
  BINANCE_SECRET_KEY: z.string().optional().default(''),
  BINANCE_USE_FUTURES: z.coerce.boolean().default(true),

  // Real Trading — Hyperliquid
  HYPERLIQUID_WALLET_ADDRESS: z.string().optional().default(''),
  HYPERLIQUID_PRIVATE_KEY: z.string().optional().default(''),

  // System
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().positive().default(30000),
  DECISION_INTERVAL_MS: z.coerce.number().positive().default(60000),
  API_PORT: z.coerce.number().positive().default(3456),

  // Sigmoid·GA
  GA_POPULATION_SIZE: z.coerce.number().int().positive().default(20),
  GA_MUTATION_RATE: z.coerce.number().min(0).max(1).default(0.15),
  GA_CROSSOVER_RATE: z.coerce.number().min(0).max(1).default(0.70),

  // v2.0.58: Massive.com Options Data API key for Stocks/RWA options data layer
  MASSIVE_API_KEY: z.string().optional().default(''),

  // v2.0.138: EXP — Thesis Experience Vector Memory (Skeptics Phase 1.8a)
  EXP_ENABLED: z.coerce.boolean().default(false),
  EXP_EMBED_MODEL: z.string().default('Xenova/all-MiniLM-L6-v2'),
  EXP_EMBED_DIM: z.coerce.number().int().positive().default(384),
  EXP_MAX_RECORDS: z.coerce.number().int().positive().default(200),
  EXP_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.55),
  EXP_WIN_PROB_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  EXP_LOSS_PROB_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),
  EXP_DELTA_THRESHOLD: z.coerce.number().min(0).max(1).default(0.55),
  EXP_MIN_DELTA_SAMPLES: z.coerce.number().int().positive().default(2),
  EXP_DELTA_WIN_RATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  EXP_DELTA_LOSS_RATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),
  EXP_ALLOW_REVERSE: z.coerce.boolean().default(true),
  EXP_BREAKEVEN_IS: z.enum(['win', 'loss', 'exclude']).default('exclude'),
  EXP_SIMILARITY_MODE: z.enum(['asymmetric', 'symmetric']).default('asymmetric'),
  EXP_JSONL_PATH: z.string().default('data/exp/trades.jsonl'),
  EXP_EXPMD_PATH: z.string().default('data/EXP.md'),
  EXP_INCIDENTS_PATH: z.string().default('data/exp/incidents.jsonl'),
  EXP_REPAIR_ENABLED: z.coerce.boolean().default(true),
  EXP_REPAIR_MAX_RETRIES: z.coerce.number().int().positive().default(1),
  EXP_REPAIR_BACKOFF_MS: z.coerce.number().positive().default(800),
});

function parseEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Configuration validation failed:');
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

const raw = parseEnv();

export const config = {
  binance: {
    apiKey: raw.BINANCE_API_KEY,
    wsUrl: raw.BINANCE_WS_URL,
    futuresWsUrl: raw.BINANCE_FUTURES_WS_URL,
    restUrl: raw.BINANCE_REST_URL,
    futuresRestUrl: raw.BINANCE_FUTURES_REST_URL,
  },
  ollama: {
    baseUrl: raw.OLLAMA_BASE_URL,
    modelDefault: raw.OLLAMA_MODEL_DEFAULT,
  },
  paper: {
    initialBalance: raw.PAPER_INITIAL_BALANCE,
    maxPositionSizePct: raw.PAPER_MAX_POSITION_SIZE_PCT,
    maxDrawdownPct: raw.PAPER_MAX_DRAWDOWN_PCT,
    dailyLossLimitPct: raw.PAPER_DAILY_LOSS_LIMIT_PCT,
  },
  risk: {
    maxLeverage: raw.RISK_MAX_LEVERAGE,
    stopLossPct: raw.RISK_STOP_LOSS_PCT,
    takeProfitPct: raw.RISK_TAKE_PROFIT_PCT,
    trailingStopPct: raw.RISK_TRAILING_STOP_PCT,
    vetoThreshold: raw.RISK_VETO_THRESHOLD,
  },
  hacp: {
    parallelThinkingTimeoutMs: raw.HACP_PARALLEL_THINKING_TIMEOUT_MS,
    maxDebateRounds: raw.HACP_MAX_DEBATE_ROUNDS,
    consensusThreshold: raw.HACP_CONSENSUS_THRESHOLD,
    totalTimeoutMs: raw.HACP_TOTAL_TIMEOUT_MS,
    staggerDelayMs: raw.HACP_STAGGER_DELAY_MS,
  },
  realTrading: {
    binanceSecretKey: raw.BINANCE_SECRET_KEY,
    binanceUseFutures: raw.BINANCE_USE_FUTURES,
    hyperliquidWalletAddress: raw.HYPERLIQUID_WALLET_ADDRESS,
    hyperliquidPrivateKey: raw.HYPERLIQUID_PRIVATE_KEY,
  },
  system: {
    logLevel: raw.LOG_LEVEL,
    nodeEnv: raw.NODE_ENV,
    heartbeatIntervalMs: raw.HEARTBEAT_INTERVAL_MS,
    decisionIntervalMs: raw.DECISION_INTERVAL_MS,
    apiPort: raw.API_PORT,
    isProduction: raw.NODE_ENV === 'production',
    isDevelopment: raw.NODE_ENV === 'development',
  },
  ga: {
    populationSize: raw.GA_POPULATION_SIZE,
    mutationRate: raw.GA_MUTATION_RATE,
    crossoverRate: raw.GA_CROSSOVER_RATE,
  },
  // v2.0.58: Massive.com Options Data key
  massiveApiKey: raw.MASSIVE_API_KEY,
  // v2.0.138: EXP thesis-experience vector memory
  exp: {
    enabled: raw.EXP_ENABLED,
    embedModel: raw.EXP_EMBED_MODEL,
    embedDim: raw.EXP_EMBED_DIM,
    maxRecords: raw.EXP_MAX_RECORDS,
    matchThreshold: raw.EXP_MATCH_THRESHOLD,
    winProbThreshold: raw.EXP_WIN_PROB_THRESHOLD,
    lossProbThreshold: raw.EXP_LOSS_PROB_THRESHOLD,
    deltaThreshold: raw.EXP_DELTA_THRESHOLD,
    minDeltaSamples: raw.EXP_MIN_DELTA_SAMPLES,
    deltaWinRateThreshold: raw.EXP_DELTA_WIN_RATE_THRESHOLD,
    deltaLossRateThreshold: raw.EXP_DELTA_LOSS_RATE_THRESHOLD,
    allowReverse: raw.EXP_ALLOW_REVERSE,
    breakevenIs: raw.EXP_BREAKEVEN_IS,
    similarityMode: raw.EXP_SIMILARITY_MODE,
    jsonlPath: raw.EXP_JSONL_PATH,
    expMdPath: raw.EXP_EXPMD_PATH,
    incidentsPath: raw.EXP_INCIDENTS_PATH,
    repair: {
      enabled: raw.EXP_REPAIR_ENABLED,
      maxRetries: raw.EXP_REPAIR_MAX_RETRIES,
      backoffMs: raw.EXP_REPAIR_BACKOFF_MS,
    },
    /** Per-symbol asset-category override. Symbols not listed are inferred by assetCategory(). */
    assetCategoryMap: {
      BTC: 'crypto',
      ETH: 'crypto',
      'xyz:MU': 'equity',
      'xyz:SILVER': 'commodity',
      XAU: 'commodity',
      SILVER: 'commodity',
    } as Record<string, 'crypto' | 'commodity' | 'equity' | 'forex' | 'other'>,
  },
} as const;

export type AppConfig = typeof config;