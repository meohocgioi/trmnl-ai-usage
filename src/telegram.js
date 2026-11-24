// Bot Telegram điều khiển plugin (chỉ chủ bot dùng được)
import { getUsage, fetchUsage, parseCookie, getKey } from './claude.js';
import { buildPayload } from './view.js';
import { trmnlPreview } from './trmnl.js';
import { esc, stamp } from './util.js';

const REPO = (env) => env.GH_REPO || 'meohocgioi/trmnl-ai-usage';
const API = (env, m) => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${m}`;

export async function tg(env, method, body) {
  const r = await fetch(API(env, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}

const kbMarkup = (kb) => (kb ? { reply_markup: { inline_keyboard: kb } } : {});

export function sendMsg(env, chatId, text, kb) {
  return tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...kbMarkup(kb) });
}

async function editOrSend(env, chatId, msgId, text, kb) {
  if (msgId) {
    const r = await tg(env, 'editMessageText', {
      chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...kbMarkup(kb),
    });
    if (r.ok || String(r.description || '').includes('not modified')) return r;
  }
  return sendMsg(env, chatId, text, kb);
}

async function sendPhotoBytes(env, chatId, bytes, type, caption, kb) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('caption', caption);
  fd.append('parse_mode', 'HTML');
  if (kb) fd.append('reply_markup', JSON.stringify({ inline_keyboard: kb }));
  fd.append('photo', new Blob([bytes], { type: type || 'image/png' }), 'trmnl.png');
  return (await fetch(API(env, 'sendPhoto'), { method: 'POST', body: fd })).ok;
}

async function secretToken(env) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('trmnl-ai-usage:' + env.TELEGRAM_BOT_TOKEN));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

export async function ownerId(env) {
  return env.TELEGRAM_OWNER_ID || (await env.KV.get('owner'));
}

// ---------- Cài đặt ----------
export const DEFAULT_SETTINGS = { alertReset: true, alertWeek: true, alertSession: true };
export async function getSettings(env) {
  return { ...DEFAULT_SETTINGS, ...((await env.KV.get('settings', 'json')) || {}) };
}

const COMMANDS = [
  { command: 'status', description: '📊 Usage Claude hiện tại' },
  { command: 'cookie', description: '🔑 Gửi cookie Claude: /cookie sk-ant-...' },
  { command: 'preview', description: '🖼 Xem trước màn hình TRMNL' },
  { command: 'settings', description: '⚙️ Cài đặt cảnh báo' },
  { command: 'trmnl', description: '🔗 Polling URL cho TRMNL' },
  { command: 'update', description: '🔄 Cập nhật code mới nhất từ GitHub' },
  { command: 'version', description: '🏷 Phiên bản đang chạy' },
  { command: 'help', description: '❓ Hướng dẫn' },
];

const MAIN_KB = [
  [{ text: '📊 Usage', callback_data: 'status' }, { text: '🖼 Preview TRMNL', callback_data: 'preview' }],
  [{ text: '⚙️ Cài đặt', callback_data: 'settings' }, { text: '🔑 Cookie', callback_data: 'cookiehelp' }],
];

export async function setupWebhook(env, origin, opts = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: 'Chưa có TELEGRAM_BOT_TOKEN' };
  const url = origin + '/tg';
  const retry = (method, body) => tg(env, method, body);
  const me = await tg(env, 'getMe', {});
  if (!me.ok) return { ok: false, version: env.VERSION || null, bot: me }; // bot đang bị Telegram khoá tạm — thử lại sau
  let info = await tg(env, 'getWebhookInfo', {});
  let webhook = { ok: true, skipped: 'đã đúng URL' };
  if (info?.result?.url !== url) {
    webhook = await retry('setWebhook', {
      url,
      secret_token: await secretToken(env),
      allowed_updates: ['message', 'callback_query'],
    });
    info = await tg(env, 'getWebhookInfo', {});
  }
  const commands = await retry('setMyCommands', { commands: COMMANDS });
  let notified = false;
  const owner = await ownerId(env);
  const hookOk = info?.result?.url === url;
  // Lần đầu bot nối được: chào + hướng dẫn gửi cookie
  if (opts.welcome && hookOk && owner && !(await env.KV.get('welcomed:' + env.TELEGRAM_BOT_TOKEN.split(':')[0]))) {
    const has = !!(await getKey(env));
    await sendMsg(env, owner,
      `👋 <b>Bot Claude usage đã kết nối!</b>\n\n` + (has ? 'Đã có cookie Claude. Bấm 📊 Usage để xem.' : '🔑 <b>Bước tiếp theo:</b> gửi cookie Claude.\n\n' + COOKIE_HELP), MAIN_KB);
    await env.KV.put('welcomed:' + env.TELEGRAM_BOT_TOKEN.split(':')[0], '1');
  }
  if (owner && env.VERSION && (await env.KV.get('notifiedVersion')) !== env.VERSION) {
    await sendMsg(env, owner, `✅ <b>Đã cập nhật xong!</b>\n🏷 Phiên bản <code>${esc(env.VERSION)}</code>\n📝 ${esc(env.VERSION_MSG || '')}`, MAIN_KB);
    await env.KV.put('notifiedVersion', env.VERSION);
    notified = true;
  }
  const hook = info?.result || {};
  return {
    ok: hook.url === url,
    version: env.VERSION || null,
    bot: me?.result ? '@' + me.result.username : me,
    webhook_url: hook.url || null,
    webhook_last_error: hook.last_error_message || null,
    pending: hook.pending_update_count ?? null,
    notified, webhook, commands,
  };
}

// ---------- Nội dung ----------
const tbar = (pct, n = 12) => {
  const f = Math.round((Math.min(100, Math.max(0, pct)) / 100) * n);
  return '▰'.repeat(f) + '▱'.repeat(n - f);
};

function statusText(p) {
  if (!p.has_data) {
    return p.error_code === 'nokey'
      ? '🔑 <b>Chưa có cookie Claude.</b>\n\n' + COOKIE_HELP
      : `❌ <b>Chưa đọc được usage</b>\n<code>${esc(p.error)}</code>`;
  }
  const L = [`<b>✳️ Claude usage</b>${p.plan ? ` · ${esc(p.plan)}` : ''}`, ''];
  const s = p.session;
  L.push(`<b>⏱ Phiên hiện tại</b>  <b>${s.pct}%</b>`);
  L.push(`<code>${tbar(s.pct)}</code>`);
  L.push(s.idle ? '   <i>Chưa bắt đầu — tính từ tin nhắn đầu tiên</i>' : `   Reset sau <b>${s.reset_in}</b> · ${s.reset_at}`);
  if (p.week) {
    const w = p.week;
    L.push('', `<b>📅 Tuần này</b>  <b>${w.pct}%</b>`);
    L.push(`<code>${tbar(w.pct)}</code>`);
    if (w.reset_in) L.push(`   Reset sau <b>${w.reset_in}</b> · ${w.reset_at}`);
    if (w.pace != null) L.push(`   Đã qua ${w.pace}% thời gian tuần → <i>${w.pace_label}</i>`);
    if (p.parts.length) L.push('   ' + p.parts.map((x) => `${esc(x.name)} ${x.pct}%`).join(' · '));
  }
  if (p.reset) {
    const r = p.reset;
    L.push('', `<b>♻️ Full reset</b>  còn <b>${r.left}/${r.total}</b> lượt`);
    L.push(`   Hết hạn ${r.expires} (giờ VN)`);
    L.push(`   ⏳ Còn lại <b>${r.remaining}</b>${r.urgent ? ' ⚠️' : ''}`);
  } else {
    L.push('', '♻️ Full reset: <i>không có lượt nào</i>');
  }
  L.push('', `🕒 Số liệu lúc ${p.data_at}`);
  if (p.error) L.push(`⚠️ <i>${esc(p.error)}</i> — đang hiện số liệu cũ`);
  return L.join('\n');
}

const COOKIE_HELP =
  `<b>Cách lấy cookie</b> (trên máy tính, Chrome đã đăng nhập claude.ai):\n` +
  `1. Mở <b>claude.ai</b> → bấm <b>F12</b> (Mac: <b>Cmd+Option+I</b>)\n` +
  `2. Tab <b>Application</b> → <b>Cookies</b> → <b>https://claude.ai</b>\n` +
  `3. Tìm dòng <b>sessionKey</b> → bấm đúp ô Value → copy (bắt đầu bằng <code>sk-ant-sid</code>)\n` +
  `4. Gửi cho bot: <code>/cookie sk-ant-sid...</code>\n\n` +
  `🔒 Bot sẽ xoá tin nhắn chứa cookie ngay sau khi lưu. Cookie mở được tài khoản Claude của bạn — không gửi cho ai khác.\n` +
  `ℹ️ Nếu bạn bấm <b>Log out</b> trên trình duyệt đó, cookie mất hiệu lực → bot sẽ báo để bạn gửi cookie mới.`;

