// Tạo markup TRMNL:
//  - shared.liquid = CSS (_style + _multi_style) + 2 giao diện gói trong biến:
//      cu_body  : màn hình chi tiết khi chỉ có Claude (_body.liquid)
//      cu_multi : màn hình gộp nhiều dịch vụ (_multi_body.liquid)
//  - full / half_horizontal / half_vertical / quadrant = 1 dòng chọn giao diện + class cỡ màn hình
// Sửa giao diện: sửa các file _*.liquid rồi chạy `node scripts/gen-views.mjs`
import { readFileSync, writeFileSync } from 'node:fs';

const rd = (f) => readFileSync('trmnl/' + f, 'utf8').replace(/^\{% comment %\}[\s\S]*?\{% endcomment %\}\n/, '').trimEnd();
const shared = [
  rd('_style.liquid'),
  rd('_multi_style.liquid'),
  `{% capture cu_body %}\n${rd('_body.liquid')}\n{% endcapture %}`,
  `{% capture cu_multi %}\n${rd('_multi_body.liquid')}\n{% endcapture %}`,
].join('\n') + '\n';
writeFileSync('trmnl/shared.liquid', shared);
const views = { full: 'sz-full', half_horizontal: 'sz-hh', half_vertical: 'sz-hv', quadrant: 'sz-q' };
for (const [name, cls] of Object.entries(views)) {
  writeFileSync(`trmnl/${name}.liquid`,
    `<div class="layout" style="padding:0;"><div class="${cls}" style="width:100%;height:100%;">{% if multi %}{{ cu_multi }}{% else %}{{ cu_body }}{% endif %}</div></div>\n`);
}
console.log('ok: shared (' + shared.length + ' ký tự) + 4 views');
