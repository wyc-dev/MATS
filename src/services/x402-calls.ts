/**
 * v2.0.870-P54: x402 呼叫(CMC + Agent Studio)——比賽硬要求
 *
 * x402 v2 流程(統一):
 *   1. 對 merchant 發 HTTP → 402 + `payment-required` header(base64)
 *   2. `baw x402-payment preview --paymentRequirements <base64>` → paymentId + options
 *   3. 揀 READY_TO_SIGN option
 *   4. `baw x402-payment sign --paymentId <id> --selectedIndex <idx>` → paymentHeaderValue
 *   5. 用 `PAYMENT-SIGNATURE: <value>` header replay → 200 + data
 *
 * CMC(同步):POST https://mcp.coinmarketcap.com/x402/mcp,tools/call 4 個 designated tools
 * Agent Studio(異步):POST /x402/analyze/async → jobId+jobToken → poll → report
 *
 * 紀律:防禦式 parse;sign 前唔 log token;signature 短命(~30s)要即刻 replay。
 */
import { execSync } from 'node:child_process';

export interface X402CallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

const CMC_ENDPOINT = 'https://mcp.coinmarketcap.com/x402/mcp';
const AGENT_STUDIO_ENDPOINT = 'https://stock-agent.bnbchain.org';

/** 4 個 designated CMC tools(只有呢 4 個計入比賽要求) */
export const CMC_DESIGNATED_TOOLS = ['execute_skill', 'get_crypto_metrics', 'get_global_metrics_latest', 'get_upcoming_macro_events'] as const;

function runBaw(cmd: string, timeoutMs: number): string {
  return execSync(cmd, { timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 通用 x402 流程:402 → preview → sign → replay */
async function x402Request(url: string, method: string, body: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30_000) });
  if (res.status !== 402) return res; // 唔係 402 → 直接返(可能已成功或錯誤)

  const paymentRequired = res.headers.get('payment-required');
  if (!paymentRequired) return res;

  // preview
  const previewOut = runBaw(`baw x402-payment preview --paymentRequirements '${paymentRequired}' --json`, 20_000);
  const preview = JSON.parse(previewOut);
  const paymentId = preview?.data?.paymentId;
  const options: Array<{ index: number; status: string }> = preview?.data?.options ?? [];
  const ready = options.find((o) => o.status === 'READY_TO_SIGN');
  if (!paymentId || !ready) {
    throw new Error(`x402 preview: no READY_TO_SIGN option (paymentId=${paymentId ?? 'none'})`);
  }

  // sign
  const signOut = runBaw(`baw x402-payment sign --paymentId ${paymentId} --selectedIndex ${ready.index} --json`, 20_000);
  const sign = JSON.parse(signOut);
  const headerName = sign?.data?.paymentHeaderName ?? 'PAYMENT-SIGNATURE';
  const headerValue = sign?.data?.paymentHeaderValue;
  if (!headerValue) throw new Error('x402 sign: no paymentHeaderValue');

  // replay(即刻,唔好等——signature 短命)
  return fetch(url, {
    method,
    headers: { ...headers, [headerName]: headerValue },
    body,
    signal: AbortSignal.timeout(30_000),
  });
}

/** CMC x402 呼叫(4 個 designated tools 之一) */
export async function cmcCall(tool: string, args: Record<string, unknown> = {}): Promise<X402CallResult> {
  if (!CMC_DESIGNATED_TOOLS.includes(tool as typeof CMC_DESIGNATED_TOOLS[number])) {
    return { success: false, error: `tool '${tool}' not in designated CMC tools` };
  }
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } });
    const res = await x402Request(CMC_ENDPOINT, 'POST', body, { Accept: 'application/json, text/event-stream' });
    const text = await res.text();
    // SSE data: 行 → result.content[0].text
    let data: unknown = text;
    try {
      const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
      if (dataLine) {
        const parsed = JSON.parse(dataLine.slice(5).trim());
        data = parsed?.result?.content?.[0]?.text ?? parsed;
      }
    } catch { /* keep raw text */ }
    return { success: res.ok, data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Agent Studio x402 呼叫(異步兩段式:submit → jobId+jobToken) */
export async function agentStudioAnalyze(symbols: string[]): Promise<X402CallResult> {
  try {
    const body = JSON.stringify({ symbols, analysis_type: 'comprehensive' });
    const res = await x402Request(`${AGENT_STUDIO_ENDPOINT}/x402/analyze/async`, 'POST', body);
    const json = await res.json() as { jobId?: string; jobToken?: string };
    if (!json.jobId || !json.jobToken) {
      return { success: false, error: `no jobId/jobToken (status=${res.status})` };
    }
    return { success: true, data: { jobId: json.jobId, jobToken: json.jobToken } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Agent Studio poll(用 jobId + jobToken 攞 report) */
export async function agentStudioPoll(jobId: string, jobToken: string): Promise<X402CallResult> {
  try {
    const res = await fetch(`${AGENT_STUDIO_ENDPOINT}/x402/jobs/${encodeURIComponent(jobId)}`, {
      headers: { 'X-Job-Token': jobToken },
      signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json() as { status?: string; downloadUrl?: string };
    return { success: res.ok, data: json };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
