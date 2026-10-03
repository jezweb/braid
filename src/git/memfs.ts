// A minimal in-memory filesystem for isomorphic-git inside a Worker.
// Errors carry Node-style `code`s because isomorphic-git branches on them.

type Entry =
  | { kind: "dir"; children: Set<string>; mtimeMs: number }
  | { kind: "file"; data: Uint8Array; mtimeMs: number };

function fsError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

class Stats {
  constructor(private e: Entry) {}
  get size() { return this.e.kind === "file" ? this.e.data.byteLength : 0; }
  get mtimeMs() { return this.e.mtimeMs; }
  get ctimeMs() { return this.e.mtimeMs; }
  get mode() { return this.e.kind === "file" ? 0o100644 : 0o040000; }
  get type() { return this.e.kind === "file" ? "file" : "dir"; }
  get ino() { return 0; }
  get uid() { return 0; }
  get gid() { return 0; }
  get dev() { return 0; }
  isFile() { return this.e.kind === "file"; }
  isDirectory() { return this.e.kind === "dir"; }
  isSymbolicLink() { return false; }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export class MemFS {
  private entries = new Map<string, Entry>([["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }]]);

  readonly promises = {
    readFile: this.readFile.bind(this),
    writeFile: this.writeFile.bind(this),
    unlink: this.unlink.bind(this),
    readdir: this.readdir.bind(this),
    mkdir: this.mkdir.bind(this),
    rmdir: this.rmdir.bind(this),
    stat: this.stat.bind(this),
    lstat: this.stat.bind(this),
    readlink: this.readlink.bind(this),
    symlink: this.symlink.bind(this),
  };

  /** Bytes held, for the memory budget check. */
  bytes(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.kind === "file") n += e.data.byteLength;
    return n;
  }

  private norm(p: string): string {
    const out: string[] = [];
    for (const part of p.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return "/" + out.join("/");
  }
  private parent(p: string): string {
    const parts = this.norm(p).split("/").filter(Boolean);
    parts.pop();
    return "/" + parts.join("/");
  }
  private base(p: string): string {
    return this.norm(p).split("/").filter(Boolean).pop() ?? "";
  }
  private get(p: string): Entry {
    const e = this.entries.get(this.norm(p));
    if (!e) throw fsError("ENOENT", p);
    return e;
  }
  private dir(p: string) {
    const e = this.get(p);
    if (e.kind !== "dir") throw fsError("ENOTDIR", p);
    return e;
  }

  async mkdir(p: string, opts?: { recursive?: boolean } | number): Promise<void> {
    const t = this.norm(p);
    if (this.entries.has(t)) {
      if (typeof opts === "object" && opts?.recursive) return;
      throw fsError("EEXIST", p);
    }
    const par = this.parent(t);
    if (!this.entries.has(par)) {
      if (typeof opts === "object" && opts?.recursive) await this.mkdir(par, { recursive: true });
      else throw fsError("ENOENT", par);
    }
    this.entries.set(t, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
    this.dir(par).children.add(this.base(t));
  }

  async writeFile(p: string, data: string | Uint8Array | ArrayBuffer): Promise<void> {
    const t = this.norm(p);
    const par = this.parent(t);
    if (!this.entries.has(par)) await this.mkdir(par, { recursive: true });
    if (this.entries.get(t)?.kind === "dir") throw fsError("EISDIR", p);
    const bytes = typeof data === "string" ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    this.entries.set(t, { kind: "file", data: bytes, mtimeMs: Date.now() });
    this.dir(par).children.add(this.base(t));
  }

  async readFile(p: string, opts?: string | { encoding?: string }): Promise<Uint8Array | string> {
    const e = this.get(p);
    if (e.kind !== "file") throw fsError("EISDIR", p);
    const encoding = typeof opts === "string" ? opts : opts?.encoding;
    return encoding ? dec.decode(e.data) : e.data;
  }

  async readdir(p: string): Promise<string[]> {
    return [...this.dir(p).children].sort();
  }

  async unlink(p: string): Promise<void> {
    const t = this.norm(p);
    if (this.get(t).kind !== "file") throw fsError("EISDIR", p);
    this.entries.delete(t);
    this.dir(this.parent(t)).children.delete(this.base(t));
  }

  async rmdir(p: string): Promise<void> {
    const t = this.norm(p);
    if (this.dir(t).children.size) throw fsError("ENOTEMPTY", p);
    this.entries.delete(t);
    this.dir(this.parent(t)).children.delete(this.base(t));
  }

  async readlink(p: string): Promise<string> {
    throw fsError("EINVAL", p);
  }

  async symlink(_target: string, p: string): Promise<void> {
    throw fsError("EPERM", p);
  }

  async stat(p: string): Promise<Stats> {
    return new Stats(this.get(p));
  }
}
