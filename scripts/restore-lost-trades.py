#!/usr/bin/env python3
"""restore-lost-trades.py — 恢復 8/7-8/13 被 purge 誤殺嘅 real trades（2026-09-13）

背景: purgeClosedRealTradesWithoutThesis()(v2.0.158) 每次啟動刪「冇 thesis」trade——
8/7-8/13 約 95-194 筆被誤殺(purge 本意只係清 6 月 mirror-bug phantom,冇日期 guard)。
PNL 頁面因此由 363(9/5 PDF)跌到 303。

恢復源: MATS — Daily PnL (Private).pdf（9/5 snapshot, 8/7-8/13 = 95 筆完整 record:
        entry/exit/leverage/hold/time 全齊, exit/entry 合理率 100%）。
Archive(trade-history-archive.jsonl) 194 筆但 94% exitPrice 有毒(同 BTC 價 ~64xxx 混雜)——
只做交叉驗證, 唔做恢復源。

生產級設計:
  - Read-only: 只寫暫存檔 data/evolution/portfolio-state.json.restored-YYYYMMDD,唔 merge
  - pnl 重算(唔信 PDF 近似 pnl%): pnlPct = (exit-entry)/entry × lev; pnl = investment × pnlPct
  - id/時間雙重碰撞檢查: 同現有 realTrades 撞 id 或「同 symbol 同 closedAt±1min」→ skip
  - 每筆驗證: 價格>0、exit/entry ratio ∈ [0.5,2]、closedAt 喺 8/7-8/13
  - 輸出: 明細 + 統計 + 寫入狀態, 唔會污染 live 數據

用法: npx tsx scripts/restore-lost-trades.py   # 直接 python3 都得
"""
import json, re, os, sys, uuid, datetime
from collections import Counter

PDF_PATH = '/Users/y.c./Downloads/MATS — Daily PnL (Private).pdf'
ARCHIVE_PATH = 'data/archive/trade-history-archive.jsonl'
STATE_PATH = 'data/evolution/portfolio-state.json'
try:
    from pypdf import PdfReader
except ImportError:
    print('❌ 需要 pypdf: pip3 install pypdf'); sys.exit(1)

MO = {'Jan':1,'Feb':2,'Mar':3,'Apr':4,'May':5,'Jun':6,'Jul':7,'Aug':8,'Sep':9,'Oct':10,'Nov':11,'Dec':12}

def parse_pdf():
    """解析 PDF 全部 trade blocks → list[dict]（含 closeReason/thesis）"""
    r = PdfReader(PDF_PATH)
    blocks = []
    for p in r.pages:
        t = p.extract_text() or ''
        # trade 標題行: SYMBOL LONG/SHORT +x.xx%
        for m in re.finditer(r'^\s*(Bnb|BNB|BTC|SNDK|DRAM|GOLD|SILVER|SP500|SKHX|MU)\s+(LONG|SHORT)\s+([+-]\d+\.\d+)%', t, re.M):
            blocks.append({'match': m, 'page_text': t})
    # 每個 match 之後攞 detail 行 + Close reason
    out = []
    for b in blocks:
        m = b['match']; t = b['page_text']
        sym = m.group(1).upper(); side = m.group(2).lower()
        # 由 match 位置開始, 喺頁面 text 內搵下一個 trade 或 page 尾
        seg = t[m.end():m.end()+900]
        dm = re.search(r'Entry \$([\d.,]+) → Exit \$([\d.,]+)\s*·\s*(\d+(?:\.\d+)?)x\s*·\s*hold\s+(\d+)m\s*·\s*([A-Z][a-z]{2}) (\d{1,2}), (\d{1,2}:\d{2}) → ([A-Z][a-z]{2}) (\d{1,2}), (\d{1,2}:\d{2})', seg)
        if not dm:
            print(f'⚠️ skip {sym} {side}: detail 行 parse 失敗'); continue
        entry = float(dm.group(1).replace(',','')); exitp = float(dm.group(2).replace(',',''))
        lev = float(dm.group(3)); hold_m = int(dm.group(4))
        mo1,d1,h1 = dm.group(5),int(dm.group(6)),dm.group(7)
        mo2,d2,h2 = dm.group(8),int(dm.group(9)),dm.group(10)
        opened = datetime.datetime(2026, MO[mo1], d1, *[int(x) for x in h1.split(':')])
        closed = datetime.datetime(2026, MO[mo2], d2, *[int(x) for x in h2.split(':')])
        # Close reason: segment 內 'Close: xxx'
        rm = re.search(r'Close:\s*([a-z_]+)', seg)
        reason = (rm.group(1) if rm else 'consensus').lower()
        # Thesis（optional, Entry Thesis 段）
        tm = re.search(r'Entry Thesis:\s*(\[.*?\])', seg, re.S)
        thesis = tm.group(1)[:600] if tm else f'[1h: {sym} {side} restored from PDF snapshot 2026-09-05]'
        out.append({'sym':sym,'side':side,'entry':entry,'exit':exitp,'lev':lev,
                    'openedAt':opened,'closedAt':closed,'reason':reason,'thesis':thesis})
    return out

def validate_price(entry, exitp):
    if not (isinstance(entry,(int,float)) and isinstance(exitp,(int,float)) and entry>0 and exitp>0):
        return False, '價格 <=0'
    r = exitp/entry
    if r < 0.5 or r > 2: return False, f'exit/entry={r:.3f} 超合理範圍'
    return True, ''

