// Đọc usage gói Claude từ claude.ai bằng cookie đăng nhập (sessionKey) của chính chủ tài khoản.
// Cookie lưu trong KV (gửi qua bot: /cookie ...), không nằm trong code hay GitHub.

const BASE = 'https://claude.ai';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const CACHE_MS = 2 * 60000; // không gọi claude.ai quá 1 lần / 2 phút

export class ClaudeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Chấp nhận: "sk-ant-sid01-..." hoặc "sessionKey=sk-ant-..." hoặc cả chuỗi cookie dán từ trình duyệt
export function parseCookie(text) {
  const s = String(text || '').trim();
  const m = s.match(/sessionKey=([^;\s]+)/) || s.match(/(sk-ant-[\w-]+)/);
  return m ? m[1] : null;
}

export const getKey = async (env) => (await env.KV.get('claude:key')) || env.CLAUDE_SESSION_KEY || null;

async function call(key, path) {
  const r = await fetch(BASE + path, {
    headers: {
      cookie: `sessionKey=${key}`,
      'user-agent': UA,
      accept: 'application/json',
      'accept-language': 'en-US,en;q=0.9',
      'anthropic-client-platform': 'web_claude_ai',
      referer: BASE + '/settings/usage',
    },
  });
  const text = await r.text();
  if (r.headers.get('cf-mitigated')) throw new ClaudeError('blocked', `claude.ai chặn tạm thời (HTTP ${r.status})`);
  let j = null;
  try { j = JSON.parse(text); } catch {}
  if (r.status === 401 || r.status === 403) {
    const code = j?.error?.details?.error_code || j?.error?.type || '';
    if (/session|auth|permission/i.test(code + (j?.error?.message || ''))) {
      throw new ClaudeError('cookie', 'Cookie hết hạn hoặc đã đăng xuất');
    }
  }
  if (!r.ok || !j) throw new ClaudeError('http', `claude.ai HTTP ${r.status}: ${text.slice(0, 120)}`);
  return j;
}

// Tìm tổ chức (org) của tài khoản — lưu lại để khỏi hỏi lần sau
async function orgId(env, key, force = false) {
  if (!force) {
    const saved = await env.KV.get('claude:org');
    if (saved) return saved;
  }
  const list = await call(key, '/api/organizations');
  const arr = Array.isArray(list) ? list : [];
  const pick =
    arr.find((o) => (o.capabilities || []).some((c) => /claude_(pro|max)/.test(c))) ||
    arr.find((o) => (o.capabilities || []).includes('chat')) ||
    arr[0];
  if (!pick?.uuid) throw new ClaudeError('http', 'Không tìm thấy tổ chức của tài khoản');
  await env.KV.put('claude:org', pick.uuid);
  return pick.uuid;
}

// Gọi API usage (kèm dữ liệu "Full reset" = cedar_ember)
export async function fetchUsage(env, keyOverride) {
  const key = keyOverride || (await getKey(env));
  if (!key) throw new ClaudeError('nokey', 'Chưa có cookie Claude');
  let org = await orgId(env, key, !!keyOverride);
  let raw;
  try {
    raw = await call(key, `/api/organizations/${org}/usage?cedar_ember=1&skip_spend=1`);
  } catch (e) {
    if (e.code !== 'http') throw e;
    org = await orgId(env, key, true); // org có thể đã đổi
    raw = await call(key, `/api/organizations/${org}/usage?cedar_ember=1&skip_spend=1`);
  }
  return normalize(raw);
}

const t = (s) => (s ? Date.parse(s) : null);

export function normalize(j) {
  const ce = j.cedar_ember || {};
  const grants = (ce.grants || []).filter(Boolean);
  const now = Date.now();
  const active = grants
    .filter((g) => !g.ends_at || t(g.ends_at) > now)
    .sort((a, b) => (t(a.ends_at) || 9e15) - (t(b.ends_at) || 9e15));
  const parts = (j.seven_day_breakdown?.rows || [])
    .map((r) => ({ name: r.display_name, pct: r.percent_of_limit ?? 0, share: r.percent ?? 0 }))
    .sort((a, b) => b.pct - a.pct || b.share - a.share);
  const tier = ce.event_props?.tier || '';
  return {
    at: now,
    plan: tier.replace(/^claude_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || null,
    session: j.five_hour ? { pct: j.five_hour.utilization ?? 0, resetsAt: t(j.five_hour.resets_at) } : null,
    week: j.seven_day
      ? {
          pct: j.seven_day.utilization ?? 0,
          resetsAt: t(j.seven_day.resets_at),
          startedAt: t(j.seven_day_breakdown?.window_started_at),
        }
      : null,
    resets: active.map((g) => ({
      id: g.id,
      label: g.label,
      type: g.type,
      total: g.resets_total ?? 1,
      left: g.resets_left ?? 0,
      startsAt: t(g.starts_at),
      endsAt: t(g.ends_at),
      usable: !!g.usable_now,
      paused: !!g.paused,
    })),
    eligible: ce.eligible ?? null,
    parts,
  };
}

// Dữ liệu cho màn hình: dùng cache 2 phút, lỗi thì trả bản gần nhất + thông báo lỗi
export async function getUsage(env, { force = false } = {}) {
  const last = await env.KV.get('claude:last', 'json');
  if (!force && last && Date.now() - last.at < CACHE_MS) return { data: last, error: null };
  try {
    const data = await fetchUsage(env);
    await env.KV.put('claude:last', JSON.stringify(data));
    await env.KV.delete('claude:err');
    return { data, error: null };
  } catch (e) {
    const err = { code: e.code || 'http', message: e.message, at: Date.now() };
    await env.KV.put('claude:err', JSON.stringify(err), { expirationTtl: 7 * 86400 });
    return { data: last, error: err };
  }
}