function settingsView(s) {
  const on = (v) => (v ? '✅ BẬT' : '⬜ TẮT');
  const text =
    `<b>⚙️ Cảnh báo qua Telegram</b>\n\n` +
    `♻️ Nhắc dùng <b>Full reset</b> trước khi hết hạn (còn 3 ngày, 1 ngày): <b>${on(s.alertReset)}</b>\n` +
    `📅 Usage tuần đạt 90% / 100%: <b>${on(s.alertWeek)}</b>\n` +
    `⏱ Phiên hiện tại chạm 100% (kèm giờ reset): <b>${on(s.alertSession)}</b>\n\n` +
    `<i>Cookie hết hạn luôn được báo.</i>`;
  const kb = [
    [{ text: `♻️ Full reset: ${s.alertReset ? 'BẬT' : 'TẮT'}`, callback_data: 'tog:alertReset' }],
    [{ text: `📅 Tuần 90%: ${s.alertWeek ? 'BẬT' : 'TẮT'}`, callback_data: 'tog:alertWeek' }],
    [{ text: `⏱ Phiên 100%: ${s.alertSession ? 'BẬT' : 'TẮT'}`, callback_data: 'tog:alertSession' }],
    [{ text: '⬅️ Menu', callback_data: 'status' }],
  ];
  return { text, kb };
}

