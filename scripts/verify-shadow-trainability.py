#!/usr/bin/env python3
"""
verify-shadow-trainability.py —— PLAN_shadow-connectome-layer E0/E2: 可訓練性 audit(v3 雙 view)
2026-09-18。純離線(read-only)。用 shadow-events 驗證方向判斷可 train:
  View A: 8 基本 entry features（全樣本——歷史 34k+, 唔要求時間欄位）
  View B: 全部 active features（8 基本 + 已累積嘅時間特徵——新樣本, 樣本較少）
比較 A vs B 嘅 OOS ρ——**時間特徵有冇真正加值**, 唔好被「樣本集唔同」假 FAIL 誤導。
"""
import json, math
import numpy as np

rows = []
for line in open('data/evolution/shadow-events.jsonl'):
    line = line.strip()
    if not line: continue
    try: r = json.loads(line)
    except: continue
    if not isinstance(r, dict): continue  # v2.0.907-attack8: 持久化污染防線
    rows.append(r)
print(f"shadow-events 總數: {len(rows)}")

F_BASE = ['entryShadowWRAtOpen','sentimentAtEntry','sentimentConvictionAtEntry','fundingRateAtEntry',
          'volatilityAtEntry','obImbalanceAtEntry','volumeRatioAtEntry','srDistanceBpsAtEntry']
F_TIME = ['m4hAtOpen','m15mAtOpen','regimeOrdinalAtOpen','hourOfDayAtOpen']

# 時間特徵覆蓋
cov = {f: sum(1 for r in rows if isinstance(r.get(f),(int,float)) and math.isfinite(r.get(f))) for f in F_TIME}
active_time = [f for f in F_TIME if cov[f] >= 200]
print(f"時間特徵 active: {active_time} (覆蓋: { {f: cov[f] for f in F_TIME} })")

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
    da = math.sqrt(((ra-ma)**2).sum()); db = math.sqrt(((rb-mb)**2).sum())
    return 0.0 if da*db == 0 else float(((ra-ma)*(rb-mb)).sum()/(da*db))

def ev(pred, y):
    return float(((pred-0.5)*(2*y-1)).mean())

def sigmoid(z):
    return 1.0/(1.0+np.exp(-np.clip(z, -30, 30)))

def run_view(F, name):
    """時間序 split + LogReg + per-feature ρ — 返回 dict"""
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
    print(f"\n══════ View {name} ({len(F)} feats): 樣本={len(samples)} ══════")
    if len(samples) < 200:
        print("  樣本不足(<200)→ skip")
        return None
    samples.sort(key=lambda s: s[0])
    split = int(len(samples)*0.7)
    train, oos = samples[:split], samples[split:]
    Xtr = np.array([s[1] for s in train], dtype=np.float64)
    Ytr = np.array([s[2] for s in train])
    Xoo = np.array([s[1] for s in oos], dtype=np.float64)
    Yoo = np.array([s[2] for s in oos])
    mu = Xtr.mean(axis=0); sd = Xtr.std(axis=0); sd[sd==0] = 1.0
    Xtr = (Xtr - mu)/sd; Xoo = (Xoo - mu)/sd
    Xb = np.hstack([Xtr, np.ones((len(Xtr),1))])
    Xob = np.hstack([Xoo, np.ones((len(Xoo),1))])
    w = np.zeros(Xb.shape[1])
    for it in range(200):
        p = sigmoid(Xb @ w)
        w -= 0.1*(Xb.T @ (p - Ytr)/len(Xtr) + 1e-3*w)
    ptr = sigmoid(Xb @ w); po = sigmoid(Xob @ w)
    rho_oo = spearman(po, Yoo); ev_oo = ev(po, Yoo)
    wr_oos = Yoo.mean()*100
    feat_rho = {f: spearman(Xoo[:,j], Yoo) for j, f in enumerate(F)}
    print(f"  LogReg OOS: ρ={rho_oo:+.4f}  EV={ev_oo:+.4f}  base WR={wr_oos:.1f}%")
    top = sorted(feat_rho.items(), key=lambda x: -abs(x[1]))[:4]
    for f, v in top:
        print(f"     ρ[{f}] = {v:+.4f}")
    return {'name': name, 'n': len(samples), 'rho': rho_oo, 'ev': ev_oo, 'feats': feat_rho}

print("== View A: 8 基本特徵（全樣本）==")
A = run_view(F_BASE, 'A(8 basic)')

print("\n== View B: 8 基本 + 時間特徵 ==")
F_FULL = F_BASE + active_time
B = run_view(F_FULL, 'B(8+time)')

