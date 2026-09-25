// 轻量 OOXML 导出：只写单工作表、内联文本和数值，避免在 Worker 中引入 Node 依赖。
// 字符串始终写为 inlineStr，防止用户输入被 Excel 当作公式执行。
const encoder = new TextEncoder();
const escapeXml = value => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function columnName(index) {
  let value = index + 1;
  let name = '';
  while (value) { value--; name = String.fromCharCode(65 + value % 26) + name; value = Math.floor(value / 26); }
  return name;
}

function sheetXml(rows) {
  const body = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, column) => {
    const cell = `${columnName(column)}${rowIndex + 1}`;
    if (value == null) return '';
    if (value instanceof Date) {
      const serial = (value.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;
      return `<c r="${cell}" s="1"><v>${serial}</v></c>`;
    }
    if (typeof value === 'object' && value.format === 'percent' && Number.isFinite(value.value)) return `<c r="${cell}" s="2"><v>${value.value}</v></c>`;
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${cell}"><v>${value}</v></c>`;
    return `<c r="${cell}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="18"/><sheetData>${body}</sheetData></worksheet>`;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(view, offset, value) { view.setUint16(offset, value, true); }
function u32(view, offset, value) { view.setUint32(offset, value, true); }

function zip(files) {
  const parts = [];
  const centers = [];
  let offset = 0;
  for (const [name, content] of files) {
    const filename = encoder.encode(name);
    const data = encoder.encode(content);
    const crc = crc32(data);
    const local = new Uint8Array(30 + filename.length + data.length);
    const header = new DataView(local.buffer);
    u32(header, 0, 0x04034b50); u16(header, 4, 20); u16(header, 8, 0);
    u32(header, 14, crc); u32(header, 18, data.length); u32(header, 22, data.length);
    u16(header, 26, filename.length);
    local.set(filename, 30); local.set(data, 30 + filename.length);
    parts.push(local);
    const central = new Uint8Array(46 + filename.length);
    const directory = new DataView(central.buffer);
    u32(directory, 0, 0x02014b50); u16(directory, 4, 20); u16(directory, 6, 20);
    u32(directory, 16, crc); u32(directory, 20, data.length); u32(directory, 24, data.length);
    u16(directory, 28, filename.length); u32(directory, 42, offset);
    central.set(filename, 46); centers.push(central);
    offset += local.length;
  }
  const centralSize = centers.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const ending = new DataView(end.buffer);
  u32(ending, 0, 0x06054b50); u16(ending, 8, files.length); u16(ending, 10, files.length);
  u32(ending, 12, centralSize); u32(ending, 16, offset);
  const output = new Uint8Array(offset + centralSize + end.length);
  let position = 0;
  for (const part of [...parts, ...centers, end]) { output.set(part, position); position += part.length; }
  return output;
}

export function pollWorkbook(name, rows) {
  const safeName = escapeXml(String(name).slice(0, 31) || '投票数据');
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeName}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>'],
    ['xl/worksheets/sheet1.xml', sheetXml(rows)],
  ]);
}
