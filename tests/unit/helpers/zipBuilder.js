// Emits a real ZIP (local headers, central directory, EOCD) so tests exercise
// the same layout a downloaded 3MF has. Entry data is stored, but sizes and
// compression are declarable so a hostile archive can be described without
// building a genuinely dangerous one.
//
// `threeMfSecurityScanner.test.js` carries its own copy of this, written first
// and left alone rather than edited while delivering a feature.

function bytes(...values) {
  return Uint8Array.from(values);
}

function u16(value) {
  return bytes(value & 0xff, (value >> 8) & 0xff);
}

function u32(value) {
  return bytes(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function nameBytes(name) {
  return name instanceof Uint8Array ? name : new Uint8Array(Buffer.from(name, 'utf8'));
}

function buildZip(specs, options = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const spec of specs) {
    const rawName = nameBytes(spec.name);
    const content = spec.content ?? new Uint8Array(0);
    const compressedSize = spec.compressedSize ?? content.length;
    const uncompressedSize = spec.uncompressedSize ?? content.length;
    const method = spec.method ?? 0;
    const flags = spec.flags ?? 0x0800; // UTF-8 names
    const externalAttributes = spec.externalAttributes ?? 0;

    const local = concat([
      u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(0), u32(compressedSize), u32(uncompressedSize), u16(rawName.length), u16(0),
      rawName, content,
    ]);
    locals.push(local);

    centrals.push(
      concat([
        u32(0x02014b50), u16(20), u16(20), u16(flags), u16(method), u16(0), u16(0),
        u32(0), u32(compressedSize), u32(uncompressedSize),
        u16(rawName.length), u16(0), u16(0), u16(0), u16(0),
        u32(externalAttributes), u32(offset), rawName,
      ])
    );
    offset += local.length;
  }

  const centralDirectory = concat(centrals);
  const comment = nameBytes(options.comment ?? '');
  const declaredCount = options.declaredEntryCount ?? specs.length;

  const eocd = concat([
    u32(0x06054b50), u16(0), u16(0), u16(declaredCount), u16(declaredCount),
    u32(centralDirectory.length), u32(offset), u16(comment.length), comment,
  ]);

  return concat([...locals, centralDirectory, eocd]);
}

/** The three parts a 3MF must contain, plus whatever the test adds. */
function threeMf(extra = []) {
  return buildZip([
    { name: '[Content_Types].xml', content: nameBytes('<Types/>') },
    { name: '_rels/.rels', content: nameBytes('<Relationships/>') },
    { name: '3D/3dmodel.model', content: nameBytes('<model/>') },
    ...extra,
  ]);
}

module.exports = { buildZip, concat, nameBytes, threeMf, u16, u32 };
