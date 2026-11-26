/**
 * 极简 xlsx 读写（无第三方依赖）。
 *
 * 只做「二维表 ↔ .xlsx」这一件事：写出的文件用 store 方式打包（不压缩），
 * 内容全部用 inlineStr + 数字两种单元格类型，Excel / WPS / Numbers 都能打开；
 * 读取时按中央目录解包，压缩块用 DecompressionStream('deflate-raw') 解压，
 * 只取第一张工作表的可见文本与数字。
 *
 * 刻意不做的事：多工作表、公式求值、单元格格式、合并单元格、日期序列还原
 * （Excel 把日期存成数字，读回来就是那个数字，导入数据库前由用户自己确认）。
 */

export type SheetCell = string | number | null;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const encodeText = (text: string) => new TextEncoder().encode(text);

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** store（不压缩）方式打包 zip；xlsx 允许，体积换实现复杂度 */
function zipStore(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (view: DataView, position: number, value: number) => view.setUint16(position, value, true);
  const u32 = (view: DataView, position: number, value: number) => view.setUint32(position, value, true);

  for (const entry of entries) {
    const nameBytes = encodeText(entry.name);
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    u32(localView, 0, 0x04034b50);
    u16(localView, 4, 20);
    u16(localView, 6, 0x0800); // UTF-8 文件名
    u16(localView, 8, 0); // store
    u16(localView, 10, 0);
    u16(localView, 12, 0);
    u32(localView, 14, crc);
    u32(localView, 18, entry.data.length);
    u32(localView, 22, entry.data.length);
    u16(localView, 26, nameBytes.length);
    u16(localView, 28, 0);
    local.set(nameBytes, 30);

    chunks.push(local, entry.data);

    const dir = new Uint8Array(46 + nameBytes.length);
    const dirView = new DataView(dir.buffer);
    u32(dirView, 0, 0x02014b50);
    u16(dirView, 4, 20);
    u16(dirView, 6, 20);
    u16(dirView, 8, 0x0800);
    u16(dirView, 10, 0);
    u16(dirView, 12, 0);
    u16(dirView, 14, 0);
    u32(dirView, 16, crc);
    u32(dirView, 20, entry.data.length);
    u32(dirView, 24, entry.data.length);
    u16(dirView, 28, nameBytes.length);
    u16(dirView, 30, 0);
    u16(dirView, 32, 0);
    u16(dirView, 34, 0);
    u16(dirView, 36, 0);
    u32(dirView, 38, 0);
    u32(dirView, 42, offset);
    dir.set(nameBytes, 46);
    central.push(dir);

    offset += local.length + entry.data.length;
  }

  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  u32(endView, 0, 0x06054b50);
  u16(endView, 8, entries.length);
  u16(endView, 10, entries.length);
  u32(endView, 12, centralSize);
  u32(endView, 16, offset);

  const total = offset + centralSize + end.length;
  const output = new Uint8Array(total);
  let position = 0;
  for (const chunk of [...chunks, ...central, end]) {
    output.set(chunk, position);
    position += chunk.length;
  }
  return output;
}

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const columnName = (index: number) => {
  let name = "";
  let value = index + 1;
  while (value > 0) {
    const rest = (value - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
};

/** 把二维表写成 xlsx 字节流；表名里 Excel 不允许的字符会被替换 */
export function writeXlsx(sheetName: string, rows: SheetCell[][]): Uint8Array {
  const safeName = (sheetName || "Sheet1").replace(/[\\/?*[\]:]/g, "_").slice(0, 31) || "Sheet1";

  const rowXml = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          if (value === null || value === undefined || value === "") return "";
          const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
          if (typeof value === "number" && Number.isFinite(value)) {
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");

  const files: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      data: encodeText(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
          `</Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: encodeText(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
          `</Relationships>`,
      ),
    },
    {
      name: "xl/workbook.xml",
      data: encodeText(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
          `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
          `<sheets><sheet name="${escapeXml(safeName)}" sheetId="1" r:id="rId1"/></sheets>` +
          `</workbook>`,
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: encodeText(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
          `</Relationships>`,
      ),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: encodeText(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
          `<sheetData>${rowXml}</sheetData>` +
          `</worksheet>`,
      ),
    },
  ];

  return zipStore(files);
}

/** 解包 zip：支持 store 与 deflate，返回文件名 → 原始字节 */
async function unzip(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 从尾部往前找 EOCD（签名 0x06054b50），最多回退 64KB
  let eocd = -1;
  for (let position = bytes.length - 22; position >= Math.max(0, bytes.length - 65558); position -= 1) {
    if (view.getUint32(position, true) === 0x06054b50) { eocd = position; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 Excel 文件（缺少 ZIP 目录）");

  const count = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder("utf-8");
  const files: Record<string, Uint8Array> = {};

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(pointer, true) !== 0x02014b50) break;
    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const name = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(start, start + compressedSize);

    if (method === 0) files[name] = raw;
    else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      files[name] = new Uint8Array(await new Response(stream).arrayBuffer());
    } else throw new Error(`不支持的压缩方式 ${method}，请另存为 .xlsx 后重试`);

    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const textOf = (node: Element) => Array.from(node.getElementsByTagName("t")).map(item => item.textContent || "").join("");

/** 读取第一张工作表，返回逐行的字符串二维表（数字保持字面值） */
export async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  const files = await unzip(bytes);
  const parser = new DOMParser();
  const readXml = (name: string) => {
    const data = files[name];
    if (!data) return null;
    return parser.parseFromString(new TextDecoder("utf-8").decode(data), "application/xml");
  };

  const workbook = readXml("xl/workbook.xml");
  const rels = readXml("xl/_rels/workbook.xml.rels");
  let sheetPath = "xl/worksheets/sheet1.xml";

  const firstSheet = workbook?.getElementsByTagName("sheet")[0];
  const relationId = firstSheet?.getAttribute("r:id") || firstSheet?.getAttribute("id");
  if (relationId && rels) {
    for (const relation of Array.from(rels.getElementsByTagName("Relationship"))) {
      if (relation.getAttribute("Id") !== relationId) continue;
      const target = relation.getAttribute("Target") || "";
      sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    }
  }

  const sheet = readXml(sheetPath);
  if (!sheet) throw new Error("Excel 文件里没有找到工作表");

  const shared = (readXml("xl/sharedStrings.xml")?.getElementsByTagName("si") || []);
  const sharedStrings = Array.from(shared).map(item => textOf(item));

  const rows: string[][] = [];
  for (const row of Array.from(sheet.getElementsByTagName("row"))) {
    const values: string[] = [];
    let nextIndex = 0;
    for (const cell of Array.from(row.getElementsByTagName("c"))) {
      const reference = cell.getAttribute("r") || "";
      const letters = /^[A-Z]+/.exec(reference)?.[0] || "";
      let columnIndex = 0;
      for (const letter of letters) columnIndex = columnIndex * 26 + (letter.charCodeAt(0) - 64);
      columnIndex = columnIndex > 0 ? columnIndex - 1 : nextIndex;
      nextIndex = columnIndex + 1;

      const type = cell.getAttribute("t");
      let value = "";
      if (type === "inlineStr") value = textOf(cell);
      else {
        const raw = cell.getElementsByTagName("v")[0]?.textContent ?? "";
        value = type === "s" ? sharedStrings[Number(raw)] ?? "" : raw;
      }
      values[columnIndex] = value;
    }
    rows.push(Array.from(values, item => item ?? ""));
  }

  // 去掉尾部整行为空的行（Excel 常在末尾留下空 row）
  while (rows.length > 0 && rows[rows.length - 1].every(item => item === "")) rows.pop();
  return rows;
}

/** 二维表 → CSV 文本（与 CSV 导入共用同一套转义） */
export function rowsToCsv(rows: string[][]): string {
  // Excel 的尾部空单元格常被省略，行与行宽度可能不一致；
  // 补齐到最大列数，否则后端按表头长度校验时会报「列数不匹配」。
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return rows
    .map(row => {
      const cells = row.slice();
      while (cells.length < width) cells.push("");
      return cells
        .map(cell => {
          const text = cell ?? "";
          return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(",");
    })
    .join("\r\n");
}
