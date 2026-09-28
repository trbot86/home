export type InstalledVersion = { version: string; sha256: string };
export function differentPublishedBuild(installed: InstalledVersion, published: { sha256: string }): boolean {
  const valid = /^[a-f0-9]{64}$/;
  return (
    valid.test(installed.sha256) && valid.test(published.sha256) && installed.sha256 !== published.sha256
  );
}

export async function checkAppUpdate(
  installed: InstalledVersion,
  published: () => Promise<{ sha256: string }>,
): Promise<'available' | 'current' | 'unavailable'> {
  try {
    const latest = await published();
    if (!/^[a-f0-9]{64}$/.test(latest.sha256) || !/^[a-f0-9]{64}$/.test(installed.sha256))
      return 'unavailable';
    return differentPublishedBuild(installed, latest) ? 'available' : 'current';
  } catch {
    return 'unavailable';
  }
}
