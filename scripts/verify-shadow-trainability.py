#!/usr/bin/env python3
"""
verify-shadow-trainability.py —— PLAN_shadow-connectome-layer E0: 可訓練性 audit(v2 numpy)
2026-09-18。純離線(read-only)。用現有 33k shadow-events 驗證:
  E0-1: Logistic Regression(8 entry features → win)
  E0-2: 2-layer MLP(8 → 16 → 1)
  E0-3: per-feature avgRankSpearman
時間序 split: 前 70% train / 後 30% OOS(零 look-ahead)
"""
import json, math
import numpy as np

rows = []
for line in open('data/evolution/shadow-events.jsonl'):
    line = line.strip()
    if not line: continue
    try: r = json.loads(line)
    except: continue
    rows.append(r)
print(f"shadow-events 總數: {len(rows)}")

# v2.0.898-fix: 動態特徵子集——歷史數據冇新欄位(只 18 條 m4hAtOpen),唔可以要求全 12 特徵先入樣本
# (否則 34k 樣本縮到 0 = script 死)。策略: 先統計每個特徵覆蓋,<200 樣本嘅新欄位自動剔除;
# 特徵空間 = 數據實際覆蓋話事(歷史 8 / 累積後 12)。
F = ['entryShadowWRAtOpen','sentimentAtEntry','sentimentConvictionAtEntry','fundingRateAtEntry',
     'volatilityAtEntry','obImbalanceAtEntry','volumeRatioAtEntry','srDistanceBpsAtEntry',
     'm4hAtOpen','m15mAtOpen','regimeOrdinalAtOpen','hourOfDayAtOpen']
coverage = {f: sum(1 for r in rows if isinstance(r.get(f),(int,float)) and math.isfinite(r.get(f))) for f in F}
active_F = [f for f in F if coverage[f] >= 200]
if len(active_F) < len(F):
    print(f"[動態子集] 特徵覆蓋: {len(active_F)}/{len(F)} active——剔除 <200 樣本嘅新欄位")
    print(f"  剔除: {[f for f in F if f not in active_F]} (累積 2-4 週後自動恢復)")
F = active_F

samples = []
for r in rows:
    vals = []
    ok = True
    for f in F:
        v = r.get(f)
        if not isinstance(v,(int,float)) or not math.isfinite(v):
            ok = False; break
        vals.append(float(v))
    if not ok: continue
    y = r.get('outcome')
    if y not in ('win','loss'): continue
    ts = r.get('resolvedAt')
    if not isinstance(ts,(int,float)): ts = 0
    samples.append((ts, vals, 1.0 if y=='win' else 0.0))
print(f"完整特徵樣本: {len(samples)}")
if len(samples) < 200:
    print("樣本不足"); raise SystemExit(1)

samples.sort(key=lambda s: s[0])
split = int(len(samples)*0.7)
train, oos = samples[:split], samples[split:]
print(f"train={len(train)} oos={len(oos)}")

Xtr = np.array([s[1] for s in train], dtype=np.float64)
Ytr = np.array([s[2] for s in train])
Xoo = np.array([s[1] for s in oos], dtype=np.float64)
Yoo = np.array([s[2] for s in oos])

# 標準化(fit on train)——零 look-ahead
mu = Xtr.mean(axis=0); sd = Xtr.std(axis=0); sd[sd==0] = 1.0
Xtr = (Xtr - mu)/sd; Xoo = (Xoo - mu)/sd

def spearman(a, b):
    n = len(a)
    def rank(v):
        idx = np.argsort(v, kind='mergesort')
        r = np.zeros(n)
        i = 0
        while i < n:
            j = i
            while j+1 < n and v[idx[j+1]] == v[idx[i]]: j += 1
            av = (i+j)/2 + 1
            for k in range(i, j+1): r[idx[k]] = av
            i = j+1
        return r
    ra, rb = rank(a), rank(b)
    ma, mb = ra.mean(), rb.mean()
    num = ((ra-ma)*(rb-mb)).sum()
    da = math.sqrt(((ra-ma)**2).sum()); db = math.sqrt(((rb-mb)**2).sum())
    return num/(da*db) if da*db else 0.0

