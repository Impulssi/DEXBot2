'use strict';

import { createRequire } from 'node:module';
import * as CC from './chain_constants.js';
import { BufferWriter } from './serializer.js';
import { OBJECT_TYPE } from './chain_constants.js';

const _require = createRequire(import.meta.url);
let _Buffer: any;
const Buffer = new Proxy({} as any, {
    get(_, prop) {
        if (!_Buffer && _require) _Buffer = _require('buffer').Buffer;
        return _Buffer ? _Buffer[prop] : undefined;
    }
});



interface BufWriter {
    buf: Buffer;
    length: number;
    toBuffer(): Buffer;
    write(array: Buffer | Uint8Array | number[]): this;
    writeUint8(v: number): this;
    writeUint16(v: number): this;
    writeUint32(v: number): this;
    writeInt16(v: number): this;
    writeInt32(v: number): this;
    writeInt64(v: number | bigint | string): this;
    writeUint64(v: number | bigint | string): this;
    writeVarint32(v: number): this;
    writeVarint64(v: number | bigint | string): this;
    flip(): this;
    append(src: BufWriter | Buffer | Uint8Array): this;
}

interface BufReader {
    buffer: Buffer;
    offset: number;
    length: number;
    isEnd(): boolean;
    read(length: number): Buffer;
    skip(length: number): void;
    readUint8(): number;
    readUint16(): number;
    readUint32(): number;
    readInt32(): number;
    readInt64(): number | string;
    readUint64(): number | string;
    readVarint32(): number;
    readVarint64(): bigint;
    copy(offset: number, end?: number): Buffer;
    toString(encoding?: BufferEncoding): string;
}

const { RESERVED_SPACES } = CC;

export interface SerType {
    fromByteBuffer(b: BufReader): any;
    appendByteBuffer(b: BufWriter, v: any): void;
    fromObject(v: any): any;
    toObject(v: any, debug?: any): any;
    compare?: (a: any, b: any) => number;
    nosort?: boolean;
    st_operations?: any[];
    validate?: (arr: any[]) => any[];
}

const isDigits = (v: any): boolean => /^-?\d+$/.test(String(v));
const toNumber = (v: any): number => {
    if (typeof v === 'number') return v;
    return isDigits(v) ? Number(v) : NaN;
};
const int64ToSafeValue = (n: bigint): number | string => (
    n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(n)
        : n.toString()
);
const $required = (obj: any, name?: string): void => { if (obj == null) throw new Error(`${name || 'value'} required`); };
const requireRange = (min: number, max: number, v: any, name?: string): void => {
    if (v < min || v > max) throw new Error(`${name || 'value'} out of range [${min}, ${max}]: ${v}`);
};

const strCmp = (a: any, b: any): number => a > b ? 1 : a < b ? -1 : 0;
const firstEl = (el: any): any => Array.isArray(el) ? el[0] : el;

function sortOperation(array: any[], st_operation?: any): any[] {
    if (!st_operation) return array;
    if (st_operation.compare) {
        return array.sort((a: any, b: any) => st_operation.compare(firstEl(a), firstEl(b)));
    }
    if (st_operation.nosort) return array;
    return array.sort((a: any, b: any) => {
        const fa = firstEl(a);
        const fb = firstEl(b);
        if (typeof fa === 'number' && typeof fb === 'number') return fa - fb;
        if (Buffer.isBuffer(fa) && Buffer.isBuffer(fb)) return strCmp(fa.toString('hex'), fb.toString('hex'));
        return strCmp(String(fa), String(fb));
    });
}

const void_type: SerType = {
    fromByteBuffer(): any { return undefined; },
    appendByteBuffer(): void { /* void serializes to zero bytes */ },
    fromObject(): any { return undefined; },
    toObject(object: any, debug?: any): any {
        if (debug && debug.use_default && object === undefined) return undefined;
        return undefined;
    },
};

