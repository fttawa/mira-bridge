// 诊断脚本共用：解析上游 mirasim-router 的地址。
// 它的端口跨重启会变，不能写死 —— 优先问运行中的 bridge 的 /healthz，
// 那里返回的就是 bridge 当前认定的上游端口。
export async function routerUrl() {
  if (process.env.ROUTER_URL) return process.env.ROUTER_URL.replace(/\/+$/, '');

  const bridge = (process.env.BRIDGE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  try {
    const r = await fetch(`${bridge}/healthz`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    if (j.router) return `http://${j.router}`;
  } catch { /* bridge 没起，落到下面报错 */ }

  throw new Error('无法确定上游地址：请先启动 mira-bridge，或显式设置 ROUTER_URL 环境变量');
}
