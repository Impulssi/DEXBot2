
import { getNodeRequire } from '../../env';
'use strict';

const _require = getNodeRequire();
let _Buffer: any;
const Buffer = new Proxy({} as any, {
    get(_, prop) {
        if (!_Buffer && _require) _Buffer = _require('buffer').Buffer;
        return _Buffer ? _Buffer[prop] : undefined;
    }
});

class BufferWriter {
    buf: Buffer;

    constructor() {
        this.buf = Buffer.alloc(0);
    }

    get length(): number { return this.buf.length; }

    toBuffer(): Buffer { return this.buf; }

    write(array: Buffer | Uint8Array | number[]): this {
        this.buf = Buffer.concat([this.buf, Buffer.isBuffer(array) ? array : Buffer.from(array)]);
        return this;
    }

    writeUint8(v: number): this {
        const b = Buffer.alloc(1);
        b.writeUInt8(v, 0);
        this.buf = Buffer.concat([this.buf, b]);
        return this;
    }

    writeUint16(v: number): this {
        const b = Buffer.alloc(2);
        b.writeUInt16LE(v, 0);
        this.buf = Buffer.concat([this.buf, b]);
        return this;
    }

    writeUint32(v: number): this {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(v, 0);
        this.buf = Buffer.concat([this.buf, b]);
        return this;
    }

    writeInt16(v: number): this {
        const b = Buffer.alloc(2);
        b.writeInt16LE(v, 0);
        this.buf = Buffer.concat([this.buf, b]);
        return this;
    }

    writeInt32(v: number): this {
        const b = Buffer.alloc(4);
        b.writeInt32LE(v, 0);
        this.buf = Buffer.concat([this.buf, b]);
        return this;
    }

    writeInt64(v: number | bigint | string): this {
        const b = Buffer.alloc(8);
        b.writeBigInt64LE(BigInt(v), 0);
        this.buf = Buffer.concat([this.buf, b]);
        return this;
    }

    writeUint64(v: number | bigint | string): this {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(BigInt(v), 0);
        this.buf = Buffer.concat([this.buf, b]);
        return this;
    }

    writeVarint32(v: number): this {
        v = v >>> 0;
        do {
            let b = v & 0x7F;
            v >>>= 7;
            if (v === 0) {
                this.writeUint8(b);
                return this;
            }
            b |= 0x80;
            this.writeUint8(b);
        } while (true);
    }

    writeVarint64(v: number | bigint | string): this {
        v = BigInt(v);
        do {
            const b = Number(v & 0x7Fn);
            v >>= 7n;
            if (v === 0n) {
                this.writeUint8(b);
                return this;
            }
            this.writeUint8(b | 0x80);
        } while (true);
    }

    flip(): this {
        return this;
    }

    append(src: BufferWriter | Buffer | Uint8Array): this {
        if (src instanceof BufferWriter) {
            this.buf = Buffer.concat([this.buf, src.buf]);
        } else {
            this.buf = Buffer.concat([this.buf, Buffer.isBuffer(src) ? src : Buffer.from(src)]);
        }
        return this;
    }
}

class BufferReader {
    buffer: Buffer;
    offset: number;

    constructor(buffer: Buffer, offset: number = 0) {
        if (!Buffer.isBuffer(buffer)) {
            throw new Error('BufferReader requires a Buffer');
        }
        this.buffer = buffer;
        this.offset = offset;
    }

    get length(): number { return this.buffer.length - this.offset; }
    isEnd(): boolean { return this.offset >= this.buffer.length; }

    read(length: number): Buffer {
        if (this.offset + length > this.buffer.length) {
            throw new Error(`BufferReader: attempted to read ${length} bytes at offset ${this.offset} (buffer size: ${this.buffer.length})`);
        }
        const slice = this.buffer.slice(this.offset, this.offset + length);
        this.offset += length;
        return slice;
    }

    skip(length: number): void {
        this.offset += length;
    }

    readUint8(): number {
        const v = this.buffer.readUInt8(this.offset);
        this.offset += 1;
        return v;
    }

    readUint16(): number {
        const v = this.buffer.readUInt16LE(this.offset);
        this.offset += 2;
        return v;
    }