const uint8: SerType = {
    fromByteBuffer(b: BufReader): number { return b.readUint8(); },
    appendByteBuffer(b: BufWriter, v: any): void { requireRange(0, 0xFF, v, 'uint8'); b.writeUint8(v); },
    fromObject(v: any): any { requireRange(0, 0xFF, v, 'uint8'); return v; },
    toObject(v: any, debug?: any): any {
        if (debug && debug.use_default && v === undefined) return 0;
        requireRange(0, 0xFF, v, 'uint8');
        return parseInt(v, 10);
    },
};

const uint16: SerType = {
    fromByteBuffer(b: BufReader): number { return b.readUint16(); },
    appendByteBuffer(b: BufWriter, v: any): void { requireRange(0, 0xFFFF, v, 'uint16'); b.writeUint16(v); },
    fromObject(v: any): any { requireRange(0, 0xFFFF, v, 'uint16'); return v; },
    toObject(v: any, debug?: any): any {
        if (debug && debug.use_default && v === undefined) return 0;
        requireRange(0, 0xFFFF, v, 'uint16');
        return parseInt(v, 10);
    },
};

const uint32: SerType = {
    fromByteBuffer(b: BufReader): number { return b.readUint32(); },
    appendByteBuffer(b: BufWriter, v: any): void { requireRange(0, 0xFFFFFFFF, v, 'uint32'); b.writeUint32(v); },
    fromObject(v: any): any { requireRange(0, 0xFFFFFFFF, v, 'uint32'); return v; },
    toObject(v: any, debug?: any): any {
        if (debug && debug.use_default && v === undefined) return 0;
        requireRange(0, 0xFFFFFFFF, v, 'uint32');
        return parseInt(v, 10);
    },
};

const varint32: SerType = {
    fromByteBuffer(b: BufReader): number { return b.readVarint32(); },
    appendByteBuffer(b: BufWriter, v: any): void {
        requireRange(-2147483648, 2147483647, v, 'varint32');
        b.writeVarint32(v);
    },
    fromObject(v: any): any {
        requireRange(-2147483648, 2147483647, v, 'varint32');
        return v;
    },
    toObject(v: any, debug?: any): any {
        if (debug && debug.use_default && v === undefined) return 0;
        requireRange(-2147483648, 2147483647, v, 'varint32');
        return parseInt(v, 10);
    },
};

const int64: SerType = {
    fromByteBuffer(b: BufReader): any { return b.readInt64(); },
    appendByteBuffer(b: BufWriter, v: any): void {
        $required(v, 'int64');
        const n = BigInt(String(v));
        if (n < -0x8000000000000000n || n > 0x7FFFFFFFFFFFFFFFn) {
            throw new Error(`int64 out of range [-9223372036854775808, 9223372036854775807]: ${v}`);
        }
        b.writeInt64(n);
    },
    fromObject(v: any): any {
        $required(v, 'int64');
        const n = BigInt(String(v));
        if (n < -0x8000000000000000n || n > 0x7FFFFFFFFFFFFFFFn) {
            throw new Error(`int64 out of range [-9223372036854775808, 9223372036854775807]: ${v}`);
        }
        return int64ToSafeValue(n);
    },
    toObject(v: any, debug?: any): any {
        if (debug && debug.use_default && v === undefined) return '0';
        $required(v, 'int64');
        return String(v);
    },
};

const uint64: SerType = {
    fromByteBuffer(b: BufReader): any { return b.readUint64(); },
    appendByteBuffer(b: BufWriter, v: any): void {
        $required(v, 'uint64');
        const n = BigInt(String(v));
        if (n < 0n || n > 0xFFFFFFFFFFFFFFFFn) {
            throw new Error(`uint64 out of range [0, 18446744073709551615]: ${v}`);
        }
        const buf = Buffer.allocUnsafe(8);
        buf.writeBigUInt64LE(n, 0);
        b.write(buf);
    },
    fromObject(v: any): any {
        $required(v, 'uint64');
        const n = BigInt(String(v));
        if (n < 0n || n > 0xFFFFFFFFFFFFFFFFn) {
            throw new Error(`uint64 out of range [0, 18446744073709551615]: ${v}`);
        }
        return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString();
    },
    toObject(v: any, debug?: any): any {
        if (debug && debug.use_default && v === undefined) return '0';
        $required(v, 'uint64');
        const n = BigInt(String(v));
        if (n < 0n || n > 0xFFFFFFFFFFFFFFFFn) {
            throw new Error(`uint64 out of range [0, 18446744073709551615]: ${v}`);
        }
        return String(n);
    },
};

