import { getUsage } from './claude.js';
import { buildPayload } from './view.js';
import { handleTelegram, setupWebhook } from './telegram.js';
import { runAlerts } from './alerts.js';

const json = (o, status = 200) =>
  new Response(JSON.stringify(o, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/' || p === '/health') return json({ ok: true, name: 'trmnl-ai-usage', version: env.VERSION || null });

    // Dữ liệu cho TRMNL (Polling) — đếm ngược tính đúng lúc TRMNL lấy dữ liệu
    if (p === '/trmnl') {
      const { data, error } = await getUsage(env);
      return json({ claude: buildPayload(data, error) });
    }

    if (p === '/tg' && req.method === 'POST') return handleTelegram(req, env, ctx);
    if (p === '/setup') return json(await setupWebhook(env, url.origin));

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlerts(env).catch((e) => console.error('alerts', e)));
  },
};
