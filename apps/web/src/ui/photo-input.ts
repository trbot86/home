/** Validate a whole selection before adding any bytes to the durable draft. */
export function validatePhotoFiles(files: readonly File[], existingCount: number): void {
  if (files.length + existingCount > 20)
    throw new Error('A record can have up to 20 photos. Remove one first.');
  for (const file of files) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
      throw new Error('Choose PNG, JPEG or WebP image files. The selection was not added.');
    if (!file.size || file.size > 25 * 1024 * 1024)
      throw new Error(
        'Each photo must contain image data and be no larger than 25 MB. The selection was not added.',
      );
  }
}

export function hasFileTransfer(data: DataTransfer): boolean {
  // Files may be hidden during dragover; the type marker remains available.
  return data.files.length > 0 || Array.from(data.types).includes('Files');
}
