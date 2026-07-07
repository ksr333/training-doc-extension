// minizip.js — Minimal ZIP encoder for base64 image files (STORE/no-compression)
// Usage: MiniZip.create([{name:'01-foo.jpg', dataUrl:'data:image/jpeg;base64,...'}]) → Blob
const MiniZip = (() => {
  function u16(n) { return [n & 0xff, (n >> 8) & 0xff]; }
  function u32(n) { return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]; }

  // Pre-computed CRC-32 table
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function create(files) {
    const enc = new TextEncoder();
    const localParts = [];  // Uint8Arrays: local headers + raw data
    const cdEntries  = [];  // Uint8Arrays: central directory entries
    let   offset     = 0;  // running byte offset

    for (const { name, dataUrl } of files) {
      const b64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
      const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const crc = crc32(raw);
      const nl  = enc.encode(name);
      const rl  = raw.length;

      // Local file header — 30 bytes + filename
      // Sig(4) VersionNeeded(2) Flag(2) Method(2) Time(2) Date(2) CRC(4)
      // CompSize(4) UncompSize(4) NameLen(2) ExtraLen(2) Name(n)
      const localHdr = new Uint8Array([
        0x50, 0x4b, 0x03, 0x04,  // signature
        20, 0,                    // version needed: 2.0
        0, 0,                     // general purpose bit flag
        0, 0,                     // compression method: STORE
        0, 0,                     // last mod time
        0, 0,                     // last mod date
        ...u32(crc),
        ...u32(rl),               // compressed size
        ...u32(rl),               // uncompressed size
        ...u16(nl.length),
        0, 0,                     // extra field length
        ...nl
      ]);
      localParts.push(localHdr, raw);

      // Central directory entry — 46 bytes + filename
      // Sig(4) VersionMadeBy(2) VersionNeeded(2) Flag(2) Method(2)
      // Time(2) Date(2) CRC(4) CompSize(4) UncompSize(4)
      // NameLen(2) ExtraLen(2) CommentLen(2) DiskStart(2)
      // InternalAttr(2) ExternalAttr(4) LocalHdrOffset(4) Name(n)
      cdEntries.push(new Uint8Array([
        0x50, 0x4b, 0x01, 0x02,  // signature
        20, 0,                    // version made by
        20, 0,                    // version needed
        0, 0,                     // bit flag
        0, 0,                     // compression method
        0, 0,                     // last mod time
        0, 0,                     // last mod date
        ...u32(crc),
        ...u32(rl),               // compressed size
        ...u32(rl),               // uncompressed size
        ...u16(nl.length),
        0, 0,                     // extra field length
        0, 0,                     // file comment length
        0, 0,                     // disk number start
        0, 0,                     // internal file attributes
        0, 0, 0, 0,               // external file attributes
        ...u32(offset),           // relative offset of local header
        ...nl
      ]));

      offset += localHdr.length + rl;
    }

    const cdSize = cdEntries.reduce((n, e) => n + e.length, 0);
    const n = files.length;

    // End of central directory — 22 bytes
    // Sig(4) DiskNum(2) DiskWithCD(2) EntriesOnDisk(2) TotalEntries(2)
    // CDSize(4) CDOffset(4) CommentLen(2)
    const eocd = new Uint8Array([
      0x50, 0x4b, 0x05, 0x06,
      0, 0,                   // disk number
      0, 0,                   // disk with start of CD
      ...u16(n),              // entries on this disk
      ...u16(n),              // total entries
      ...u32(cdSize),         // size of central directory
      ...u32(offset),         // offset of CD from start of archive
      0, 0                    // comment length
    ]);

    return new Blob([...localParts, ...cdEntries, eocd], { type: 'application/zip' });
  }

  return { create };
})();