const string_type: SerType = {
    fromByteBuffer(b: BufReader): any {
        const len = b.readVarint32();
        const data = b.read(len);
        return Buffer.from(data).toString('utf8');
    },
    appendByteBuffer(b: BufWriter, v: any): void {
        $required(v, 'string');
        const buf = Buffer.from(String(v), 'utf8');
        b.writeVarint32(buf.length);
        b.write(buf);
    },
    fromObject(v: any): any { $required(v, 'string'); return Buffer.from(String(v), 'utf8'); },
    toObject(v: any, debug?: any): any {
        if (debug && debug.use_default && v === undefined) return '';
        return String(v);
    },
};

function bytesType(size?: number): SerType {
    return {
        fromByteBuffer(b: BufReader): any {
            if (size === undefined) {
                const len = b.readVarint32();
                return b.read(len);
            }
            return b.read(size);
        },
        appendByteBuffer(b: BufWriter, v: any): void {
            $required(v, 'bytes');
            let buf = Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'hex');
            if (size === undefined) b.writeVarint32(buf.length);
            b.write(buf);
        },
        fromObject(v: any): any {
            $required(v, 'bytes');
            if (Buffer.isBuffer(v)) return v;
            return Buffer.from(String(v), 'hex');
        },
        toObject(v: any, debug?: any): any {
            if (debug && debug.use_default && v === undefined) {
                if (size) return '00'.repeat(size);
                return '';
            }
            $required(v, 'bytes');
            if (Buffer.isBuffer(v)) return v.toString('hex');
            return String(v);
        },
    };
}

const bool_type: SerType = {
    fromByteBuffer(b: BufReader): any { return b.readUint8() === 1; },
    appendByteBuffer(b: BufWriter, v: any): void { b.writeUint8(v ? 1 : 0); },
    fromObject(v: any): any { return !!v; },
    toObject(v: any, debug?: any): any {
        if (debug && debug.use_default && v === undefined) return false;
        return !!v;
    },
};

function arrayType(st_operation: any): SerType {
    return {
        fromByteBuffer(b: BufReader): any {
            const size = b.readVarint32();
            const result: any[] = [];
            for (let i = 0; i < size; i++) {
                result.push(st_operation.fromByteBuffer(b));
            }
            return result;
        },
        appendByteBuffer(b: BufWriter, v: any): void {
            $required(v, 'array');
            b.writeVarint32(v.length);
            for (const item of v) {
                st_operation.appendByteBuffer(b, item);
            }
        },
        fromObject(v: any): any {
            $required(v, 'array');
            return v.map((item: any) => st_operation.fromObject(item));
        },
        toObject(v: any, debug?: any): any {
            if (debug && debug.use_default && v === undefined) {
                return [st_operation.toObject(undefined, debug)];
            }
            $required(v, 'array');
            return v.map((item: any) => st_operation.toObject(item, debug));
        },
    };
}

const time_point_sec: SerType = {
    fromByteBuffer(b: BufReader): any { return b.readUint32(); },
    appendByteBuffer(b: BufWriter, v: any): void {
        if (typeof v !== 'number') v = time_point_sec.fromObject(v);
        b.writeUint32(v);
    },
    fromObject(v: any): any {
        $required(v, 'time_point_sec');
        if (typeof v === 'number') return v;
        if (v instanceof Date) return Math.floor(v.getTime() / 1000);
        if (typeof v !== 'string') throw new Error('Unknown date type: ' + v);
        if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}$/.test(v)) v += 'Z';
        return Math.floor(new Date(v).getTime() / 1000);
    },
    toObject(v: any, debug?: any): any {
        if (debug && debug.use_default && v === undefined) {
            return new Date(0).toISOString().split('.')[0];
        }
        $required(v, 'time_point_sec');
        if (typeof v === 'string') return v;
        if (v instanceof Date) return v.toISOString().split('.')[0];
        const int = parseInt(v, 10);
        requireRange(0, 0xFFFFFFFF, int, 'uint32');
        return new Date(int * 1000).toISOString().split('.')[0];
    },
};

