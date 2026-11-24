// Cảnh báo tự động qua Telegram (chạy theo cron mỗi 10 phút)
import { getUsage } from './claude.js';
import { buildPayload } from './view.js';
import { sendMsg, ownerId, getSettings } from './telegram.js';
import { esc } from './util.js';

// Gửi 1 lần cho mỗi "key" (lưu dấu trong KV)
async function once(env, key, ttlSec, fn) {
  if (await env.KV.get(key)) return;
  await env.KV.put(key, '1', { expirationTtl: ttlSec });
  await fn();
}

export async function runAlerts(env) {
  const { data, error } = await getUsage(env, { force: true });
  const owner = await ownerId(env);
  if (!env.TELEGRAM_BOT_TOKEN || !owner) return;
  const send = (t) => sendMsg(env, owner, t);
  const s = await getSettings(env);

  if (error && (error.code === 'cookie' || error.code === 'nokey')) {
    if (error.code === 'cookie') {
      await once(env, 'alert:cookie', 30 * 86400, () =>
        send('🔑 <b>Cookie Claude đã hết hạn</b> (hoặc bạn đã đăng xuất).\nTRMNL đang hiện số liệu cũ. Gửi cookie mới bằng <code>/cookie sk-ant-...</code>'));
    }
    return;
  }
  if (!data) return;
  const p = buildPayload(data, error);

  // Full reset sắp hết hạn mà chưa dùng
  const fr = (data.resets || [])[0];
  if (s.alertReset && fr && fr.left > 0 && fr.endsAt) {
    const left = fr.endsAt - Date.now();
    for (const [days, tag] of [[1, '1d'], [3, '3d']]) {
      if (left > 0 && left <= days * 86400000) {
        await once(env, `alert:fr:${fr.id}:${tag}`, 40 * 86400, () =>
          send(`♻️ <b>Full reset sắp hết hạn!</b>\nCòn <b>${fr.left}/${fr.total}</b> lượt chưa dùng · hết hạn ${esc(p.reset.expires)}\n⏳ Còn <b>${esc(p.reset.remaining)}</b> — vào claude.ai → Settings → Usage để dùng.`));
        break;
      }
    }
  }

  // Usage tuần
  if (s.alertWeek && data.week?.resetsAt) {
    const w = Math.round(data.week.pct);
    for (const lv of [100, 90]) {
      if (w >= lv) {
        await once(env, `alert:wk:${data.week.resetsAt}:${lv}`, 8 * 86400, () =>
          send(`📅 <b>Usage tuần đã ${w}%</b>\nReset sau <b>${esc(p.week.reset_in)}</b> (${esc(p.week.reset_at)})` +
            (p.reset?.usable ? `\n♻️ Bạn còn ${p.reset.left} lượt Full reset (hết hạn ${esc(p.reset.expires_short)}).` : '')));
        break;
      }
    }
  }

  // Phiên 5 giờ chạm giới hạn
  if (s.alertSession && data.session?.resetsAt && Math.round(data.session.pct) >= 100) {
    await once(env, `alert:ss:${data.session.resetsAt}`, 6 * 3600, () =>
      send(`⏱ <b>Phiên hiện tại đã hết (100%)</b>\nMở lại sau <b>${esc(p.session.reset_in)}</b> · lúc ${esc(p.session.reset_at)}`));
  }
}
