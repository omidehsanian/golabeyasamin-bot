// خواندن ساده‌ی xlsx ساخته‌شده با xlsx.js در تست‌ها (zip بدون فشرده‌سازی)
import { inflateRawSync } from 'node:zlib';

function unzip(bytes) {
  const buf = Buffer.from(bytes);
  const files = {};
  let pos = 0;
  while (buf.readUInt32LE(pos) === 0x04034b50) {
    const method = buf.readUInt16LE(pos + 8);
    const size = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const name = buf.toString('utf8', pos + 30, pos + 30 + nameLen);
    const start = pos + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + size);
    files[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    pos = start + size;
  }
  return files;
}

const unescape = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// → { files, sheets: [{ name, rows: [[...]] }] }  (عدد به‌صورت number، خانه‌ی خالی null)
export function readXlsx(bytes) {
  const files = unzip(bytes);
  const names = [...files['xl/workbook.xml'].matchAll(/<sheet name="([^"]*)"/g)].map((m) => unescape(m[1]));
  const sheets = names.map((name, i) => {
    const xml = files[`xl/worksheets/sheet${i + 1}.xml`];
    const rows = [...xml.matchAll(/<row r="\d+">(.*?)<\/row>/g)].map((rm) => {
      const row = [];
      for (const c of rm[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>(.*?)<\/c>/g)) {
        const idx = colIndex(c[1]);
        const inline = c[3].match(/<t[^>]*>(.*?)<\/t>/);
        const v = c[3].match(/<v>(.*?)<\/v>/);
        row[idx] = inline ? unescape(inline[1]) : v ? Number(v[1]) : null;
      }
      return Array.from(row, (x) => (x === undefined ? null : x));
    });
    return { name, rows };
  });
  return { files, sheets };
}
