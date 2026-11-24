// Tạo 4 file markup TRMNL từ trmnl/_body.liquid
import { readFileSync, writeFileSync } from 'node:fs';

const body = readFileSync('trmnl/_body.liquid', 'utf8').replace(/^\{% comment %\}[\s\S]*?\{% endcomment %\}\n/, '');
const views = { full: 'sz-full', half_horizontal: 'sz-hh', half_vertical: 'sz-hv', quadrant: 'sz-q' };
for (const [name, cls] of Object.entries(views)) {
  writeFileSync(`trmnl/${name}.liquid`, body.replace('__SIZE__', cls));
  console.log('trmnl/' + name + '.liquid');
}
