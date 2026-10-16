/**
 * t5-usage.mjs — dump every usage-shaped field the Qoder SDK exposes.
 *
 * Question: does the SDK report real token counts, or only credits? The DSH
 * usage badge reads usage.prompt_tokens / completion_tokens, so we need to know
 * whether those numbers exist upstream or must be estimated locally.
 */
import { query, qodercliAuth } from '@qodercn-ai/qodercn-agent-sdk';

const q = query({
  prompt: 'say exactly: USAGE_PROBE_OK',
  options: {
    auth: qodercliAuth(),
    model: 'Auto',
    maxTurns: 1,
    permissionMode: 'bypassPermissions',
    allowedTools: [],
    settingSources: [],
    persistSession: false,
    includePartialMessages: true,
  },
});

const seen = new Set();
let resultMsg = null;

for await (const msg of q) {
  // Record any key path that looks like a token/usage counter.
  const walk = (obj, path = '') => {
    if (obj === null || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (/usage|token|credit/i.test(k)) {
        const line = `${p} = ${JSON.stringify(v)}`;
        if (!seen.has(line)) {
          seen.add(line);
          console.log('  ', line.slice(0, 400));
        }
      }
      if (v && typeof v === 'object' && path.split('.').length < 3) walk(v, p);
    }
  };
  walk(msg);
  if (msg.type === 'result') resultMsg = msg;
}

console.log('\n=== raw result message (usage/credits fields) ===');
if (resultMsg) {
  const pick = {};
  for (const [k, v] of Object.entries(resultMsg)) {
    if (/usage|token|credit|cost|duration/i.test(k)) pick[k] = v;
  }
  console.log(JSON.stringify(pick, null, 2));
  console.log('\nall result keys:', Object.keys(resultMsg).join(', '));
} else {
  console.log('no result message seen');
}
try { q.close(); } catch {}