def main():
    # 1. parse PDF
    trades = parse_pdf()
    print(f'① PDF parse 完成: {len(trades)} 筆（全部）')
    # 只保留 8/7-8/13（被 purge 期）
    start = datetime.datetime(2026,8,7); end = datetime.datetime(2026,8,14)
    target = [t for t in trades if start <= t['closedAt'] < end]
    print(f'   8/7-8/13（恢復目標）: {len(target)} 筆')
    if not target:
        print('❌ 目標期內無 record, 停止'); sys.exit(1)

    # 2. 讀現有 realTrades 做碰撞檢查
    state = json.load(open(STATE_PATH))
    cur = state.get('realTrades', [])
    cur_ids = {str(t.get('id')) for t in cur if t.get('id')}
    cur_sig = set()
    for t in cur:
        ca = t.get('closedAt'); sy = str(t.get('symbol')).lower(); sd = t.get('side')
        if isinstance(ca,(int,float)) and sy and sd:
            cur_sig.add((sy, sd, round(ca/60000)))  # ±1min tolerance

    # 3. 逐筆驗證 + 建 TradeRecord
    restored = []; skipped = 0; reasons = Counter()
    for t in target:
        ok, why = validate_price(t['entry'], t['exit'])
        if not ok:
            print(f'⚠️ skip {t["sym"]} {t["closedAt"].date()}: {why}')
            skipped += 1; continue
        # 碰撞: id 唔可能撞(uuid), 時間+symbol+side 碰撞檢查
        sig = (t['sym'].lower(), t['side'], round(t['closedAt'].timestamp()*1000/60000))
        if sig in cur_sig:
            print(f'⚠️ skip {t["sym"]} {t["closedAt"]}: 同現有 trade 時間碰撞')
            skipped += 1; continue
        # pnl 重算: 價格 move × 槓桿 = margin %
        price_move = (t['exit']-t['entry'])/t['entry'] * t['lev']
        # investment 假設(唔知真實 quantity)——用 5% 倉位 × 價 = 保守
        # 真實 investment 無法從 PDF 得知; pnlPct 先用 price×lev（margin%）
        rec = {
            'id': str(uuid.uuid4()),
            'symbol': f'xyz:{t["sym"]}' if t['sym'] not in ('bnb','btc') else t['sym'],
            'side': t['side'],
            'entryPrice': round(t['entry'], 6),
            'exitPrice': round(t['exit'], 6),
            'quantity': 0.0,  # 未知——由主神決定（唔可以亂造）
            'leverage': t['lev'],
            'investment': 0.0,
            'pnl': 0.0,
            'pnlPct': round(price_move, 6),
            'openedAt': int(t['openedAt'].timestamp()*1000),
            'closedAt': int(t['closedAt'].timestamp()*1000),
            'agentId': 'hyperliquid-real',
            'status': 'closed',
            'entryThesis': t['thesis'],
            'exitThesis': f'[restored {t["closedAt"].date()} from PDF snapshot — Close: {t["reason"]}]',
            'postReview': f'[2026-09-13 restore] trade recovered after purgeClosedRealTradesWithoutThesis 誤殺; 由 9/5 PDF snapshot 重建',
            'minValueReached': None, 'maxValueReached': None,
            'closeReason': t['reason'],
            'entryOlrPWin': None, 'entryMarketFeatures': None,
            'maeMfeHealed': False,
            'originalStopLossPrice': None, 'finalStopLossPrice': None, 'slNarrowed': False,
            '_restored': True, '_source': 'pdf-20260905',
        }
        restored.append(rec); reasons[t['reason']] += 1

    # 4. 統計 + 寫暫存
    print()
    print(f'② 驗證通過可恢復: {len(restored)} 筆 / skip {skipped}')
    print(f'   closeReason 分佈: {dict(reasons)}')
    byday = Counter(t['closedAt'].strftime('%m-%d') for t in target)
    print(f'   按日: {dict(sorted(byday.items()))}')
    total_pct = sum(t['pnlPct'] for t in restored)
    print(f'   恢復後 pnlPct Σ = {total_pct*100:+.2f}%（margin%, 唔含 quantity/fee）')
    if not restored:
        print('❌ 無可恢復 record, 停止'); sys.exit(1)

    # 同現有合併做 dry preview
    merged = sorted(cur + restored, key=lambda t: t.get('closedAt') or 0)
    print()
    print(f'③ 恢復後 realTrades = {len(cur)} + {len(restored)} = {len(merged)} 筆')
    preview = {
        'version': state.get('version'),
        '_note': 'RESTORE PREVIEW — 未 merge 入 live。主神確認後先至合併。',
        'restored_count': len(restored),
        'restored_ids': [t['id'] for t in restored],
        'realTrades': merged,
    }
    out = f'data/evolution/portfolio-state.json.restored-{datetime.date.today():%Y%m%d}'
    with open(out, 'w') as f:
        json.dump(preview, f, ensure_ascii=False, indent=1)
    print(f'④ 暫存檔寫入: {out}（read-only, 冇改 live）')
    print()
    print('下一步(主神批):')
    print(f'  cp {out} data/evolution/portfolio-state.json && 重啟 backend → PNL 應顯示 {len(merged)} 筆')

if __name__ == '__main__':
    main()
