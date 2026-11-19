/**
 * D-48: no AI attribution anywhere ARIMA or its builders produce: no `Co-Authored-By` trailer
 * naming Claude or Anthropic, no "Generated with ..." line, no AI-contributor credit, in any
 * commit message or pull request body (the owner's repositories are reviewed by employers).
 * One function, used by the publish script, the commit-msg hook (WP-113) and the PR validator.
 */

const PATTERNS: [string, RegExp][] = [
  [
    'a Co-Authored-By trailer naming an AI',
    /co-authored-by:[^\r\n]*(claude|anthropic|\bai\b|gpt|copilot|gemini|openai|noreply@anthropic)/i,
  ],
  [
    'a "Generated with" line',
    /generated\s+(?:with|by|using)\s+(?:\[?claude|\[?an?\s+ai|\[?chatgpt|\[?copilot|\[?gemini)/i,
  ],
  ['a Claude Code link or badge', /claude\.com\/claude-code|claude\.ai\/code|🤖\s*generated/i],
  [
    'an AI-contributor credit',
    /\b(?:written|authored|created|co-?authored)\s+(?:with|by)\s+(?:claude|anthropic|chatgpt|copilot|an ai)\b/i,
  ],
];

/** What is wrong with `text`, as readable names (never the text itself); empty when it is clean. */
export function findAttribution(text: string): string[] {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}
