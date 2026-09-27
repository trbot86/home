import { createHash } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export async function syncDirectory(path: string, allowUnsupported: boolean): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!(
      allowUnsupported &&
      process.platform === 'win32' &&
      (code === 'EPERM' || code === 'EISDIR' || code === 'EACCES')
    ))
      throw error;
  }
}
export class FileMediaStore {
  constructor(
    readonly root: string,
    private readonly allowUnsupportedDirectorySync = false,
  ) {}
  async initialise(): Promise<void> {
    for (const directory of [this.root, join(this.root, 'objects'), join(this.root, 'staging')]) {
      await mkdir(directory, { recursive: true });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe media directory');
    }
    await syncDirectory(this.root, this.allowUnsupportedDirectorySync);
    await syncDirectory(dirname(this.root), this.allowUnsupportedDirectorySync);
  }
  path(key: string): string {
    if (!/^objects\/[a-f0-9-]{36}\.bin$/.test(key)) throw new Error('Invalid media storage key');
    return join(this.root, key);
  }
  async read(key: string): Promise<Buffer> {
    const path = this.path(key);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe media object');
    return readFile(path);
  }
  async publish(key: string, bytes: Buffer): Promise<void> {
    const destination = this.path(key);
    const staging = join(this.root, 'staging', `${key.slice(8)}.partial`);
    try {
      const existing = await this.read(key);
      if (!existing.equals(bytes)) throw new Error('Immutable object collision');
      await syncDirectory(dirname(destination), this.allowUnsupportedDirectorySync);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // A prior failed upload may leave staging work. It never constitutes a ready object.
    try {
      await unlink(staging);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const file = await open(staging, 'wx');
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await link(staging, destination); // Atomic no-overwrite publication on the same filesystem.
    await syncDirectory(dirname(destination), this.allowUnsupportedDirectorySync);
    await unlink(staging);
    await syncDirectory(dirname(staging), this.allowUnsupportedDirectorySync);
  }
  async remove(key: string): Promise<void> {
    const path = this.path(key);
    await this.removeFile(path);
    await this.removeFile(join(this.root, 'staging', `${key.slice(8)}.partial`));
  }
  private async removeFile(path: string): Promise<void> {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe media deletion');
      await unlink(path);
      await syncDirectory(dirname(path), this.allowUnsupportedDirectorySync);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
