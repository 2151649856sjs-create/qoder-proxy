import { query, qodercliAuth } from '@qodercn-ai/qodercn-agent-sdk';

// Probe: what do partial/stream messages look like, and where does text live?
const q = query({
  prompt: 'Count from 1 to 5, comma separated, nothing else.',
  options: {
    auth: qodercliAuth(),
    permissionMode: 'bypassPermissions',
    allowedTools: [],
    maxTurns: 1,
    settingSources: [],
    includePartialMessages: true,
    model: 'DeepSeek-V4-Pro',
  },
});

const seen = new Map();
try {
  for await (const msg of q) {
    const key = msg.type + '/' + (msg.subtype ?? '') + '/' + (msg.event?.type ?? '');
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (msg.type === 'stream_event' || msg.event) {
      console.log('STREAM', JSON.stringify(msg).slice(0, 380));
    } else if (msg.type === 'assistant') {
      for (const b of msg.message.content) {
        if (b.type === 'text') console.log('ASSISTANT text: ' + b.text.slice(0, 200));
      }
    } else if (msg.type === 'result') {
      console.log('RESULT', msg.subtype, 'credits=', msg.total_credits);
    }
  }
} catch (e) {
  console.log('THREW', e?.message);
} finally { q.close(); }

console.log('--- message type histogram ---');
for (const [k, v] of seen) console.log(v + '  ' + k);
