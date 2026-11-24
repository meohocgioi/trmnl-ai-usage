// Biến dữ liệu usage thành biến cho màn hình TRMNL (tính sẵn chữ, %, đếm ngược theo giờ VN)
import { when, durLong, durShort, stamp, hhmm, ddmm, wdFull, clamp } from './util.js';

const H5 = 5 * 3600000;
const D7 = 7 * 86400000;

function bar(b, windowMs, now) {
  if (!b) return null;
  const pct = Math.round(b.pct ?? 0);
  const out = {
    pct,
    fill: clamp(pct),
    full: pct >= 100,
    reset_in: '', reset_in_short: '', reset_at: '', pace: null, pace_label: '',
  };
  if (b.resetsAt && b.resetsAt > now) {
    out.reset_in = durLong(b.resetsAt - now);
    out.reset_in_short = durShort(b.resetsAt - now);
    out.reset_at = when(b.resetsAt, now);
    // Vạch "thời gian đã trôi" trong chu kỳ: dùng nhịp này để biết đang dùng nhanh hay chậm
    const start = b.startedAt || b.resetsAt - windowMs;
    const pace = Math.round(clamp(((now - start) / (b.resetsAt - start)) * 100));
    out.pace = pace;
    out.pace_label = pct > pace + 5 ? 'nhanh hơn nhịp' : pct < pace - 5 ? 'chậm hơn nhịp' : 'đúng nhịp';
  }
  return out;
}

export function buildPayload(data, error, now = Date.now()) {
  const p = {
    updated: hhmm(now),
    updated_full: stamp(now),
    ok: !!data && !error,
    has_data: !!data,
    error: error ? error.message : '',
    // Chỉ coi là "số liệu cũ" khi bản lưu đã quá 30 phút (lỗi lẻ tẻ thì cron 5 phút sẽ tự lấy lại)
    stale: !!(error && data && now - data.at > 30 * 60000),
    error_code: error ? error.code : '',
    data_at: data ? stamp(data.at) : '',
    plan: data?.plan || '',
    session: null, week: null, reset: null, parts: [],
  };
  if (!data) return p;

  p.session = bar(data.session, H5, now) || { pct: 0, fill: 0, full: false, reset_in: '', reset_in_short: '', reset_at: '', pace: null, pace_label: '' };
  if (!data.session?.resetsAt || data.session.resetsAt <= now) {
    p.session.idle = true; // chưa có phiên — bắt đầu khi gửi tin nhắn đầu tiên
    p.session.reset_in = '';
  }
  p.week = bar(data.week, D7, now);

  const r = (data.resets || [])[0];
  if (r) {
    const left = r.endsAt ? r.endsAt - now : null;
    p.reset = {
      left: r.left,
      total: r.total,
      dots: Array.from({ length: Math.min(r.total, 6) }, (_, i) => i < r.left),
      usable: r.usable && r.left > 0,
      expires: r.endsAt ? `${hhmm(r.endsAt)} · ${wdFull(r.endsAt)} ${ddmm(r.endsAt)}` : '',
      expires_short: r.endsAt ? `${hhmm(r.endsAt)} ${ddmm(r.endsAt)}` : '',
      remaining: left != null ? durLong(left) : '',
      remaining_short: left != null ? durShort(left) : '',
      days: left != null ? Math.floor(left / 86400000) : null,
      hours: left != null ? Math.floor((left % 86400000) / 3600000) : null,
      urgent: left != null && left < 3 * 86400000 && r.left > 0,
    };
  }
  p.parts = (data.parts || []).filter((x) => x.pct > 0 || x.share > 0).slice(0, 3);
  return p;
}

// ---------- ChatGPT / Gemini (số liệu từ GitHub Actions) ----------
const NAMES = { chatgpt: 'ChatGPT', gemini: 'Gemini' };
const PLAN = (s) => (s ? String(s).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : '');

export function buildExt(key, rec, now = Date.now()) {
  const p = {
    key, name: NAMES[key] || key, plan: PLAN(rec?.plan), has_data: false,
    session: null, week: null, error: '', error_code: '', stale: false, data_at: '',
  };
  if (!rec) return null; // chưa cài cookie
  if (rec.error) { p.error = rec.error.message || ''; p.error_code = rec.error.code || 'http'; }
  if (rec.session || rec.week) {
    p.has_data = true;
    p.data_at = stamp(rec.at);
    // Chu kỳ chưa bắt đầu (0% và mốc reset = bây giờ + nguyên chu kỳ, tính từ lúc GitHub lấy số liệu)
    const notStarted = (b, sec) => b && !b.pct && b.resetsAt && b.resetsAt - (rec.at || now) >= sec * 1000 - 120000;
    p.session = bar(rec.session, (rec.session?.windowSec || 18000) * 1000, now) || null;
    if (p.session && (!rec.session.resetsAt || rec.session.resetsAt <= now || notStarted(rec.session, rec.session.windowSec || 18000))) p.session.idle = true;
    p.week = bar(rec.week, (rec.week?.windowSec || 604800) * 1000, now);
    if (p.week && notStarted(rec.week, rec.week.windowSec || 604800)) p.week.idle = true;
    // Bộ lấy số liệu chạy 15 phút/lần → coi là cũ khi quá 45 phút
    p.stale = now - (rec.at || 0) > 45 * 60000;
  }
  return p;
}

// Một hàng gọn cho màn hình gộp nhiều dịch vụ
export function claudeRow(c) {
  return {
    key: 'claude', name: 'Claude', plan: c.plan, has_data: c.has_data,
    session: c.session, week: c.week, error: c.error, error_code: c.error_code, stale: c.stale, data_at: c.data_at,
  };
}
