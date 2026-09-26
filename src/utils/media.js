

export function getBestPhotoSize(photoArray) {
  if (!Array.isArray(photoArray) || !photoArray.length) {
    return null;
  }

  return photoArray.reduce((best, photo) => {
    const bestScore = (best.file_size || 0) || ((best.width || 0) * (best.height || 0));
    const photoScore = (photo.file_size || 0) || ((photo.width || 0) * (photo.height || 0));
    return photoScore > bestScore ? photo : best;
  }, photoArray[0]);
}

export function assertMediaSize(media, maxBytes) {
  if (media && media.file_size && media.file_size > maxBytes) {
    throw fileTooLargeError(media.file_size, maxBytes);
  }
}

export function fileTooLargeError(size, maxBytes) {
  const error = new Error(`File too large: ${size} > ${maxBytes}`);
  error.code = 'FILE_TOO_LARGE';
  return error;
}

export function isFileTooLargeError(error) {
  return error && error.code === 'FILE_TOO_LARGE';
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}
