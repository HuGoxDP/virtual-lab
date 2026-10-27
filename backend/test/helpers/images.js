// backend/test/helpers/images.js
//
// Cover-image fixtures built at run time: just enough of a PNG or JPEG for the header parser
// in `preview-image.js` (signature + dimensions), not decodable pictures. `padTo` appends
// trailing bytes so a file can sit exactly on a size boundary.

/** A PNG header: signature, an IHDR chunk of `width` x `height`, and IEND. */
function png(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, data, Buffer.alloc(4)]); // the CRC is not checked by the parser
  };
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A JPEG: SOI, a JFIF APP0 segment, an SOF0 frame header of `width` x `height`, EOI. */
function jpeg(width, height) {
  const app0 = Buffer.from('ffe000104a46494600010100000100010000', 'hex');
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);   // segment length
  sof[4] = 8;                 // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;                 // components
  return Buffer.concat([Buffer.from('ffd8', 'hex'), app0, sof, Buffer.from('ffd9', 'hex')]);
}

/** `buffer` followed by zero bytes up to exactly `size` bytes. */
function padTo(buffer, size) {
  if (buffer.length > size) throw new Error(`fixture is already ${buffer.length} bytes`);
  return Buffer.concat([buffer, Buffer.alloc(size - buffer.length)]);
}

const MIB = 1024 * 1024;

module.exports = { png, jpeg, padTo, MIB };
