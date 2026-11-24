import { getUsage } from './claude.js';
import { buildPayload, buildExt, claudeRow } from './view.js';
import { handleIngest, getExternal, maybeDispatch, EXT } from './external.js';
import { hhmm, stamp } from './util.js';
import { handleTelegram, setupWebhook, getSettings } from './telegram.js';
import { autoUpdate } from './updater.js';
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
  const s = await getSettings(env);
  const show = { claude: s.showClaude !== false, chatgpt: s.showChatgpt !== false, gemini: true };
  const rows = [];
  if (show.claude) rows.push(claudeRow(claude));
  for (const k of EXT) {
    const r = show[k] ? buildExt(k, ext[k], now) : null;
    if (r) rows.push(r);
  }
  if (!rows.length) rows.push(claudeRow(claude)); // phòng khi không còn dịch vụ nào
  // Chỉ Claude → màn hình chi tiết Claude; còn lại → màn hình gộp (kể cả chỉ có ChatGPT)
  const multi = !(rows.length === 1 && rows[0].key === 'claude');
  if (!rows.some((r) => r.key === 'claude')) claude.reset = null; // ẩn dải Full reset khi không hiện Claude
  return { updated: hhmm(now), updated_full: stamp(now), multi, count: rows.length, rows, claude };
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
    ctx.waitUntil(autoUpdate(env).catch((e) => console.error('autoUpdate', e)));
  },
};
