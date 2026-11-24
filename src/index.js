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
    // Chẩn đoán đường tới Telegram: token giả (phải trả 401/404 nhanh) và token thật (getMe), có đo thời gian
    if (p === '/diag/tg') {
      const out = {};
      for (const [k, tok] of [['fake', '123456:fake'], ['real', env.TELEGRAM_BOT_TOKEN || '']]) {
        const t0 = Date.now();
        try {
          const r = await fetch(`https://api.telegram.org/bot${tok}/getMe`);
          const j = await r.json().catch(() => null);
          out[k] = { status: r.status, ms: Date.now() - t0, desc: j?.description || null, bot: j?.result?.username || null };
        } catch (e) { out[k] = { err: String(e), ms: Date.now() - t0 }; }
      }
      const tk = env.TELEGRAM_BOT_TOKEN || '';
      out.token_shape = { len: tk.length, has_colon: tk.includes(':'), has_space: /\s/.test(tk), starts_bot: /^bot/i.test(tk) };
      out.colo = req.cf?.colo || null;
      return json(out);
    }

    if (p === '/setup') return json(await setupWebhook(env, url.origin));

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlerts(env).catch((e) => console.error('alerts', e)));
  },
};