    readUint32(): number {
        const v = this.buffer.readUInt32LE(this.offset);
        this.offset += 4;
        return v;
    }

    readInt32(): number {
        const v = this.buffer.readInt32LE(this.offset);
        this.offset += 4;
        return v;
    }

    readInt64(): number | string {
        const v = this.buffer.readBigInt64LE(this.offset);
        this.offset += 8;
        return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(v)
            : v.toString();
    }

    readUint64(): number | string {
        const v = this.buffer.readBigUInt64LE(this.offset);
        this.offset += 8;
        return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
    }

    readVarint32(): number {
        let v = 0, b = 0, shift = 0;
        do {
            b = this.readUint8();
            v |= (b & 0x7F) << shift;
            shift += 7;
            if (!(b & 0x80)) break;
        } while (shift < 35);
        return v | 0;
    }

    readVarint64(): bigint {
        let v = 0n, b = 0, shift = 0;
        do {
            b = this.readUint8();
            v |= BigInt(b & 0x7F) << BigInt(shift);
            shift += 7;
            if (!(b & 0x80)) break;
        } while (shift < 70);
        return v;
    }

    copy(offset: number, end?: number): Buffer {
        return this.buffer.slice(offset, end);
    }

    toString(encoding?: BufferEncoding): string {
        return this.buffer.slice(this.offset).toString(encoding || 'hex');
    }
}

export interface SerializerInstance {
    _name: string;
    _types: Record<string, SerialType>;
    _keys: string[];
    fromByteBuffer(b: BufferReader): Record<string, any>;
    appendByteBuffer(b: BufferWriter, obj: any): void;
    toObject(obj: any, debug?: any): Record<string, any>;
    fromObject(obj: any): Record<string, any>;
    toBuffer(obj: any): Buffer;
    fromBuffer(buf: Buffer): Record<string, any>;
    toHex(obj: any): string;
    fromHex(hex: string): Record<string, any>;
}

interface SerialType {
    fromByteBuffer(b: BufferReader): any;
    appendByteBuffer(b: BufferWriter, v: any): void;
    fromObject(v: any): any;
    toObject(v: any, debug?: any): any;
}

function Serializer(operation_name: string, types: Record<string, SerialType>): SerializerInstance {
    const typeKeys = Object.keys(types);

    const s: SerializerInstance = {
        _name: operation_name,
        _types: types,
        _keys: typeKeys,

        fromByteBuffer(b: BufferReader): Record<string, any> {
            const result: Record<string, any> = {};
            for (const key of typeKeys) {
                result[key] = types[key].fromByteBuffer(b);
            }
            return result;
        },

        appendByteBuffer(b: BufferWriter, obj: any): void {
            if (!obj) throw new Error(`missing object for ${operation_name}`);
            for (const key of typeKeys) {
                const val = obj[key];
                types[key].appendByteBuffer(b, val);
            }
        },

        toObject(obj: any, debug?: any): Record<string, any> {
            if (!obj) {
                if (debug && debug.use_default) {
                    const result: Record<string, any> = {};
                    for (const key of typeKeys) {
                        result[key] = types[key].toObject(undefined, debug);
                    }
                    return result;
                }
                throw new Error(`missing object for ${operation_name}`);
            }
            const result: Record<string, any> = {};
            for (const key of typeKeys) {
                result[key] = types[key].toObject(obj[key], debug);
            }
            return result;
        },

        fromObject(obj: any): Record<string, any> {
            if (!obj) throw new Error(`missing object for ${operation_name}`);
            const result: Record<string, any> = {};
            for (const key of typeKeys) {
                result[key] = types[key].fromObject(obj[key]);
            }
            return result;
        },

        toBuffer(obj: any): Buffer {
            const w = new BufferWriter();
            s.appendByteBuffer(w, obj);
            return w.toBuffer();
        },

        fromBuffer(buf: Buffer): Record<string, any> {
            return s.fromByteBuffer(new BufferReader(buf));
        },

        toHex(obj: any): string {
            return s.toBuffer(obj).toString('hex');
        },

        fromHex(hex: string): Record<string, any> {
            return s.fromBuffer(Buffer.from(hex, 'hex'));
        },
    };

    return s;
}

export { Serializer, BufferWriter, BufferReader }

