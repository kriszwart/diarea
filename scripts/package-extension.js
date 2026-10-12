/* Builds the extension and zips it for the Chrome Web Store:
 *
 *   npm run package:extension   ->  dist/diarea-extension-<version>.zip
 *
 * Plain Node (zlib), no zip tool needed. The zip holds exactly what Chrome
 * loads: manifest, popup, icons and the generated lib/ engine copy.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [path.join(root, "scripts/build.js"), "extension"], { stdio: "inherit" });

const extDir = path.join(root, "extension");
const { version } = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));

const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
})(extDir);

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const local = [], central = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(path.relative(extDir, file).split(path.sep).join("/"));
  const data = fs.readFileSync(file);
  const packed = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0, 6);
  head.writeUInt16LE(8, 8); head.writeUInt16LE(0, 10); head.writeUInt16LE(0x21, 12); // deflate, fixed 1980-01-01 date so zips are reproducible
  head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
  local.push(head, name, packed);
  const dirEntry = Buffer.alloc(46);
  dirEntry.writeUInt32LE(0x02014b50, 0); dirEntry.writeUInt16LE(20, 4); dirEntry.writeUInt16LE(20, 6);
  dirEntry.writeUInt16LE(0, 8); dirEntry.writeUInt16LE(8, 10); dirEntry.writeUInt16LE(0, 12); dirEntry.writeUInt16LE(0x21, 14);
  dirEntry.writeUInt32LE(crc, 16); dirEntry.writeUInt32LE(packed.length, 20); dirEntry.writeUInt32LE(data.length, 24);
  dirEntry.writeUInt16LE(name.length, 28); dirEntry.writeUInt32LE(offset, 42);
  central.push(dirEntry, name);
  offset += head.length + name.length + packed.length;
}
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);

const outDir = path.join(root, "dist");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `diarea-extension-${version}.zip`);
fs.writeFileSync(out, Buffer.concat([...local, centralBuf, end]));
console.log(`Packed ${files.length} files into ${path.relative(root, out)}`);
