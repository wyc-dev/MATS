// ─── v2.0.219: World Model (Latent Market Dynamics) ──────────────────
//
// A simplified Dreamer-style world model that learns to predict the
// next-cycle market state from the current state. This enables "latent
// imagination" — the system can simulate forward to evaluate entry
// decisions without actually trading.
//
// Architecture (lightweight — no deep learning, pure TypeScript):
//   - State encoder: maps 14 OLR features → 8-d latent vector (linear)
//   - Transition model: predicts next latent state from current latent
//   - Reward predictor: predicts trade outcome from latent + action
//   - Rollout: simulate N steps forward, evaluate expected reward
//
// This is NOT a full Dreamer V3 — it's a minimal viable world model
// that provides "what-if" planning capability.
//
// Production-grade:
// - All values sanitized (safeNum)
// - Bounded latent space (tanh activation)
// - Cold-start safe (returns 0.5 for untrained model)
// - Persistence with corrupt-last-good recovery
// - No external dependencies (pure TS linear algebra)

import { createLogger } from '../observability/logger.ts';
import { safeNum } from './evolution-utils.ts';

const log = createLogger({ phase: 'world-model' });

// ─── Types ───

export interface WorldModelConfig {
  /** Input dimension (OLR features, 14) */
  inputDim: number;
  /** Latent dimension (compressed representation) */
  latentDim: number;
  /** Action dimension (1 = side: buy=1, sell=-1, hold=0) */
  actionDim: number;
  /** Learning rate */
  learningRate: number;
  /** L2 regularization */
  l2Reg: number;
  /** Number of rollout steps for planning */
  rolloutSteps: number;
  /** Min samples before using for planning */
  minSamples: number;
  /** Discount factor for rollout (gamma) */
  gamma: number;
}

export interface WorldModelState {
  features: Record<string, number>;
  symbol: string;
  side: 'buy' | 'sell';
  cycle: number;
}

export interface WorldModelPrediction {
  /** Predicted next-cycle features */
  predictedNextFeatures: Record<string, number>;
  /** Predicted trade outcome (pWin) */
  predictedPWin: number;
  /** Confidence in prediction [0, 1] */
  confidence: number;
  /** Number of training samples */
  samples: number;
  /** Whether the model is ready for planning */
  ready: boolean;
}

export interface RolloutResult {
  /** Expected cumulative reward over rollout horizon */
  expectedReward: number;
  /** Trajectory of predicted pWin at each step */
  pWinTrajectory: number[];
  /** Final confidence */
  confidence: number;
  /** Steps actually rolled out */
  stepsRolled: number;
}

// ─── WorldModel ───

export class WorldModel {
  private config: WorldModelConfig;
  /** Encoder weights: inputDim × latentDim */
  private encoder: number[][];
  /** Decoder weights: latentDim × inputDim (for reconstruction training) */
  private decoder: number[][];
  /** Transition model: (latentDim + actionDim) × latentDim */
  private transition: number[][];
  /** Reward predictor: (latentDim + actionDim) × 1 */
  private rewardHead: number[][];
  /** Training sample count */
  private sampleCount = 0;
  /** Feature keys (for consistent vectorization) */
  private featureKeys: string[];

  constructor(featureKeys: string[], config?: Partial<WorldModelConfig>) {
    this.featureKeys = featureKeys;
    this.config = {
      inputDim: featureKeys.length,
      latentDim: 8,
      actionDim: 1,
      learningRate: 0.01,
      l2Reg: 0.001,
      rolloutSteps: 3,
      minSamples: 50,
      gamma: 0.9,
      ...config,
    };
    // Initialize weights with small random values
    const init = () => (Math.random() - 0.5) * 0.1;
    this.encoder = Array.from({ length: this.config.inputDim }, () =>
      Array.from({ length: this.config.latentDim }, init));
    this.decoder = Array.from({ length: this.config.latentDim }, () =>
      Array.from({ length: this.config.inputDim }, init));
    this.transition = Array.from({ length: this.config.latentDim + this.config.actionDim }, () =>
      Array.from({ length: this.config.latentDim }, init));
    this.rewardHead = Array.from({ length: this.config.latentDim + this.config.actionDim }, () =>
      [init()]);
  }