function setType(st_operation: any): SerType & { validate: (arr: any[]) => any[] } {
    function validate(arr: any[]): any[] {
        const dup: Record<string | number, boolean> = {};
        for (const item of arr) {
            const key = (typeof item === 'number' || typeof item === 'string') ? item : undefined;
            if (key !== undefined && dup[key] !== undefined) {
                throw new Error('duplicate (set)');
            }
            if (key !== undefined) dup[key] = true;
        }
        return sortOperation(arr, st_operation);
    }

    return {
        validate,
        fromByteBuffer(b: BufReader): any {
            const size = b.readVarint32();
            const result: any[] = [];
            for (let i = 0; i < size; i++) {
                result.push(st_operation.fromByteBuffer(b));
            }
            return validate(result);
        },
        appendByteBuffer(b: BufWriter, v: any): void {
            if (!v) v = [];
            const sorted = validate(v);
            b.writeVarint32(sorted.length);
            for (const item of sorted) {
                st_operation.appendByteBuffer(b, item);
            }
        },
        fromObject(v: any): any {
            if (!v) v = [];
            return validate(v.map((item: any) => st_operation.fromObject(item)));
        },
        toObject(v: any, debug?: any): any {
            if (debug && debug.use_default && v === undefined) {
                return [st_operation.toObject(undefined, debug)];
            }
            if (!v) v = [];
            return validate(v.map((item: any) => st_operation.toObject(item, debug)));
        },
    };
}

function idType(reserved_spaces: any, object_type: any): SerType & { compare?: (a: any, b: any) => number } {
    const objectTypeId = (OBJECT_TYPE as Record<string, number>)[object_type] != null ? (OBJECT_TYPE as Record<string, number>)[object_type] : object_type;
    return {
        fromByteBuffer(b: BufReader): any { return b.readVarint32(); },
        appendByteBuffer(b: BufWriter, v: any): void {
            $required(v, 'id_type');
            if (/^\d+\.\d+\.\d+$/.test(String(v))) {
                v = getInstance(reserved_spaces, object_type, v);
            }
            b.writeVarint32(toNumber(v));
        },
        fromObject(v: any): any {
            $required(v, 'id_type');
            if (isDigits(v)) return toNumber(v);
            return getInstance(reserved_spaces, object_type, v);
        },
        toObject(v: any, debug?: any): any {
            if (debug && debug.use_default && v === undefined) {
                return `${reserved_spaces}.${objectTypeId}.0`;
            }
            $required(v, 'id_type');
            if (/^\d+\.\d+\.\d+$/.test(String(v))) {
                v = getInstance(reserved_spaces, object_type, v);
            }
            return `${reserved_spaces}.${objectTypeId}.${v}`;
        },
    };
}

function getInstance(_reserved_spaces: any, _object_type: any, object: any): number {
    const parts = String(object).split('.');
    if (parts.length !== 3) throw new Error(`Invalid object ID: ${object}`);
    return parseInt(parts[2], 10);
}

function protocolIdType(name: string): SerType & { compare?: (a: any, b: any) => number } {
    return idType(RESERVED_SPACES.protocol_ids, name);
}

