import { deflateRawSync } from 'node:zlib'

/**
 * A minimal ZIP writer.
 *
 * The server has no runtime dependencies and this is not the place to start: a
 * bundle is a handful of text files, and ZIP is a format with a small stored-entry
 * path that can be written by hand in a few dozen lines. Deflate is used when it
 * helps (zlib is built in), with a stored fallback when it does not.
 *
 * Layout: local file header + name + data, per entry, then the central directory,
 * then the end-of-central-directory record.
 */

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

export function crc32(buffer) {
  let value = -1
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ -1) >>> 0
}

const dosDateTime = (date) => {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
  return { time, day }
}

/**
 * @param {Array<{ name: string, data: string | Buffer, modified?: Date }>} entries
 * @returns {Buffer}
 */
export function createZip(entries) {
  const chunks = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(String(entry.name).replaceAll('\\', '/'), 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8')
    const deflated = raw.length > 256 ? deflateRawSync(raw) : null
    // Compression is only worth it when it actually shrinks the entry.
    const compressed = deflated && deflated.length < raw.length
    const body = compressed ? deflated : raw
    const { time, day } = dosDateTime(entry.modified ?? new Date())
    const checksum = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(compressed ? 8 : 0, 8) // method: deflate or stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    chunks.push(local, name, body)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4) // version made by
    header.writeUInt16LE(20, 6) // version needed
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(compressed ? 8 : 0, 10)
    header.writeUInt16LE(time, 12)
    header.writeUInt16LE(day, 14)
    header.writeUInt32LE(checksum, 16)
    header.writeUInt32LE(body.length, 20)
    header.writeUInt32LE(raw.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt16LE(0, 30) // extra
    header.writeUInt16LE(0, 32) // comment
    header.writeUInt16LE(0, 34) // disk
    header.writeUInt16LE(0, 36) // internal attributes
    header.writeUInt32LE(0, 38) // external attributes
    header.writeUInt32LE(offset, 42)
    central.push(header, name)

    offset += local.length + name.length + body.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4) // disk
  end.writeUInt16LE(0, 6) // disk with central directory
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...chunks, centralBuffer, end])
}
