import { query, qodercliAuth } from '@qodercn-ai/qodercn-agent-sdk';

const prompt = process.argv[2] ?? 'Reply with exactly: PONG';
const model = process.argv[3];

const opts = {
  auth: qodercliAuth(),
  permissionMode: 'bypassPermissions',
  allowedTools: [],
  maxTurns: 1,
  settingSources: [],
};
if (model) opts.model = model;

const q = query({ prompt, options: opts });
let sawAssistant = false;
try {
  for await (const msg of q) {
    if (msg.type === 'assistant') {
      for (const b of msg.message.content) {
        if (b.type === 'text' && b.text.trim()) {
          sawAssistant = true;
          process.stdout.write('ASSISTANT: ' + b.text.trim() + '\n');
        }
      }
    } else if (msg.type === 'result') {
      console.log('RESULT subtype=' + msg.subtype +
        ' cost=$' + (msg.total_cost_usd ?? 0) +
        ' credits=' + (msg.total_credits ?? 0) +
        ' in=' + (msg.usage?.input_tokens ?? 0) +
        ' out=' + (msg.usage?.output_tokens ?? 0));
      if (msg.errors?.length) console.log('ERRORS: ' + JSON.stringify(msg.errors).slice(0, 600));
      if (msg.subtype === 'success') console.log('RESULT_TEXT: ' + JSON.stringify(String(msg.result ?? '')).slice(0, 400));
    } else if (msg.type === 'system') {
      console.log('SYSTEM ' + (msg.subtype ?? '') + (msg.model ? ' model=' + msg.model : ''));
    }
  }
  if (!sawAssistant) console.log('(no assistant text)');
} catch (e) {
  console.log('THREW:', e?.constructor?.name, e?.message);
} finally {
  q.close();
}