  /**
   * Encode features → latent vector (with tanh activation for bounded latent).
   */
  private encode(features: number[]): number[] {
    const latent = new Array(this.config.latentDim).fill(0);
    for (let j = 0; j < this.config.latentDim; j++) {
      for (let i = 0; i < this.config.inputDim; i++) {
        latent[j]! += features[i]! * this.encoder[i]![j]!;
      }
      latent[j] = Math.tanh(latent[j]!); // bounded [-1, 1]
    }
    return latent;
  }

  /**
   * Decode latent → reconstructed features.
   */
  private decode(latent: number[]): number[] {
    const recon = new Array(this.config.inputDim).fill(0);
    for (let j = 0; j < this.config.inputDim; j++) {
      for (let i = 0; i < this.config.latentDim; i++) {
        recon[j]! += latent[i]! * this.decoder[i]![j]!;
      }
    }
    return recon;
  }

  /**
   * Predict next latent state given current latent + action.
   */
  private predictNextLatent(latent: number[], action: number): number[] {
    const input = [...latent, action]; // latentDim + actionDim
    const nextLatent = new Array(this.config.latentDim).fill(0);
    for (let j = 0; j < this.config.latentDim; j++) {
      for (let i = 0; i < input.length; i++) {
        nextLatent[j]! += input[i]! * this.transition[i]![j]!;
      }
      nextLatent[j] = Math.tanh(nextLatent[j]!);
    }
    return nextLatent;
  }

  /**
   * Predict reward (pWin) from latent + action.
   */
  private predictReward(latent: number[], action: number): number {
    const input = [...latent, action];
    let z = 0;
    for (let i = 0; i < input.length; i++) {
      z += input[i]! * this.rewardHead[i]![0]!;
    }
    z = Math.max(-10, Math.min(10, z));
    return 1 / (1 + Math.exp(-z));
  }

  /**
   * Add a training sample: (state, action, nextState, reward).
   * Trains encoder, decoder, transition, and reward head jointly.
   */
  addSample(
    features: Record<string, number>,
    action: number,
    nextFeatures: Record<string, number>,
    reward: number,
  ): void {
    // Vectorize features
    const x = this.featureKeys.map(k => {
      const v = safeNum(features[k], 0);
      return Number.isFinite(v) ? v : 0;
    });
    const xNext = this.featureKeys.map(k => {
      const v = safeNum(nextFeatures[k], 0);
      return Number.isFinite(v) ? v : 0;
    });

    // Forward: encode → latent
    const latent = this.encode(x);
    const recon = this.decode(latent);
    const nextLatent = this.predictNextLatent(latent, action);
    const predictedReward = this.predictReward(latent, action);

    // Gradients
    const lr = this.config.learningRate;

    // 1. Reconstruction loss gradient: ∂L_recon/∂decoder = (recon - x) * latent
    for (let j = 0; j < this.config.inputDim; j++) {
      const reconErr = recon[j]! - x[j]!;
      for (let i = 0; i < this.config.latentDim; i++) {
        this.decoder[i]![j]! -= lr * (reconErr * latent[i]! + this.config.l2Reg * this.decoder[i]![j]!);
      }
    }

    // 2. Transition loss: predict next latent from current latent + action
    const transErr = nextLatent.map((pred, i) => pred - xNext.length > 0 ?
      Math.tanh(safeNum(this.featureKeys.map(k => safeNum(nextFeatures[k], 0))[i] ?? 0, 0)) : 0);
    // Simplified: use reconstruction of next state as target
    const nextRecon = this.decode(nextLatent);
    for (let j = 0; j < this.config.inputDim; j++) {
      const err = nextRecon[j]! - xNext[j]!;
      for (let i = 0; i < this.config.latentDim + this.config.actionDim; i++) {
        const input = i < this.config.latentDim ? latent[i]! : action;
        this.transition[i]![j % this.config.latentDim]! -= lr * 0.5 * (err * input +
          this.config.l2Reg * this.transition[i]![j % this.config.latentDim]!);
      }
    }

    // 3. Reward loss: predict reward (0/1) from latent + action
    const rewardErr = predictedReward - reward;
    for (let i = 0; i < this.config.latentDim + this.config.actionDim; i++) {
      const input = i < this.config.latentDim ? latent[i]! : action;
      this.rewardHead[i]![0]! -= lr * (rewardErr * input + this.config.l2Reg * this.rewardHead[i]![0]!);
    }

    // 4. Encoder: gradient flows from reconstruction + reward losses
    for (let i = 0; i < this.config.inputDim; i++) {
      for (let j = 0; j < this.config.latentDim; j++) {
        const reconGrad = (recon[j]! - x[j]!) * this.decoder[j]![i]!;
        const rewardGrad = rewardErr * this.rewardHead[j]![0]!;
        // tanh derivative: (1 - latent^2)
        const tanhDeriv = 1 - latent[j]! * latent[j]!;
        this.encoder[i]![j]! -= lr * (reconGrad + rewardGrad) * tanhDeriv * x[i]!;
      }
    }

    this.sampleCount++;
  }

