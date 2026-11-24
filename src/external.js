// Số liệu ChatGPT + Gemini: do GitHub Actions (scripts/collect.mjs) lấy rồi gửi về /ingest.
// Worker kích hoạt workflow đó mỗi 15 phút bằng GH_TOKEN.

const REPO = (env) => env.GH_REPO || 'meohocgioi/trmnl-ai-usage';
export const EXT = ['chatgpt', 'gemini'];
const EVERY_MS = 15 * 60000;
const IDLE_EVERY_MS = 6 * 3600000; // chưa cài cookie nào → chỉ thử 6 giờ/lần (để nhận cookie mới thêm)

async function ingestKey(env) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ingest:' + (env.TELEGRAM_BOT_TOKEN || '')));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// POST /ingest từ GitHub Actions
export async function handleIngest(req, env) {
  if (req.headers.get('x-ingest-key') !== (await ingestKey(env))) return new Response('forbidden', { status: 403 });
  const body = await req.json().catch(() => null);
  if (!body) return new Response('bad json', { status: 400 });
  const saved = {};
  for (const k of EXT) {
    const v = body[k];
    if (v == null) { await env.KV.delete('ext:' + k); saved[k] = 'none'; continue; }
    const prev = (await env.KV.get('ext:' + k, 'json')) || {};
    // Lỗi → giữ số liệu tốt gần nhất, kèm lỗi
    const rec = v.ok ? { ...v, at: body.at || Date.now() } : { ...(prev.ok || prev.data ? prev : {}), error: v.error, errorAt: Date.now() };
    if (v.ok) delete rec.error;
    await env.KV.put('ext:' + k, JSON.stringify(rec));
    saved[k] = v.ok ? 'ok' : 'error';
  }
  await env.KV.put('collect:lastIngest', JSON.stringify({ at: Date.now(), saved }));
  return new Response(JSON.stringify({ ok: true, saved }), { headers: { 'content-type': 'application/json' } });
}

export async function getExternal(env) {
  const out = {};
  for (const k of EXT) out[k] = await env.KV.get('ext:' + k, 'json');
  return out;
}

// Cron: kích hoạt workflow "collect.yml" khi tới giờ
export async function maybeDispatch(env, force = false) {
  if (!env.GH_TOKEN) return { skipped: 'no GH_TOKEN' };
  const now = Date.now();
  const last = Number(await env.KV.get('collect:lastDispatch')) || 0;
  const info = (await env.KV.get('collect:lastIngest', 'json')) || null;
  const anyConfigured = !info || Object.values(info.saved || {}).some((s) => s !== 'none');
  const every = anyConfigured ? EVERY_MS : IDLE_EVERY_MS;
  if (!force && now - last < every - 30000) return { skipped: 'not yet' };
  await env.KV.put('collect:lastDispatch', String(now));
  const r = await fetch(`https://api.github.com/repos/${REPO(env)}/actions/workflows/collect.yml/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json',
      'user-agent': 'trmnl-ai-usage-bot', 'content-type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (r.status !== 204) console.log('dispatch collect failed', r.status, (await r.text()).slice(0, 200));
  return { status: r.status };
}