const HELP =
  `<b>❓ Hướng dẫn</b>\n\n` +
  `/status – usage Claude hiện tại\n` +
  `/cookie sk-ant-... – lưu cookie Claude (bot tự xoá tin nhắn)\n` +
  `/preview – xem trước màn hình TRMNL (đúng như lần refresh tới)\n` +
  `/preview all – xem cả 4 cỡ (full, nửa ngang, nửa dọc, 1/4)\n` +
  `/settings – bật/tắt cảnh báo\n` +
  `/trmnl – Polling URL để cài plugin trên TRMNL\n` +
  `/update – cập nhật code mới nhất từ GitHub (chỉ khi bạn bấm)\n` +
  `/version – phiên bản đang chạy`;

const VIEW_NAME = {
  markup_full: 'Toàn màn hình', markup_half_horizontal: 'Nửa ngang',
  markup_half_vertical: 'Nửa dọc', markup_quadrant: '1/4 màn hình',
};

async function doStatus(env, chatId, msgId, force = true) {
  const { data, error } = await getUsage(env, { force });
  return editOrSend(env, chatId, msgId, statusText(buildPayload(data, error)), MAIN_KB);
}

async function doPreview(env, chatId, all) {
  if (!env.TRMNL_MCP_KEY) {
    return sendMsg(env, chatId, '⚠️ Chưa có secret <code>TRMNL_MCP_KEY</code> (MCP API key của plugin trên TRMNL).\nThêm vào GitHub Secrets rồi bấm /update.');
  }
  const wait = await sendMsg(env, chatId, '⏳ Đang nhờ TRMNL render màn hình với dữ liệu hiện tại… (~15–30 giây)');
  const views = all ? ['markup_full', 'markup_half_horizontal', 'markup_half_vertical', 'markup_quadrant'] : ['markup_full'];
  try {
    await getUsage(env, { force: true });
    const imgs = await trmnlPreview(env, views);
    for (let i = 0; i < imgs.length; i++) {
      const im = imgs[i];
      const cap = i === 0
        ? `🖼 <b>Preview TRMNL</b> · ${VIEW_NAME[im.view] || im.view}\n<i>Đúng như màn hình sẽ hiện ở lần TRMNL refresh tới.</i>`
        : `🖼 ${VIEW_NAME[im.view] || im.view}`;
      await sendPhotoBytes(env, chatId, im.bytes, im.type, cap, i === imgs.length - 1 ? MAIN_KB : undefined);
    }
    if (wait?.result?.message_id) await tg(env, 'deleteMessage', { chat_id: chatId, message_id: wait.result.message_id });
  } catch (e) {
    await editOrSend(env, chatId, wait?.result?.message_id, `❌ Không lấy được preview.\n<code>${esc(e.message).slice(0, 500)}</code>`, MAIN_KB);
  }
}