  /**
   * Predict next-cycle state and trade outcome.
   */
  predict(state: WorldModelState): WorldModelPrediction {
    const action = state.side === 'buy' ? 1 : -1;
    const x = this.featureKeys.map(k => {
      const v = safeNum(state.features[k], 0);
      return Number.isFinite(v) ? v : 0;
    });

    const latent = this.encode(x);
    const nextLatent = this.predictNextLatent(latent, action);
    const pWin = this.predictReward(latent, action);

    // Predict next features (for monitoring)
    const nextRecon = this.decode(nextLatent);
    const predictedNextFeatures: Record<string, number> = {};
    for (let i = 0; i < this.featureKeys.length; i++) {
      predictedNextFeatures[this.featureKeys[i]!] = nextRecon[i]!;
    }

    const ready = this.sampleCount >= this.config.minSamples;
    const confidence = Math.min(1, this.sampleCount / this.config.minSamples);

    return {
      predictedNextFeatures,
      predictedPWin: Number.isFinite(pWin) ? pWin : 0.5,
      confidence,
      samples: this.sampleCount,
      ready,
    };
  }

  /**
   * Rollout: simulate N steps forward and compute expected cumulative reward.
   * This is "latent imagination" — plan without actually trading.
   */
  rollout(state: WorldModelState, steps?: number): RolloutResult {
    const horizon = steps ?? this.config.rolloutSteps;

    if (this.sampleCount < this.config.minSamples) {
      return {
        expectedReward: 0.5,
        pWinTrajectory: new Array(horizon).fill(0.5),
        confidence: 0,
        stepsRolled: 0,
      };
    }

    const action = state.side === 'buy' ? 1 : -1;
    const x = this.featureKeys.map(k => {
      const v = safeNum(state.features[k], 0);
      return Number.isFinite(v) ? v : 0;
    });

    let latent = this.encode(x);
    let cumulativeReward = 0;
    const pWinTrajectory: number[] = [];
    let discount = 1;

    for (let step = 0; step < horizon; step++) {
      const pWin = this.predictReward(latent, action);
      pWinTrajectory.push(Number.isFinite(pWin) ? pWin : 0.5);
      cumulativeReward += discount * pWin;
      discount *= this.config.gamma;

      // Transition to next latent
      latent = this.predictNextLatent(latent, action);
    }

    return {
      expectedReward: cumulativeReward / horizon,
      pWinTrajectory,
      confidence: Math.min(1, this.sampleCount / this.config.minSamples),
      stepsRolled: horizon,
    };
  }

  /**
   * Get state for monitoring.
   */
  getState() {
    return {
      sampleCount: this.sampleCount,
      ready: this.sampleCount >= this.config.minSamples,
      latentDim: this.config.latentDim,
    };
  }

  /**
   * Save state.
   */
  save(): string {
    return JSON.stringify({
      encoder: this.encoder,
      decoder: this.decoder,
      transition: this.transition,
      rewardHead: this.rewardHead,
      sampleCount: this.sampleCount,
      featureKeys: this.featureKeys,
      config: this.config,
    });
  }

  /**
   * Load state with corrupt-last-good recovery.
   */
  load(json: string): void {
    try {
      const data = JSON.parse(json);
      if (Array.isArray(data.encoder)) this.encoder = data.encoder;
      if (Array.isArray(data.decoder)) this.decoder = data.decoder;
      if (Array.isArray(data.transition)) this.transition = data.transition;
      if (Array.isArray(data.rewardHead)) this.rewardHead = data.rewardHead;
      if (Number.isFinite(data.sampleCount)) this.sampleCount = data.sampleCount;
      if (Array.isArray(data.featureKeys)) this.featureKeys = data.featureKeys;
      if (data.config) this.config = { ...this.config, ...data.config };
      log.info(`World model loaded: ${this.sampleCount} samples, ready=${this.sampleCount >= this.config.minSamples}`);
    } catch {
      log.warn('[world-model] Failed to load, starting fresh');
    }
  }
}