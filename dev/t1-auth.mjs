/**
 * dev/t1-auth.mjs — is the Qoder SDK authenticated at all?
 *
 * This probe deliberately imports the **Global** SDK (`@qoder-ai/qoder-agent-sdk`)
 * rather than the CN one the server uses. Its purpose was to prove that a Global
 * SDK build cannot see a CN IDE's login state (`.qoder` vs `.qoder-cn`), which is
 * why the project settled on `@qodercn-ai/qodercn-agent-sdk`.
 *
 * Prerequisite: the Global SDK must be installed separately, e.g.
 *   npm i -D @qoder-ai/qoder-agent-sdk
 * It is intentionally NOT a runtime dependency of this repo.
 */
import { query, qodercliAuth } from '@qoder-ai/qoder-agent-sdk';

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
    console.log('MSG', msg.type, msg.subtype ?? '', JSON.stringify(msg).slice(0, 600));
  }
} catch (e) {
  console.log('THREW:', e?.constructor?.name, e?.message);
} finally {
  q.close();
}
