import { getUsage } from './claude.js';
import { buildPayload, buildExt, claudeRow } from './view.js';
import { handleIngest, getExternal, maybeDispatch, EXT } from './external.js';
import { hhmm, stamp } from './util.js';
import { handleTelegram, setupWebhook } from './telegram.js';
import { runAlerts } from './alerts.js';

const json = (o, status = 200) =>
  new Response(JSON.stringify(o, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// Telegram có thể tạm khoá bot mới tạo (lỗi 429). Cron tự thử nối webhook mỗi 10 phút tới khi được,
// rồi nhắn chủ bot. Origin lấy từ lần gọi /setup gần nhất (GitHub Actions gọi sau mỗi lần deploy).
async function autoConnect(env) {
  if (!env.TELEGRAM_BOT_TOKEN || (await env.KV.get('tg:ready')) === env.TELEGRAM_BOT_TOKEN.split(':')[0]) return;
  const origin = (await env.KV.get('origin')) || 'https://trmnl-ai-usage.meohocgioi.workers.dev';
  const r = await setupWebhook(env, origin, { welcome: true });
  if (r.ok) await env.KV.put('tg:ready', env.TELEGRAM_BOT_TOKEN.split(':')[0]);
}

// Toàn bộ dữ liệu cho màn hình TRMNL: Claude (chi tiết) + các dịch vụ khác đã cài cookie
export async function screenPayload(env, data, error, now = Date.now()) {
  const claude = buildPayload(data, error, now);
  const ext = await getExternal(env);
  const rows = [claudeRow(claude)];
  for (const k of EXT) {
    const r = buildExt(k, ext[k], now);
    if (r) rows.push(r);
  }
  return { updated: hhmm(now), updated_full: stamp(now), multi: rows.length > 1, count: rows.length, rows, claude };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/' || p === '/health') return json({ ok: true, name: 'trmnl-ai-usage', version: env.VERSION || null });

    // Dữ liệu cho TRMNL (Polling) — đếm ngược tính đúng lúc TRMNL lấy dữ liệu
    if (p === '/trmnl') {
      // Số liệu được cron làm mới mỗi 5 phút; TRMNL chỉ gọi claude.ai khi bản lưu đã cũ hơn 10 phút
      const { data, error } = await getUsage(env, { maxAge: 10 * 60000 });
      return json(await screenPayload(env, data, error));
    }

    if (p === '/ingest' && req.method === 'POST') return handleIngest(req, env);

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
      out.token_shape = { bot_id: tk.split(':')[0], len: tk.length, has_colon: tk.includes(':'), has_space: /\s/.test(tk), starts_bot: /^bot/i.test(tk) };
      out.colo = req.cf?.colo || null;
      return json(out);
    }

    if (p === '/setup') {
      await env.KV.put('origin', url.origin);
      const r = await setupWebhook(env, url.origin, { welcome: true });
      if (r.ok && env.TELEGRAM_BOT_TOKEN) await env.KV.put('tg:ready', env.TELEGRAM_BOT_TOKEN.split(':')[0]);
      return json(r);
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlerts(env).catch((e) => console.error('alerts', e)));
    ctx.waitUntil(autoConnect(env).catch((e) => console.error('autoConnect', e)));
    ctx.waitUntil(maybeDispatch(env).catch((e) => console.error('dispatch', e)));
  },
};