async function saveCookie(env, chatId, msgId, text) {
  // Xoá tin nhắn có cookie trước tiên
  if (msgId) await tg(env, 'deleteMessage', { chat_id: chatId, message_id: msgId });
  const key = parseCookie(text);
  if (!key) return sendMsg(env, chatId, '⚠️ Không thấy cookie hợp lệ (phải bắt đầu bằng <code>sk-ant-</code>).\n\n' + COOKIE_HELP);
  const wait = await sendMsg(env, chatId, '🔐 Đã xoá tin nhắn chứa cookie. Đang kiểm tra với claude.ai…');
  const wid = wait?.result?.message_id;
  try {
    const data = await fetchUsage(env, key);
    await env.KV.put('claude:key', key);
    await env.KV.put('claude:last', JSON.stringify(data));
    await env.KV.delete('claude:err');
    await env.KV.delete('alert:cookie');
    return editOrSend(env, chatId, wid, '✅ <b>Đã lưu cookie, đọc usage thành công!</b>\n\n' + statusText(buildPayload(data, null)), MAIN_KB);
  } catch (e) {
    return editOrSend(env, chatId, wid, `❌ Cookie không dùng được: <b>${esc(e.message)}</b>\n<i>Chưa lưu. Hãy lấy lại cookie mới.</i>\n\n` + COOKIE_HELP);
  }
}

// ---------- Xử lý update ----------
export async function handleTelegram(req, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return new Response('no token', { status: 503 });
  if (req.headers.get('x-telegram-bot-api-secret-token') !== (await secretToken(env))) {
    return new Response('forbidden', { status: 403 });
  }
  const upd = await req.json();
  const origin = new URL(req.url).origin;
  const dk = 'upd:' + upd.update_id;
  if (await env.KV.get(dk)) return new Response('dup');
  await env.KV.put(dk, '1', { expirationTtl: 600 });
  try {
    await processUpdate(env, upd, origin);
  } catch (e) {
    console.error('telegram', e);
  }
  return new Response('ok');
}

