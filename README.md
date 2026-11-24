# TRMNL AI Usage – Usage gói Claude trên TRMNL

Plugin TRMNL hiện usage gói Claude của bạn, giống trang **claude.ai → Settings → Usage**:

- **Phiên hiện tại** (chu kỳ 5 giờ): % đã dùng, giờ reset, thời gian còn lại
- **Tuần này** (chu kỳ 7 ngày): % đã dùng, giờ reset, đang dùng nhanh/chậm hơn nhịp thời gian
- **Full reset**: số lượt còn lại, ngày hết hạn, đếm ngược thời gian còn lại

Có đủ 4 cỡ màn hình TRMNL (full, nửa ngang, nửa dọc, 1/4). Chạy hoàn toàn trên **Cloudflare Workers** (không cần máy chủ). Điều khiển bằng bot Telegram, có cảnh báo khi cookie hết hạn, khi Full reset sắp hết hạn mà chưa dùng, khi usage tuần ≥ 90%.

Code mới chỉ được deploy khi bấm **/update** trên Telegram (hoặc *Run workflow* trên GitHub).

## Dữ liệu lấy từ đâu
Worker gọi API mà chính trang Usage của claude.ai dùng (`/api/organizations/{org}/usage?cedar_ember=1`) bằng **cookie đăng nhập `sessionKey`** của bạn.
Cookie lưu trong Cloudflare KV (gửi qua bot bằng `/cookie`), **không** nằm trong code hay GitHub. Đây là API không chính thức, Anthropic có thể đổi bất cứ lúc nào.

## Cài đặt (1 lần)

### 1. GitHub Secrets
Repo → *Settings → Secrets and variables → Actions → New repository secret*:

| Tên | Giá trị | Bắt buộc |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | token Cloudflare (giống repo trmnl-live) | ✅ |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID Cloudflare | ✅ |
| `TELEGRAM_BOT_TOKEN` | token bot mới từ @BotFather | ✅ |
| `TELEGRAM_OWNER_ID` | Telegram user ID của bạn | không (bỏ trống thì người đầu tiên bấm /start là chủ) |
| `GH_TOKEN` | GitHub fine-grained token, quyền **Actions: Read and write** cho repo này | cho /update |
| `TRMNL_MCP_KEY` | MCP API key của plugin trên TRMNL | cho /preview |

Sau đó vào tab **Actions → Deploy Worker → Run workflow**.

### 2. Cookie Claude
Trong bot Telegram gõ `/cookie` để xem hướng dẫn lấy cookie `sessionKey`, rồi gửi `/cookie sk-ant-sid...`. Bot tự xoá tin nhắn chứa cookie.

### 3. TRMNL
Tạo **Private Plugin** → Strategy **Polling** → Polling URL:
`https://trmnl-ai-usage.meohocgioi.workers.dev/trmnl`
Markup: dán `trmnl/shared.liquid` vào ô **Shared** (chứa toàn bộ giao diện), và 4 file `full` / `half_horizontal` / `half_vertical` / `quadrant` (mỗi file 1 dòng) vào từng ô tương ứng.

Sửa giao diện: sửa các file `trmnl/_*.liquid` rồi chạy `node scripts/gen-views.mjs` (tạo lại `shared.liquid` + 4 file cỡ màn hình).

## Lệnh Telegram
`/status` `/cookie` `/preview` `/preview all` `/settings` `/trmnl` `/update` `/version` `/help`

## ChatGPT + Gemini
Lấy bằng **GitHub Actions** (workflow *Lấy usage ChatGPT + Gemini*, file `scripts/collect.mjs`), vì chatgpt.com chặn máy chủ Cloudflare. Worker tự kích hoạt workflow này mỗi 15 phút; GitHub gửi số liệu về `/ingest`. Lệnh bot `/refresh` để lấy ngay.

| Secret | Giá trị |
|---|---|
| `CHATGPT_COOKIE` | dòng `cookie:` của 1 request tới chatgpt.com (DevTools → Network) |
| `GEMINI_COOKIE` | dòng `cookie:` của 1 request tới gemini.google.com |

Bỏ trống secret nào thì dịch vụ đó không hiện (hiện tại **không dùng Gemini** — bỏ trống `GEMINI_COOKIE`).
Claude cũng được bộ lấy số liệu GitHub đọc 15 phút/lần (dùng `CLAUDE_SESSION_KEY`), vì claude.ai hay chặn máy chủ Cloudflare ở Mỹ/châu Âu. Khi có từ 2 dịch vụ trở lên, TRMNL chuyển sang màn hình gộp **AI USAGE**.
