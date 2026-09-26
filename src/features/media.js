import { MAX_PHOTO_BYTES, MAX_THUMBNAIL_BYTES } from '../config.js';
import { analyzeImageWithWorkersAI } from '../services/ai.js';
import { getTelegramFileBytes } from '../services/telegram.js';
import { assertMediaSize, getBestPhotoSize } from '../utils/media.js';

export async function analyzePhotoMessage(message, prompt, env) {
  const photo = getBestPhotoSize(message.photo || []);
  if (!photo || !photo.file_id) {
    throw new Error('No photo file_id');
  }

  assertMediaSize(photo, MAX_PHOTO_BYTES);
  const { buffer } = await getTelegramFileBytes(photo.file_id, env, MAX_PHOTO_BYTES);
  return await analyzeImageWithWorkersAI(buffer, 'image/jpeg', prompt, env);
}

export async function analyzeVideoOrAnimationThumbnail(media, prompt, env, mediaType) {
  const thumbnail = media && (media.thumbnail || media.thumb);
  if (!thumbnail || !thumbnail.file_id) {
    const error = new Error('No Telegram thumbnail available');
    error.code = 'NO_THUMBNAIL';
    throw error;
  }

  assertMediaSize(thumbnail, MAX_THUMBNAIL_BYTES);
  const { buffer } = await getTelegramFileBytes(thumbnail.file_id, env, MAX_THUMBNAIL_BYTES);
  const typeLabel = mediaType === 'video' ? 'video' : 'GIF/animation';
  const thumbnailPrompt =
    `This is only a thumbnail/frame from a Telegram ${typeLabel}, not the full media. ` +
    `Answer based only on what is visible in this image. User request: ${prompt}`;

  return await analyzeImageWithWorkersAI(buffer, 'image/jpeg', thumbnailPrompt, env);
}
