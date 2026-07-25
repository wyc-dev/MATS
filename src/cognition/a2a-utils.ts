// ─── A2A Utility Functions ───
// Tools for parsing, formatting, and validating A2A (Agent-to-Agent) signals

import type { A2ASignal, A2AMessageType } from '../types/index.ts';

/**
 * Parse A2A signal from raw text content
 * Recognizes patterns: OBS:, ASSESS:, PROP:, CONCERN:, Q:, AGR:, DIS:, CONSENSUS:
 *
 * @param content Raw text that may contain A2A signal
 * @returns Parsed A2A signal or null if no match found
 */
export function parseA2ASignal(content: string): A2ASignal | null {
  if (!content || typeof content !== 'string') return null;

  const trimmed = content.trim();

  // Pattern map for different A2A message types
  const patterns: Record<A2AMessageType, RegExp> = {
    OBS: /^OBS:\s*(\w+)\s+(.*?)(?=\||$)/i,
    ASSESS: /^ASSESS:\s*(\w+)\s+(\w+)\s+conf=([0-9.]+)/i,
    PROP: /^PROP:\s*(buy|sell|hold)\s+([0-9.]+)%\s+(\w+)/i,
    CONCERN: /^CONCERN:\s*(\w+)\s*(🟢|🟡|🟠|🔴)?\s*(.+)/i,
    Q: /^Q:\s*(@\w+)?\s*(.+)/i,
    AGR: /^AGR:\s*(\w+)\s+(.+?)(?:\||$)/i,
    DIS: /^DIS:\s*(\w+)\s+(.+?)(?:\||$)/i,
    CONSENSUS: /^CONSENSUS:\s*(buy|sell|hold)\s+confidence=([0-9.]+)/i,
  };

  // Try to match each pattern
  for (const [type, pattern] of Object.entries(patterns)) {
    const match = trimmed.match(pattern);
    if (match) {
      const signal: A2ASignal = {
        type: type as A2AMessageType,
        keyword: match[1] || '',
        content: match[2] || match[3] || '',
        metrics: {},
      };

      // Extract numeric values from content
      const numericMatches = signal.content.matchAll(/([a-z_]+)=([0-9.]+)/gi);
      for (const nm of numericMatches) {
        const key = nm[1];
        const value = nm[2];
        if (key && value) {
          signal.metrics![key.toLowerCase()] = parseFloat(value);
        }
      }

      // Extract confidence for OBS, ASSESS, etc.
      const confMatch = trimmed.match(/conf=([0-9.]+)/i);
      if (confMatch && confMatch[1]) {
        signal.confidence = parseFloat(confMatch[1]);
      }

      // Extract severity for CONCERN
      const severityMatch = trimmed.match(/(🟢|🟡|🟠|🔴)/);
      if (severityMatch) {
        const iconMap = { '🟢': 'low', '🟡': 'medium', '🟠': 'high', '🔴': 'critical' };
        signal.severity = iconMap[severityMatch[1] as keyof typeof iconMap] as any;
      }

      // Extract urgency for PROP
      const urgencyMatch = trimmed.match(/(immediate|soon|patient)/i);
      if (urgencyMatch && urgencyMatch[1]) {
        signal.urgency = urgencyMatch[1].toLowerCase() as any;
      }

      return signal;
    }
  }

  return null;
}

/**
 * Format A2A signal back to compact string representation
 * Useful for logging and display
 *
 * @param signal Parsed A2A signal
 * @returns Formatted string
 */
export function formatA2ASignal(signal: A2ASignal): string {
  const base = `${signal.type}: ${signal.keyword} ${signal.content}`;

  const parts = [base];

  if (signal.metrics && Object.keys(signal.metrics).length > 0) {
    const metricStr = Object.entries(signal.metrics)
      .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`)
      .join(', ');
    parts.push(`[${metricStr}]`);
  }

  if (signal.confidence !== undefined) {
    parts.push(`conf=${signal.confidence.toFixed(2)}`);
  }

  if (signal.severity) {
    const iconMap = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };
    parts.push(iconMap[signal.severity]);
  }

  if (signal.urgency) {
    parts.push(`[${signal.urgency}]`);
  }

  return parts.join(' ');
}

/**
 * Extract numeric metrics from A2A signal content
 *
 * @param content Signal content string
 * @returns Extracted metrics as key-value pairs
 */
/**
 * Validate A2A signal format compliance
 * Checks for required fields based on signal type
 *
 * @param signal Signal to validate
 * @returns Validation result with any errors
 */
/**
 * Build A2A signal from components
 * Convenient builder for creating signals programmatically
 *
 * @param type Message type
 * @param keyword Primary keyword
 * @param content Content/description
 * @param options Additional options
 * @returns Constructed A2A signal
 */
export function buildA2ASignal(
  type: A2AMessageType,
  keyword: string,
  content: string,
  options: {
    metrics?: Record<string, number>;
    confidence?: number;
    severity?: 'low' | 'medium' | 'high' | 'critical';
    urgency?: 'immediate' | 'soon' | 'patient';
  } = {}
): A2ASignal {
  return {
    type,
    keyword,
    content,
    metrics: options.metrics,
    confidence: options.confidence,
    severity: options.severity,
    urgency: options.urgency,
  };
}

/**
 * Merge multiple A2A signals for consensus
 * Useful when multiple agents contribute to one consensus statement
 *
 * @param signals Array of A2A signals to merge
 * @returns Merged signal combining key information
 */
/**
 * Convert A2A signal to compact log string for observability
 *
 * @param signal A2A signal
 * @param agentRole Optional agent role for context
 * @returns Compact log string
 */
/**
 * HMM-specific signal helper
 * Creates structured ASSESS signal for regime changes
 *
 * @param state HMM state (S1, S2, S3)
 * @param transitionProb Probability to next state
 * @param volatilityForecast 24h volatility forecast
 * @param confidence Signal confidence
 * @returns A2A ASSESS signal
 */
/**
 * Earnings Volatility specific signal helper
 * Creates structured OBS signal for vol events
 *
 * @param ivSpike IV spike percentage
 * @param postEarningsDecay Whether decay is observed
 * @param confidence Signal confidence
 * @returns A2A OBS signal
 */
