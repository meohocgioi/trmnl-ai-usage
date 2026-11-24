// Tạo markup TRMNL:
//  - shared.liquid  = CSS (_style.liquid) + toàn bộ giao diện (_body.liquid) gói trong biến cu_body
//  - full / half_horizontal / half_vertical / quadrant = 1 dòng gọi cu_body với class cỡ màn hình
// Sửa giao diện: chỉ sửa _style.liquid / _body.liquid rồi chạy `node scripts/gen-views.mjs`
import { readFileSync, writeFileSync } from 'node:fs';

const strip = (s) => s.replace(/^\{% comment %\}[\s\S]*?\{% endcomment %\}\n/, '');
const style = readFileSync('trmnl/_style.liquid', 'utf8');
const body = strip(readFileSync('trmnl/_body.liquid', 'utf8'));
writeFileSync('trmnl/shared.liquid', `${style.trimEnd()}\n{% capture cu_body %}\n${body.trimEnd()}\n{% endcapture %}\n`);
const views = { full: 'sz-full', half_horizontal: 'sz-hh', half_vertical: 'sz-hv', quadrant: 'sz-q' };
for (const [name, cls] of Object.entries(views)) {
  writeFileSync(`trmnl/${name}.liquid`, `<div class="layout" style="padding:0;"><div class="${cls}" style="width:100%;height:100%;">{{ cu_body }}</div></div>\n`);
}
console.log('ok: shared + 4 views');
