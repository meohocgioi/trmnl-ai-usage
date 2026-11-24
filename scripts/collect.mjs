// Chạy trên GitHub Actions (Worker kích hoạt mỗi 15 phút).
// Lấy usage ChatGPT (Codex, gói Plus) và Gemini (trang gemini.google.com/usage) bằng cookie của chủ tài khoản,
// rồi gửi về Worker. KHÔNG BAO GIỜ in cookie / token ra log (repo public).
import { createHash } from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const WORKER = process.env.WORKER_URL || 'https://trmnl-ai-usage.meohocgioi.workers.dev';
const TZ = 'Asia/Ho_Chi_Minh';

const fail = (code, message) => ({ ok: false, error: { code, message } });

// Nhận: chuỗi header "Cookie: a=1; b=2", chuỗi "a=1; b=2", file cookies.txt (Netscape), hoặc JSON export
export function parseCookies(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try { return JSON.parse(s).map((c) => ({ name: c.name, value: c.value, domain: c.domain })); } catch {}
  }
  if (s.includes('\t')) {
    return s.split('\n').filter((l) => l && !l.startsWith('#') || l.startsWith('#HttpOnly_')).map((l) => l.replace(/^#HttpOnly_/, '').split('\t'))
      .filter((p) => p.length >= 7).map((p) => ({ domain: p[0], name: p[5], value: p[6].trim() }));
  }
  return s.replace(/^cookie:\s*/i, '').split(/;\s*/).map((kv) => {
    const i = kv.indexOf('=');
    return i > 0 ? { name: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim() } : null;
  }).filter(Boolean);
}
const header = (cs) => cs.map((c) => `${c.name}=${c.value}`).join('; ');

// ---------------- ChatGPT ----------------
async function chatgpt(raw) {
  let cs = parseCookies(raw);
  // Dán riêng giá trị session-token (không có tên) cũng nhận
  if (cs.length === 0 && raw && raw.trim()) cs = [{ name: '__Secure-next-auth.session-token', value: raw.trim() }];
  if (!cs.some((c) => c.name.startsWith('__Secure-next-auth.session-token'))) {
    return fail('cookie', 'Cookie ChatGPT thiếu __Secure-next-auth.session-token');
  }
  const base = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: header(cs) };
  const sr = await fetch('https://chatgpt.com/api/auth/session', { headers: { ...base, accept: 'application/json' } });
  if (!sr.ok) return fail(sr.status === 403 ? 'blocked' : 'http', `chatgpt.com HTTP ${sr.status} (session)`);
  const sess = await sr.json().catch(() => ({}));
  if (!sess.accessToken) return fail('cookie', 'Cookie ChatGPT hết hạn hoặc đã đăng xuất');
  const ur = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers: { ...base, accept: 'application/json', authorization: `Bearer ${sess.accessToken}` },
  });
  if (ur.status === 401) return fail('cookie', 'Phiên ChatGPT không hợp lệ');
  if (!ur.ok) return fail(ur.status === 403 ? 'blocked' : 'http', `chatgpt.com HTTP ${ur.status} (usage)`);
  const j = await ur.json();
  const rl = j.rate_limit || {};
  const win = (w) => (w ? { pct: w.used_percent ?? 0, resetsAt: w.reset_at ? w.reset_at * 1000 : null, windowSec: w.limit_window_seconds ?? null } : null);
  return {
    ok: true,
    plan: j.plan_type || sess.account?.planType || null,
    limitReached: !!rl.limit_reached,
    session: win(rl.primary_window),
    week: win(rl.secondary_window),
  };
}

// ---------------- Claude (dự phòng khi Worker bị claude.ai chặn) ----------------
async function claude(raw) {
  const key = (String(raw).match(/sessionKey=([^;\s]+)/) || String(raw).match(/(sk-ant-[\w-]+)/) || [])[1];
  if (!key) return fail('cookie', 'Cookie Claude không hợp lệ');
  const h = { cookie: `sessionKey=${key}`, 'user-agent': UA, accept: 'application/json', 'accept-language': 'en-US,en;q=0.9', 'anthropic-client-platform': 'web_claude_ai', referer: 'https://claude.ai/settings/usage' };
  const get = async (path) => {
    const r = await fetch('https://claude.ai' + path, { headers: h });
    if (r.headers.get('cf-mitigated')) throw Object.assign(new Error(`claude.ai chặn (HTTP ${r.status})`), { code: 'blocked' });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Cookie Claude hết hạn hoặc đã đăng xuất'), { code: 'cookie' });
    if (!r.ok) throw Object.assign(new Error(`claude.ai HTTP ${r.status}`), { code: 'http' });
    return r.json();
  };
  try {
    const orgs = await get('/api/organizations');
    const org = (orgs.find((o) => (o.capabilities || []).some((c) => /claude_(pro|max)/.test(c))) || orgs.find((o) => (o.capabilities || []).includes('chat')) || orgs[0])?.uuid;
    if (!org) return fail('http', 'Không tìm thấy tổ chức Claude');
    return { ok: true, raw: await get(`/api/organizations/${org}/usage?cedar_ember=1&skip_spend=1`) };
  } catch (e) {
    return fail(e.code || 'http', e.message);
  }
}