# View C: 同一批樣本(B 嘅 3,256 有齊時間特徵)但只用 8 基本特徵——
# 分離「時間特徵效果」同「樣本集差異」(主神「先驗證絕對成效」——唔可以靠唔同樣本比較)
def run_view_same_set(F, name, samples):
    print(f"\n══════ View {name} ({len(F)} feats, 同 B 樣本集): n={len(samples)} ══════")
    if len(samples) < 200:
        print("  樣本不足"); return None
    samples = sorted(samples, key=lambda s: s[0])
    split = int(len(samples)*0.7)
    train, oos = samples[:split], samples[split:]
    Xtr = np.array([s[1] for s in train], dtype=np.float64)
    Ytr = np.array([s[2] for s in train])
    Xoo = np.array([s[1] for s in oos], dtype=np.float64)
    Yoo = np.array([s[2] for s in oos])
    mu = Xtr.mean(axis=0); sd = Xtr.std(axis=0); sd[sd==0] = 1.0
    Xtr = (Xtr - mu)/sd; Xoo = (Xoo - mu)/sd
    Xb = np.hstack([Xtr, np.ones((len(Xtr),1))]); Xob = np.hstack([Xoo, np.ones((len(Xoo),1))])
    w = np.zeros(Xb.shape[1])
    for it in range(200):
        p = sigmoid(Xb @ w)
        w -= 0.1*(Xb.T @ (p - Ytr)/len(Xtr) + 1e-3*w)
    po = sigmoid(Xob @ w)
    return {'name': name, 'n': len(samples), 'rho': spearman(po, Yoo), 'ev': ev(po, Yoo)}

# 收集「有齊全部 12 特徵」嘅樣本（即 View B 用嗰批）
full_samples = []
for r in rows:
    vals = []
    ok = True
    for f in F_FULL:
        v = r.get(f)
        if not isinstance(v,(int,float)) or not math.isfinite(v): ok = False; break
        vals.append(float(v))
    if not ok: continue
    y = r.get('outcome')
    if y not in ('win','loss'): continue
    ts = r.get('resolvedAt')
    if not isinstance(ts,(int,float)): ts = 0
    full_samples.append((ts, vals, 1.0 if y=='win' else 0.0))
# 同一批樣本但只擷取 8 基本特徵
base_only = [(s[0], [s[1][j] for j in range(len(F_BASE))], s[2]) for s in full_samples]
C_full = run_view_same_set(F_FULL, 'C-full(12 feats, same set)', full_samples)
C_base = run_view_same_set(F_BASE, 'C-base(8 feats, same set)', base_only)

# 裁決
print("\n════ 裁決 ════")
if A and B:
    d = B['rho'] - A['rho']
    print(f"View A OOS ρ={A['rho']:+.4f} (n={A['n']})  vs  View B OOS ρ={B['rho']:+.4f} (n={B['n']})")
    if d > 0.02:
        print(f"✅ 時間特徵加值: +{d:.4f} ρ——B 優於 A")
    elif d < -0.02:
        print(f"❌ 時間特徵冇加值(甚至更差): {d:+.4f}——B 樣本少 + 特徵多 → overfit, 需更多樣本")
    else:
        print(f"⚪ 暫時無分別({d:+.4f})——時間特徵中性, 樣本繼續累積")
    print(f"B 樣本 n={B['n']} 遠細過 A n={A['n']}——統計力差異要留意, 2-4 週後樣本充足再重驗")
elif A:
    print(f"View A ρ={A['rho']:+.4f} PASS——8 基本特徵可 train")
elif B:
    print(f"View B ρ={B['rho']:+.4f}——時間特徵樣本已夠, 但 A 樣本不足")
else:
    print("兩 view 樣本均不足——等數據累積")

# View C 對照: 同批樣本 8 vs 12
if C_full and C_base:
    dc = C_full['rho'] - C_base['rho']
    print(f"\n══ View C(同批樣本, 分離樣本集差異) ══")
    print(f"  8 特徵 ρ={C_base['rho']:+.4f}  vs  12 特徵 ρ={C_full['rho']:+.4f}  → Δ={dc:+.4f}")
    if dc > 0.02:
        print(f"  ✅ 時間特徵喺同批樣本上有加值(+{dc:.4f})")
    elif dc < -0.02:
        print(f"  ❌ 時間特徵喺同批樣本上係負面({dc:+.4f})——過擬合/特徵噪聲")
    else:
        print("  ⚪ 時間特徵暫時中性——同批樣本 8 vs 12 無分別, 繼續累積")
    print(f"  (注意: C 樣本 n={C_full['n']} 細——統計力有限, 2-4 週後重驗)")
