import { resolve } from 'node:path';
export const migrationsRoot = resolve(import.meta.dirname, '../migrations');
export const webRoot = resolve(import.meta.dirname, '../../web/dist');