// ---------------- Gemini ----------------
// Đổi "6:14 PM" / "Nov 24 at 2:14 PM" (giờ VN) thành mốc thời gian
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
export function parseVnTime(text, now = Date.now()) {
  const m = String(text).match(/(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+at\s+)?(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!m) return null;
  let h = +m[3] % 12;
  if (/pm/i.test(m[5])) h += 12;
  const vnNow = new Date(now + 7 * 3600000);
  let y = vnNow.getUTCFullYear(), mo = vnNow.getUTCMonth(), d = vnNow.getUTCDate();
  if (m[1]) { mo = MON[m[1].toLowerCase()]; d = +m[2]; if (mo < vnNow.getUTCMonth() - 6) y++; }
  let t = Date.UTC(y, mo, d, h, +m[4]) - 7 * 3600000;
  if (!m[1] && t < now - 60000) t += 86400000; // "Resets at 6:14 PM" đã qua hôm nay → ngày mai
  return t;
}

export function parseGeminiText(text, now = Date.now()) {
  const t = String(text).replace(/ /g, ' ');
  const sec = (label, next) => {
    const i = t.indexOf(label);
    if (i < 0) return null;
    const j = next ? t.indexOf(next, i + label.length) : -1;
    return t.slice(i, j > 0 ? j : i + 200);
  };
  const cur = sec('Current usage', 'Weekly limit');
  const wk = sec('Weekly limit', 'Get ');
  const pick = (s) => {
    if (!s) return null;
    const p = s.match(/(\d+(?:\.\d+)?)%\s*used/i);
    const r = s.match(/Resets\s+([^\n]+)/i);
    return { pct: p ? +p[1] : 0, resetsAt: r ? parseVnTime(r[1], now) : null, resetText: r ? r[1].trim() : null };
  };
  const plan = (t.match(/Usage limits\s*\n\s*([A-Z][A-Z ]{1,20})\s*\n/) || [])[1] || null;
  return { session: pick(cur), week: pick(wk), plan: plan ? plan.trim() : null };
}

async function gemini(raw) {
  const cs = parseCookies(raw);
  if (!cs.some((c) => /^(__Secure-1PSID|SID)$/.test(c.name))) return fail('cookie', 'Cookie Gemini thiếu SID / __Secure-1PSID');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', timezoneId: TZ, viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(cs.map((c) => ({
      name: c.name, value: c.value,
      domain: c.domain && /google\.com$/.test(c.domain.replace(/^\./, '')) ? c.domain : '.google.com',
      path: '/', secure: true, sameSite: 'None', httpOnly: /SID|PSID/.test(c.name),
    })));
    const page = await ctx.newPage();
    await page.goto('https://gemini.google.com/usage', { waitUntil: 'domcontentloaded', timeout: 45000 });
    try { await page.waitForFunction(() => /Weekly limit/.test(document.body.innerText), null, { timeout: 30000 }); } catch {}
    const url = page.url();
    if (/accounts\.google\.com|ServiceLogin|signin/i.test(url)) return fail('cookie', 'Cookie Google hết hạn hoặc bị đăng xuất');
    const text = await page.evaluate(() => (document.querySelector('main') || document.body).innerText);
    if (!/Weekly limit|Current usage/.test(text)) return fail('http', 'Không thấy trang Usage của Gemini (có thể gói không hỗ trợ hoặc Google đổi giao diện)');
    const g = parseGeminiText(text);
    return { ok: true, plan: g.plan, session: g.session, week: g.week };
  } finally {
    await browser.close();
  }
}

// ---------------- Chạy ----------------
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) await main();

async function main() {
  async function run(name, fn, raw) {
    if (!raw || !raw.trim()) return null; // chưa cài
    try { return await fn(raw); } catch (e) { return fail('http', String(e.message || e).slice(0, 200)); }
  }

  const out = {
    at: Date.now(),
    claude: await run('claude', claude, process.env.CLAUDE_SESSION_KEY),
    chatgpt: await run('chatgpt', chatgpt, process.env.CHATGPT_COOKIE),
    gemini: await run('gemini', gemini, process.env.GEMINI_COOKIE),
  };

  // Log chỉ ghi tóm tắt, không ghi cookie/token
  for (const k of ['claude', 'chatgpt', 'gemini']) {
    const v = out[k];
    const s = v?.raw ? { session: { pct: v.raw.five_hour?.utilization }, week: { pct: v.raw.seven_day?.utilization } } : v;
    console.log(k + ':', v == null ? 'chưa cài' : v.ok ? `OK · phiên ${s.session?.pct ?? '?'}% · tuần ${s.week?.pct ?? '?'}%` : `LỖI ${v.error.code}: ${v.error.message}`);
  }

  const key = createHash('sha256').update('ingest:' + (process.env.TELEGRAM_BOT_TOKEN || '')).digest('hex');
  const r = await fetch(WORKER + '/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': key },
    body: JSON.stringify(out),
  });
  console.log('Gửi về Worker:', r.status, (await r.text()).slice(0, 200));
  if (!r.ok) process.exit(1);
}
