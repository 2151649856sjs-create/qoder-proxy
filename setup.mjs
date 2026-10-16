#!/usr/bin/env node
/**
 * setup.mjs — bootstrap Qoder CN login for THIS machine.
 *
 * Qoder's own SDK ships a CLI entry (qoder-worker-runtime.obf.mjs) that performs
 * an official device-code login. We simply invoke it so the user's OWN Qoder
 * account credential lands in the system credential store — the proxy then reads
 * it via qodercliAuth().
 *
 * Nothing here references a shared or remote credential; it uses whatever Qoder
 * account the operator logs in with. If the SDK CLI is unavailable it prints the
 * manual command and exits 0.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function findCli() {
  const p = joinPaths(here, 'node_modules', '@qodercn-ai', 'qodercn-agent-sdk', 'dist', '_worker', 'qoder-worker-runtime.obf.mjs');
  return existsSync(p) ? p : null;
}
function joinPaths(...parts) {
  return parts.reduce((a, b) => (a ? a + '\\' + b : b));
}

function main() {
  const cli = findCli();
  if (!cli) {
    console.error('[setup] 未找到 qoder worker runtime。请先运行 npm install。');
    console.error('[setup] 然后手动登录：  npx qodercn login');
    console.error('[setup] 或： node node_modules/@qodercn-ai/qodercn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs login');
    process.exit(0);
  }
  console.log('[setup] 启动 Qoder 官方设备码登录……');
  console.log('[setup] 浏览器打开提示的链接，确认登录（用你自己的 Qoder 账号）。');
  const node = process.execPath;
  const r = spawnSync(node, [cli, 'login'], { stdio: 'inherit', windowsHide: true });
  if (r.status === 0) {
    console.log('[setup] 登录成功。凭据已存入系统凭据管理器。');
    console.log('[setup] 现在可以运行：  npm start   （或 node server.mjs）');
  } else {
    console.error('[setup] 登录命令退出码 ' + r.status + '。请按上方提示重试。');
    process.exit(0);
  }
}

main();