const object_id_type: SerType & { compare?: (a: any, b: any) => number } = {
    compare(a: ObjectId, b: ObjectId): number {
        if (a.space !== b.space) return a.space - b.space;
        if (a.type !== b.type) return a.type - b.type;
        const ai = typeof a.instance === 'bigint' ? a.instance : BigInt(a.instance);
        const bi = typeof b.instance === 'bigint' ? b.instance : BigInt(b.instance);
        return ai < bi ? -1 : ai > bi ? 1 : 0;
    },
    fromByteBuffer(b: BufReader): any {
        const long = b.readUint64();
        return ObjectId.fromLong(long);
    },
    appendByteBuffer(b: BufWriter, v: any): void {
        $required(v, 'object_id_type');
        const obj = ObjectId.fromString(String(v));
        obj.appendByteBuffer(b);
    },
    fromObject(v: any): any {
        $required(v, 'object_id_type');
        return ObjectId.fromString(String(v));
    },
    toObject(v: any, debug?: any): any {
        if (debug && debug.use_default && v === undefined) return '0.0.0';
        $required(v, 'object_id_type');
        let obj: any = v;
        if (obj instanceof ObjectId) return obj.toString();
        try {
            obj = ObjectId.fromString(String(v));
        } catch (_: any) {
            if (typeof v === 'number') {
                obj = ObjectId.fromLong(v);
            } else {
                throw new Error(`Invalid object_id: ${v}`);
            }
        }
        return obj.toString();
    },
};

class ObjectId {
    space: number;
    type: number;
    instance: bigint;

    constructor(space: any, type: any, instance: any) {
        this.space = Number(space);
        this.type = Number(type);
        this.instance = BigInt(String(instance));
        if (!isDigits(String(instance))) throw new Error('ObjectId instance must be digits');
    }

    static fromString(value: any): ObjectId {
        if (typeof value !== 'string' || value.split('.').length !== 3) {
            throw new Error(`Invalid ObjectId: ${value}`);
        }
        const [space, type, instance] = value.split('.');
        return new ObjectId(space, type, instance);
    }

    static fromLong(long: any): ObjectId {
        long = BigInt(long);
        const space = Number((long >> 56n) & 0xFFn);
        const type = Number((long >> 48n) & 0xFFn);
        const instance = long & 0xFFFFFFFFFFFFn;
        return new ObjectId(space, type, instance);
    }

    toString(): string {
        return `${this.space}.${this.type}.${this.instance}`;
    }

    toLong(): bigint {
        const space = BigInt(this.space) & 0xFFn;
        const type = BigInt(this.type) & 0xFFn;
        const instance = BigInt(this.instance) & 0xFFFFFFFFFFFFn;
        return (space << 56n) | (type << 48n) | instance;
    }

    appendByteBuffer(b: BufWriter): void {
        const long = this.toLong();
        const buf = Buffer.allocUnsafe(8);
        buf.writeBigUInt64LE(long, 0);
        b.write(buf);
    }

    toBuffer(): Buffer {
        const w = new BufferWriter();
        this.appendByteBuffer(w);
        return w.toBuffer();
    }
}

function optionalType(st_operation: any): SerType {
    return {
        fromByteBuffer(b: BufReader): any {
            if (b.readUint8() !== 1) return undefined;
            return st_operation.fromByteBuffer(b);
        },
        appendByteBuffer(b: BufWriter, v: any): void {
            if (v !== null && v !== undefined) {
                b.writeUint8(1);
                st_operation.appendByteBuffer(b, v);
            } else {
                b.writeUint8(0);
            }
        },
        fromObject(v: any): any {
            if (v === undefined || v === null) return undefined;
            return st_operation.fromObject(v);
        },
        toObject(v: any, debug?: any): any {
            if (!debug || !debug.use_default) {
                if (v === undefined || v === null) return undefined;
            }
            const result = st_operation.toObject(v, debug);
            if (debug && debug.annotate) {
                if (typeof result === 'object') {
                    result.__optional = 'parent is optional';
                } else {
                    return { __optional: result };
                }
            }
            return result;
        },
    };
}

