#!/usr/bin/env node
/**
 * watchdog — 看门狗：bridge / 隧道掉了就拉起来
 *
 * 背景：2026-09-25 bridge 两次「静默消失」——requests.log 最后一条是正常 200，
 * 之后端口无人监听，且没有任何 JS 层退出痕迹（连 process_exit 墓碑都没有），
 * 说明是被硬杀（TerminateProcess 不跑 JS 钩子），不是崩栈。与其猜是谁杀的，
 * 不如让服务自己回来。
 *
 * 用法（隐藏启动、脱离调用者的进程树）：
 *   wscript.exe 隐藏运行 → node tools/watchdog.mjs
 * 每 BRIDGE_WATCHDOG_INTERVAL_MS（默认 30s）检查一次：
 *   - 127.0.0.1:8787 是否在监听（bridge）
 *   - cloudflared.exe 是否在跑（隧道）
 * 缺哪个补哪个，并把动作写进 watchdog.log。
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOG = process.env.BRIDGE_WATCHDOG_LOG || path.join(ROOT, 'watchdog.log');
const INTERVAL = Number(process.env.BRIDGE_WATCHDOG_INTERVAL_MS || 30_000);
const PORT = Number(process.env.BRIDGE_PORT || 8787);
const NODE = process.execPath;
const TUNNEL_EXE = process.env.BRIDGE_TUNNEL_EXE || 'C:\\Users\\fttawa\\bin\\cloudflared.exe';
const TUNNEL_CFG = process.env.BRIDGE_TUNNEL_CFG || 'C:\\Users\\fttawa\\.cloudflared\\mira.yml';
const DRY = process.env.BRIDGE_WATCHDOG_DRY === '1';
// 定时重启：默认每小时一次（0 = 关闭）。目的是把长跑累积的碎片状态清掉。
// 关键：**有在途请求就等**，最多推迟 BRIDGE_RESTART_MAX_DEFER_MS —— 免得一刀砍掉
// 客户端正在跑的流（实测单条流可以跑 30–100 秒）。
const RESTART_MS = Number(process.env.BRIDGE_RESTART_INTERVAL_MS ?? 3_600_000);
const RESTART_MAX_DEFER = Number(process.env.BRIDGE_RESTART_MAX_DEFER_MS ?? 600_000);
let deferSince = 0;

const log = (msg, extra) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), msg, ...(extra ?? {}) });
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* 日志失败不影响看护 */ }
  if (process.env.BRIDGE_WATCHDOG_VERBOSE === '1') console.log(line);
};

const portOpen = (port, host = '127.0.0.1', timeout = 5000) => new Promise((resolve) => {
  const sock = net.connect({ port, host });
  const done = (v) => { sock.destroy(); resolve(v); };
  sock.setTimeout(timeout);
  sock.once('connect', () => done(true));
  sock.once('timeout', () => done(false));
  sock.once('error', () => done(false));
});

/** 存活判定：TCP 能连 **或** /healthz 有响应就算活着。
 *  只看 TCP 会误判 —— 实测 bridge 在处理超大 payload 时事件循环短暂卡顿，
 *  2 秒的 connect 超时就被当成"服务没了"，于是又拉起一个（新实例端口被占随即退出），
 *  日志里刷出成片的 bridge_down_restarting。HTTP 探活更贴近"能不能干活"。 */
async function bridgeAlive() {
  if (await portOpen(PORT)) return true;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

const tunnelRunning = () => {
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq cloudflared.exe', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    return /cloudflared\.exe/i.test(r.stdout ?? '');
  } catch { return true; } // 查不到就不折腾（宁可漏救，不可重复拉起）
};