def ev(pred, y):
    return float(((pred-0.5)*(2*y-1)).mean())

def sigmoid(z):
    return 1.0/(1.0+np.exp(-np.clip(z, -30, 30)))

# ── E0-1 LogReg(λ=1e-3, 200 iters, full-batch) ──
Xb = np.hstack([Xtr, np.ones((len(Xtr),1))])
Xob = np.hstack([Xoo, np.ones((len(Xoo),1))])
w = np.zeros(Xb.shape[1])
for it in range(200):
    p = sigmoid(Xb @ w)
    g = Xb.T @ (p - Ytr)/len(Xtr) + 1e-3*w
    w -= 0.1*g
ptr = sigmoid(Xb @ w); po = sigmoid(Xob @ w)
rho_1 = spearman(po, Yoo); ev_1 = ev(po, Yoo)
print("\n[E0-1 LogReg]")
print(f"  train ρ={spearman(ptr,Ytr):+.4f}  OOS ρ={rho_1:+.4f}  OOS EV={ev_1:+.4f}")
print(f"  OOS base WR={Yoo.mean()*100:.1f}%")

# ── E0-2 MLP(8→16→1, Adam-lite, 300 iters) ──
rng = np.random.default_rng(42)
D = Xtr.shape[1]; H = 16
W1 = rng.normal(0, 0.3, (D, H)); b1 = np.zeros(H)
W2 = rng.normal(0, 0.3, H); b2 = 0.0
mW1 = np.zeros_like(W1); mW2 = np.zeros_like(W2); mb1 = np.zeros_like(b1)
for it in range(300):
    h = np.maximum(0, Xtr @ W1 + b1)
    z = h @ W2 + b2
    p = sigmoid(z)
    dz = p - Ytr
    gW2 = h.T @ dz/len(Xtr) + 1e-4*W2
    gb2 = float(dz.mean())
    dh = (dz[:,None] * W2[None,:]) * (h>0)
    gW1 = Xtr.T @ dh/len(Xtr) + 1e-4*W1
    gb1 = dh.mean(axis=0)
    mW1 = 0.9*mW1 + 0.1*gW1; mW2 = 0.9*mW2 + 0.1*gW2; mb1 = 0.9*mb1 + 0.1*gb1
    W1 -= 0.05*mW1; b1 -= 0.05*mb1; W2 -= 0.05*mW2; b2 -= 0.05*gb2

def mlp_pred(X):
    h = np.maximum(0, X @ W1 + b1)
    return sigmoid(h @ W2 + b2)
mtr = mlp_pred(Xtr); moo = mlp_pred(Xoo)
rho_2 = spearman(moo, Yoo); ev_2 = ev(moo, Yoo)
print("\n[E0-2 MLP(8→16→1)]")
print(f"  train ρ={spearman(mtr,Ytr):+.4f}  OOS ρ={rho_2:+.4f}  OOS EV={ev_2:+.4f}")

# ── E0-3 per-feature ρ ──
print("\n[E0-3 per-feature ρ(OOS)]")
for j, f in enumerate(F):
    xs = Xoo[:,j]
    if len(set(xs.tolist())) < 2:
        print(f"  {f:<28} 零變異"); continue
    print(f"  {f:<28} ρ={spearman(xs, Yoo):+.4f}")

log_pass = abs(rho_1) >= 0.05
mlp_pass = abs(rho_2) >= 0.05
print("\n════ 裁決 ════")
print(f"E0-1 LogReg OOS |ρ|={abs(rho_1):.4f} {'✅ PASS(≥0.05)' if log_pass else '❌ FAIL'}")
print(f"E0-2 MLP    OOS |ρ|={abs(rho_2):.4f} {'✅ PASS(≥0.05)' if mlp_pass else '❌ FAIL'}")
print("誠實解讀: FAIL 唔代表方向唔可以 train,代表「現有 8 特徵快照空間」冇足夠資訊")
print("→ 支持 E1: 需要時間結構/regime/位置特徵(由今日起記錄, 2-4 週後重驗)")
