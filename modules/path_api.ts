'use strict';

import { isBrowser } from './env';

export interface PathApi {
  join(...paths: string[]): string;
  resolve(...paths: string[]): string;
  dirname(p: string): string;
  basename(p: string, ext?: string): string;
  extname(p: string): string;
  relative(from: string, to: string): string;
  parse(p: string): { root: string; dir: string; base: string; ext: string; name: string };
  format(pf: { root?: string; dir?: string; base?: string; ext?: string; name?: string }): string;
  normalize(p: string): string;
  isAbsolute(p: string): boolean;
  readonly sep: string;
  readonly delimiter: string;
}

class NodePathApi implements PathApi {
  private _p: any;
  constructor() { this._p = require('path'); }
  join(...paths: string[]): string { return this._p.join(...paths); }
  resolve(...paths: string[]): string { return this._p.resolve(...paths); }
  dirname(p: string): string { return this._p.dirname(p); }
  basename(p: string, ext?: string): string { return this._p.basename(p, ext); }
  extname(p: string): string { return this._p.extname(p); }
  relative(from: string, to: string): string { return this._p.relative(from, to); }
  parse(p: string) { return this._p.parse(p); }
  format(pf: any) { return this._p.format(pf); }
  normalize(p: string): string { return this._p.normalize(p); }
  isAbsolute(p: string): boolean { return this._p.isAbsolute(p); }
  get sep(): string { return this._p.sep; }
  get delimiter(): string { return this._p.delimiter; }
}

class BrowserPathApi implements PathApi {
  readonly sep = '/';
  readonly delimiter = ':';

  join(...paths: string[]): string {
    const parts = paths.flatMap(p => p.split(this.sep)).filter(Boolean);
    if (parts.length === 0) return '.';
    return parts.join(this.sep);
  }

  resolve(...paths: string[]): string {
    if (paths.length === 0) return '';
    let resolved = '';
    for (let i = paths.length - 1; i >= 0; i--) {
      const p = paths[i];
      if (!p) continue;
      if (p.startsWith(this.sep)) { resolved = p; break; }
      resolved = resolved ? `${p}/${resolved}` : p;
    }
    return this._normalizeSlashes(resolved || '.');
  }

  dirname(p: string): string {
    const normalized = this._normalizeSlashes(p).replace(/\/$/, '');
    if (normalized === '') return '.';
    const idx = normalized.lastIndexOf('/');
    if (idx === -1) return '.';
    if (idx === 0) return '/';
    return normalized.slice(0, idx);
  }

  basename(p: string, ext?: string): string {
    const normalized = this._normalizeSlashes(p).replace(/\/$/, '');
    const idx = normalized.lastIndexOf('/');
    let base = idx === -1 ? normalized : normalized.slice(idx + 1);
    if (ext && base.endsWith(ext)) {
      base = base.slice(0, -ext.length);
    }
    return base || '/';
  }

  extname(p: string): string {
    const base = this.basename(p);
    const idx = base.lastIndexOf('.');
    if (idx <= 0) return '';
    return base.slice(idx);
  }

  relative(from: string, to: string): string {
    const fromParts = this._normalizeSlashes(from).split('/').filter(Boolean);
    const toParts = this._normalizeSlashes(to).split('/').filter(Boolean);
    let i = 0;
    while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
    const up = fromParts.length - i;
    const rel: string[] = [];
    for (let j = 0; j < up; j++) rel.push('..');
    rel.push(...toParts.slice(i));
    return rel.join('/') || '.';
  }

  parse(p: string): { root: string; dir: string; base: string; ext: string; name: string } {
    const normalized = this._normalizeSlashes(p);
    const root = normalized.startsWith('/') ? '/' : '';
    const base = this.basename(normalized);
    const ext = this.extname(base);
    const name = ext ? base.slice(0, -ext.length) : base;
    const dir = root === '/' ? this.dirname(normalized) : (this.dirname(normalized) || '.');
    return { root, dir, base, ext, name };
  }

  format(pf: any): string {
    const base = pf.base || (pf.name || '') + (pf.ext || '');
    if (pf.dir) return this.join(pf.dir, base);
    if (pf.root) return this.join(pf.root, base);
    return base;
  }

  normalize(p: string): string {
    const parts = p.split('/');
    const result: string[] = [];
    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') { if (result.length > 0 && result[result.length - 1] !== '..') result.pop(); else result.push('..'); }
      else result.push(part);
    }
    const joined = result.join('/');
    if (p.startsWith('/')) return '/' + joined;
    return joined || '.';
  }

  isAbsolute(p: string): boolean {
    return p.startsWith('/');
  }

  private _normalizeSlashes(p: string): string {
    return p.replace(/\\/g, '/');
  }
}

let _instance: PathApi | null = null;

export function setPathApi(impl: PathApi | null): void {
  _instance = impl;
}

export function resetPathApi(): void {
  _instance = null;
}

export function getPathApi(): PathApi {
  if (!_instance) {
    _instance = isBrowser() ? new BrowserPathApi() : new NodePathApi();
  }
  return _instance;
}

const path = getPathApi();
export { path };
