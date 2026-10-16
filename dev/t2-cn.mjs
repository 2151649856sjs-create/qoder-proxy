import { query, qodercliAuth } from '@qodercn-ai/qodercn-agent-sdk';

const q = query({
  prompt: 'Reply with exactly: PONG',
  options: {
    auth: qodercliAuth(),
    permissionMode: 'bypassPermissions',
    allowedTools: [],
    maxTurns: 1,
  },
});
try {
  for await (const msg of q) {
    if (msg.type === 'assistant') {
      for (const b of msg.message.content) if (b.type === 'text') process.stdout.write('ASSISTANT: ' + b.text + '\n');
    } else if (msg.type === 'result') {
      console.log('RESULT', msg.subtype, 'errors=', JSON.stringify(msg.errors ?? []).slice(0,400), 'cost=', msg.total_cost_usd, 'credits=', msg.total_credits);
    } else {
      console.log('MSG', msg.type, msg.subtype ?? '');
    }
  }
} catch (e) {
  console.log('THREW:', e?.constructor?.name, e?.message);
} finally { q.close(); }