/** 脱离本进程启动：detached + 忽略 stdio，父进程死了也不受影响。 */
function launch(label, file, args, cwd = ROOT, env = null) {
  if (DRY) { log('would_launch', { label, file, args }); return; }
  try {
    const child = spawn(file, args, {
      cwd, detached: true, stdio: 'ignore', windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.unref();
    log('launched', { label, pid: child.pid });
  } catch (e) {
    log('launch_failed', { label, error: String(e.message) });
  }
}

const startBridge = () => {
  // 走 start-8787.cmd 而不是直接起 node：那条路会设好出站代理环境变量
  // （NODE_USE_ENV_PROXY 必须在 bootstrap 生效，直接起 node 会多一次自重启），
  // 并且把 stdout/stderr 落到 bridge.task.log —— 看门狗拉起的实例也要能留下崩溃现场。
  // BRIDGE_PORT 显式带上：看门狗监听的端口与脚本默认端口可能不同（隔离测试时用）。
  const env = { BRIDGE_PORT: String(PORT) };
  if (process.platform === 'win32') {
    launch('bridge', 'cmd.exe', ['/c', path.join(ROOT, 'start-8787.cmd')], ROOT, env);
  } else {
    launch('bridge', NODE, [path.join(ROOT, 'server.mjs')], ROOT, env);
  }
};
const startTunnel = () => launch('tunnel', TUNNEL_EXE, [
  '--protocol', process.env.BRIDGE_TUNNEL_PROTOCOL || 'http2',
  '--config', TUNNEL_CFG,
  '--logfile', path.join(ROOT, 'tunnel.log'), // 看门狗拉起的隧道也要留日志（否则查不到边缘握手失败）
  '--loglevel', 'info',
  'tunnel', 'run',
]);

log('watchdog_start', { pid: process.pid, port: PORT, intervalMs: INTERVAL, restartEveryMs: RESTART_MS || null });

// 同一时间只允许一次拉起尝试，避免检查周期与启动耗时重叠时连环补
let bridgeStarting = false;
let tunnelStarting = false;

/** 取端口占用者的 PID（Windows 用 netstat -ano 解析；失败返回 null）。 */
function pidOnPort(port) {
  try {
    const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    for (const line of (r.stdout ?? '').split('\n')) {
      const m = line.match(new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i'));
      if (m) return Number(m[1]);
    }
  } catch { /* 忽略 */ }
  return null;
}

/** 读 bridge 自己的 /stats（本机直连，不需要 key）。 */
async function bridgeStats() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/stats`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** 定时重启：空闲才动手；有在途请求就推迟（最多 RESTART_MAX_DEFER）。 */
async function maybeScheduledRestart() {
  if (!RESTART_MS) return;
  const s = await bridgeStats();
  if (!s?.status) return; // 拿不到统计（老版本/端口没起）就不折腾
  const uptimeSec = Number(s.status.uptimeSec ?? 0);
  if (uptimeSec * 1000 < RESTART_MS) { deferSince = 0; return; }
  const active = Number(s.status.activeUpstreamRequests ?? 0);
  if (active > 0) {
    if (!deferSince) deferSince = Date.now();
    if (Date.now() - deferSince < RESTART_MAX_DEFER) {
      log('restart_deferred', { uptimeSec, active });
      return;
    }
    log('restart_forced', { uptimeSec, active, deferredMs: Date.now() - deferSince });
  }
  deferSince = 0;
  const pid = pidOnPort(PORT);
  log('scheduled_restart', { uptimeSec, active, pid });
  if (DRY) return;
  if (pid) { try { process.kill(pid); } catch { /* 已经没了 */ } }
  // 等端口释放（最多 15s），再拉起新实例
  for (let i = 0; i < 30; i++) {
    if (!(await portOpen(PORT))) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  // 标记"正在拉起"，免得同一轮 tick 的"端口没监听"分支再补一发（实测会双开，
  // 第二个实例因端口被占而退出，白白留一条 EADDRINUSE 日志）。
  bridgeStarting = true;
  setTimeout(() => { bridgeStarting = false; }, 20_000);
  startBridge();
}

const tick = async () => {
  const up = await bridgeAlive();
  if (!up) {
    if (bridgeStarting) {
      log('bridge_still_down');
    } else {
      bridgeStarting = true;
      log('bridge_down_restarting', { port: PORT });
      startBridge();
      setTimeout(() => { bridgeStarting = false; }, 20_000);
    }
  } else {
    await maybeScheduledRestart();
  }
  if (!tunnelRunning()) {
    if (!tunnelStarting) {
      tunnelStarting = true;
      log('tunnel_down_restarting');
      startTunnel();
      setTimeout(() => { tunnelStarting = false; }, 60_000);
    }
  }
};

await tick();
setInterval(() => { tick().catch((e) => log('tick_error', { error: String(e.message) })); }, INTERVAL);