function extensionType(fields_def: any[]): SerType {
    return {
        fromByteBuffer(b: BufReader): any {
            const count = b.readVarint32();
            if (count === 0) return undefined;

            const o: Record<string, any> = {};
            for (let i = 0; i < count; i++) {
                const index = b.readVarint32();
                if (index >= fields_def.length) throw new Error('extension index out of range: ' + index);
                const field = fields_def[index];
                o[field.name] = field.type.fromByteBuffer(b);
            }
            return o;
        },
        appendByteBuffer(b: BufWriter, v: any): void {
            const temp = new BufferWriter();
            let count = 0;

            if (v) {
                fields_def.forEach((f: any, i: number) => {
                    if (v[f.name] !== undefined && v[f.name] !== null) {
                        temp.writeVarint32(i);
                        f.type.appendByteBuffer(temp, v[f.name]);
                        count++;
                    }
                });
            }

            b.writeVarint32(count);
            b.append(temp);
        },
        fromObject(v: any): any {
            if (v === undefined) return undefined;
            const result: Record<string, any> = {};
            fields_def.forEach((f: any) => {
                if (v[f.name] !== undefined && v[f.name] !== null) {
                    result[f.name] = f.type.fromObject(v[f.name]);
                }
            });
            return result;
        },
        toObject(v: any, debug?: any): any {
            if (v === undefined) return undefined;
            const result: Record<string, any> = {};
            fields_def.forEach((f: any) => {
                if (v[f.name] !== undefined && v[f.name] !== null) {
                    result[f.name] = f.type.toObject(v[f.name], debug);
                }
            });
            return result;
        },
    };
}

function staticVariantType(st_operations: any[]): SerType & { st_operations: any[] } {
    return {
        nosort: true,
        st_operations,
        compare(a: any, b: any): number {
            return Number(a) - Number(b);
        },
        fromByteBuffer(b: BufReader): any {
            const type_id = b.readVarint32();
            const st_operation = this.st_operations[type_id];
            if (!st_operation) throw new Error(`Unknown static_variant type: ${type_id}`);
            return [type_id, st_operation.fromByteBuffer(b)];
        },
        appendByteBuffer(b: BufWriter, v: any): void {
            $required(v, 'static_variant');
            const type_id = v[0];
            const st_operation = this.st_operations[type_id];
            if (!st_operation) throw new Error(`Unknown static_variant type: ${type_id}`);
            b.writeVarint32(type_id);
            st_operation.appendByteBuffer(b, v[1]);
        },
        fromObject(v: any): any {
            $required(v, 'static_variant');
            const type_id = v[0];
            const st_operation = this.st_operations[type_id];
            if (!st_operation) throw new Error(`Unknown static_variant type: ${type_id}`);
            return [type_id, st_operation.fromObject(v[1])];
        },
        toObject(v: any, debug?: any): any {
            if (debug && debug.use_default && v === undefined) {
                const sto = this.st_operations[0];
                if (!sto) throw new Error('Unknown static_variant type: 0');
                return [0, sto.toObject(undefined, debug)];
            }
            $required(v, 'static_variant');
            const type_id = v[0];
            const st_operation = this.st_operations[type_id];
            if (!st_operation) throw new Error(`Unknown static_variant type: ${type_id}`);
            return [type_id, st_operation.toObject(v[1], debug)];
        },
    };
}

const public_key_type: SerType & { _toPublic(): void } = {
    _toPublic(): void {
        throw new Error('public_key type requires ecc module - import from index');
    },
    fromByteBuffer(b: BufReader): any {
        return b.read(33);
    },
    appendByteBuffer(b: BufWriter, v: any): void {
        $required(v, 'public_key');
        const buf = Buffer.isBuffer(v) ? v : Buffer.from(v, 'hex');
        b.write(buf);
    },
    fromObject(v: any): any {
        $required(v, 'public_key');
        if (Buffer.isBuffer(v)) return v;
        return Buffer.from(v, 'hex');
    },
    toObject(v: any, debug?: any): any {
        if (debug && debug.use_default && v === undefined) return '';
        $required(v, 'public_key');
        if (Buffer.isBuffer(v)) return v.toString('hex');
        return String(v);
    },
};

export { uint8, uint16, uint32, varint32, int64, uint64, string_type as string, bytesType as bytes, bool_type as bool, arrayType as array, time_point_sec, setType as set, protocolIdType as protocol_id_type, object_id_type, optionalType as optional, extensionType as extension, staticVariantType as static_variant, public_key_type as public_key, void_type, void_type as future_extensions }

