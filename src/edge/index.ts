// ─── Edge Validation Layer (v2.0.833) ────────────────────────────────
//
// Barrel for the Edge Validation subsystem (Task 1 + Task 2). See plan.md
// §1 for the design rationale: this layer is an alpha "lie detector",
// not an alpha generator. It quantifies whether each (symbol × regime)
// combination has a genuine, non-luck, non-beta statistical edge, and
// writes that into the analysis matrix so the client can show a
// confidence badge and the backend can skip low-edge signals.
//
// Components:
//   edge-config            — all thresholds + weights (env-tunable)
//   edge-calculator        — Task 1A: 5-component edgeScore per asset
//   execution-tracker      — Task 1B: realised slippage + funding calibration
//   stability-monitor      — Task 1C: perturbation + cross-time stability
//   backtest-validation     — Sharpe/Sortino/Calmar/PF/walk-forward/bootstrap/DSR/IR
//
// v2.0.859: REMOVED risk-profile-edge-store (MiniLM vector DB) + dcs-calculator
// (DCS v2) — both were wired but had zero decision consumers since v2.0.857
// (moderate-only removal cut their outputs; MiniLM queries still burned
// 200ms-1s/cycle of embed inference on the main decision path). Removed
// completely per owner decision — edgeReport (edge-calculator) remains the
// single edge signal.

export * from './edge-config.ts';
export * from './edge-calculator.ts';
export * from './execution-tracker.ts';
export * from './stability-monitor.ts';
export * from './backtest-validation.ts';