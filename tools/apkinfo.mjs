// apkinfo.mjs <apk>... : sha256, versionName/versionCode (binary manifest), v2/v3 signer cert sha256.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

function eocd(b) { for (let i = b.length - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) return i; throw new Error('no EOCD'); }
function entry(b, name) {
  const e = eocd(b); const cdOff = b.readUInt32LE(e + 16); const n = b.readUInt16LE(e + 10);
  let p = cdOff;
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), fl = b.readUInt16LE(p + 28), el = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32), lo = b.readUInt32LE(p + 42);
    const nm = b.toString('utf8', p + 46, p + 46 + fl);
    if (nm === name) {
      const lfl = b.readUInt16LE(lo + 26), lel = b.readUInt16LE(lo + 28); const data = b.subarray(lo + 30 + lfl + lel, lo + 30 + lfl + lel + csize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + fl + el + cl;
  }
  return null;
}
function manifest(x) {
  // minimal AXML: string pool + start-element attributes
  let p = 8, strings = [];
  while (p < x.length) {
    const type = x.readUInt16LE(p), hsz = x.readUInt16LE(p + 2), size = x.readUInt32LE(p + 4);
    if (type === 0x0001) {
      const cnt = x.readUInt32LE(p + 8), flags = x.readUInt32LE(p + 16), sOff = x.readUInt32LE(p + 20); const utf8 = (flags & 0x100) !== 0;
      for (let i = 0; i < cnt; i++) {
        let q = p + sOff + x.readUInt32LE(p + 28 + i * 4);
        if (utf8) { let l = x[q++]; if (l & 0x80) q++; let bl = x[q++]; if (bl & 0x80) { bl = ((bl & 0x7f) << 8) | x[q++]; } strings.push(x.toString('utf8', q, q + bl)); }
        else { let l = x.readUInt16LE(q); q += 2; if (l & 0x8000) { l = ((l & 0x7fff) << 16) | x.readUInt16LE(q); q += 2; } strings.push(x.toString('utf16le', q, q + l * 2)); }
      }
    } else if (type === 0x0102) {
      const name = strings[x.readUInt32LE(p + 20)];
      if (name === 'manifest') {
        const aStart = x.readUInt16LE(p + 24), aSize = x.readUInt16LE(p + 26), aCnt = x.readUInt16LE(p + 28); const out = {};
        for (let i = 0; i < aCnt; i++) {
          const a = p + 16 + aStart + i * aSize; const an = strings[x.readUInt32LE(a + 4)]; const raw = x.readInt32LE(a + 8); const dt = x[a + 15]; const dv = x.readUInt32LE(a + 16);
          out[an] = raw >= 0 ? strings[raw] : (dt === 3 ? strings[dv] : dv);
        }
        return out;
      }
    }
    p += size;
  }
  return {};
}
function signerCerts(b) {
  const e = eocd(b); const cdOff = b.readUInt32LE(e + 16);
  if (b.toString('latin1', cdOff - 16, cdOff) !== 'APK Sig Block 42') return { error: 'no signing block' };
  const sz = Number(b.readBigUInt64LE(cdOff - 24)); const start = cdOff - sz - 8;
  let p = start + 8; const res = {};
  while (p < cdOff - 24) {
    const len = Number(b.readBigUInt64LE(p)); const id = b.readUInt32LE(p + 8); const v = b.subarray(p + 12, p + 8 + len);
    if (id === 0x7109871a || id === 0xf05368c0) {
      // signers seq -> signer -> signed data -> digests, certificates
      const signers = v.subarray(4, 4 + v.readUInt32LE(0));
      const signer = signers.subarray(4, 4 + signers.readUInt32LE(0));
      const sd = signer.subarray(4, 4 + signer.readUInt32LE(0));
      const dl = sd.readUInt32LE(0); const certs = sd.subarray(4 + dl + 4, 4 + dl + 4 + sd.readUInt32LE(4 + dl));
      const c = certs.subarray(4, 4 + certs.readUInt32LE(0));
      res[id === 0x7109871a ? 'v2' : 'v3'] = crypto.createHash('sha256').update(c).digest('hex');
    }
    p += 8 + len;
  }
  return res;
}
for (const f of process.argv.slice(2)) {
  const b = fs.readFileSync(f);
  const m = manifest(entry(b, 'AndroidManifest.xml'));
  console.log(JSON.stringify({ file: f.split(/[\\/]/).pop(), sha256: crypto.createHash('sha256').update(b).digest('hex'), versionName: m.versionName, versionCode: m.versionCode, package: m.package, cert: signerCerts(b) }));
}