async function processUpdate(env, upd, origin) {
  const msg = upd.message || upd.callback_query?.message;
  const from = upd.message?.from || upd.callback_query?.from;
  if (!msg || !from) return;
  const chatId = msg.chat.id;

  // Chủ bot: TELEGRAM_OWNER_ID, hoặc người đầu tiên bấm /start
  let owner = await ownerId(env);
  if (!owner) {
    owner = String(from.id);
    await env.KV.put('owner', owner);
  }
  if (String(from.id) !== String(owner)) {
    if (upd.message) await sendMsg(env, chatId, '⛔ Bot này là bot riêng.');
    return;
  }

  if (upd.callback_query) {
    const data = upd.callback_query.data || '';
    await tg(env, 'answerCallbackQuery', { callback_query_id: upd.callback_query.id });
    const mid = msg.message_id;
    if (data === 'status') return doStatus(env, chatId, mid);
    if (data === 'preview') return doPreview(env, chatId, false);
    if (data === 'cookiehelp') return sendMsg(env, chatId, COOKIE_HELP);
    if (data === 'settings') { const v = settingsView(await getSettings(env)); return editOrSend(env, chatId, mid, v.text, v.kb); }
    if (data.startsWith('tog:')) {
      const s = await getSettings(env);
      const k = data.slice(4);
      if (k in DEFAULT_SETTINGS) { s[k] = !s[k]; await env.KV.put('settings', JSON.stringify(s)); }
      const v = settingsView(s);
      return editOrSend(env, chatId, mid, v.text, v.kb);
    }
    return;
  }

  const text = (msg.text || '').trim();
  // Dán thẳng cookie (không kèm lệnh) cũng nhận
  if (!text.startsWith('/') && /sk-ant-[\w-]{20,}/.test(text)) return saveCookie(env, chatId, msg.message_id, text);

  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = (cmdRaw || '').toLowerCase().replace(/@.*$/, '');
  const arg = rest.join(' ').trim();

  switch (cmd) {
    case '/start': {
      const has = !!(await getKey(env));
      return sendMsg(env, chatId,
        `<b>✳️ Claude usage → TRMNL</b>\n\nBot hiện usage gói Claude của bạn (phiên hiện tại, tuần này, Full reset) lên màn hình TRMNL.\n\n` +
        (has ? '🔑 Đã có cookie Claude. Bấm 📊 Usage để xem.' : '🔑 <b>Bước đầu tiên:</b> gửi cookie Claude.\n\n' + COOKIE_HELP), MAIN_KB);
    }
    case '/help':
      return sendMsg(env, chatId, HELP, MAIN_KB);
    case '/status':
      return doStatus(env, chatId, null);
    case '/cookie':
      if (!arg) return sendMsg(env, chatId, COOKIE_HELP);
      return saveCookie(env, chatId, msg.message_id, arg);
    case '/settings': {
      const v = settingsView(await getSettings(env));
      return sendMsg(env, chatId, v.text, v.kb);
    }
    case '/preview':
      return doPreview(env, chatId, /^(all|tat ca|tất cả)$/i.test(arg));
    case '/trmnl':
      return sendMsg(env, chatId, `<b>🖼 Cài đặt TRMNL</b>\n\nStrategy: <b>Polling</b>\nPolling URL:\n<code>${origin}/trmnl</code>`);
    case '/version':
      return sendMsg(env, chatId, `🏷 Phiên bản đang chạy: <code>${esc(env.VERSION || 'chưa rõ')}</code>\n📝 ${esc(env.VERSION_MSG || '')}`);
    case '/update': {
      if (!env.GH_TOKEN) {
        return sendMsg(env, chatId,
          `⚠️ Chưa có quyền cập nhật.\nThêm secret <code>GH_TOKEN</code> (GitHub token, quyền <b>Actions: Read and write</b> cho repo ${esc(REPO(env))}) rồi chạy <b>Deploy Worker</b> 1 lần trên GitHub.`);
      }
      const r = await fetch(`https://api.github.com/repos/${REPO(env)}/actions/workflows/deploy.yml/dispatches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json',
          'user-agent': 'trmnl-ai-usage-bot', 'content-type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      });
      if (r.status !== 204) return sendMsg(env, chatId, `❌ Không gọi được GitHub (HTTP ${r.status}).\n<code>${esc((await r.text()).slice(0, 300))}</code>`);
      return sendMsg(env, chatId, `🔄 <b>Đang cập nhật…</b>\nĐang chạy: <code>${esc(env.VERSION || '?')}</code>\nKhoảng 1 phút nữa bot sẽ báo ✅ khi xong.`);
    }
    default:
      if (cmd) return sendMsg(env, chatId, '🤔 Không hiểu lệnh.\n\n' + HELP, MAIN_KB);
  }
}

export { statusText, stamp };
