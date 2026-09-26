import {
  ERROR_ANIMATION_PROCESS,
  ERROR_ANIMATION_THUMBNAIL_UNAVAILABLE,
  ERROR_API_UNAVAILABLE,
  ERROR_FILE_TOO_LARGE,
  ERROR_IMAGE_PROCESS,
  ERROR_VIDEO_PROCESS,
  ERROR_VIDEO_THUMBNAIL_UNAVAILABLE,
  ERROR_VOICE_PROCESS,
  MAX_AUDIO_BYTES
} from '../config.js';
import { handleFactCheckCommand } from '../features/fact-check.js';
import {
  analyzePhotoMessage,
  analyzeVideoOrAnimationThumbnail
} from '../features/media.js';
import {
  analyzeImageWithWorkersAI,
  generateTextResult,
  transcribeAudioWithWorkersAI
} from '../services/ai.js';
import {
  getChatContext,
  storeIncomingTextMessage,
  storeMessage
} from '../services/chat-history.js';
import {
  getTelegramFileBytes,
  replyToMessage,
  replyToMessageWithSources,
  withTelegramIdentity,
  withTyping
} from '../services/telegram.js';
import { formatError } from '../utils/common.js';
import { assertMediaSize, isFileTooLargeError } from '../utils/media.js';
import {
  getChatId,
  getUserDisplayName,
  isCommand,
  isPrivateChat,
  normalizedBotUsername,
  shouldBotRespond,
  stripBotMention
} from '../utils/telegram-message.js';

export async function handleTelegramUpdate(update, env, ctx) {
  const message = update.message || update.edited_message;
  if (!message) return;
  env = await withTelegramIdentity(env);

  if (message.text) {
    if (isCommand(message.text, 'start', env)) {
      await handleStart(message, env);
      return;
    }

    if (isCommand(message.text, 'help', env)) {
      await handleHelp(message, env);
      return;
    }

    if (isCommand(message.text, 'check', env)) {
      await handleFactCheckCommand(message, env);
      return;
    }

    await handleTextMessage(message, env, ctx);
    return;
  }

  if (message.voice) {
    await handleDirectVoice(message, env, ctx);
    return;
  }

  if (message.photo) {
    await handlePhotoMessage(message, env, ctx);
    return;
  }

  if (message.video) {
    await handleVideoMessage(message, env, ctx);
    return;
  }

  if (message.animation) {
    await handleAnimationMessage(message, env, ctx);
  }
}

async function handleStart(message, env) {
  const text =
    'سلام! من یک دستیار هوش مصنوعی هستم. 👋\n\n' +
    'می‌تونی توی چت خصوصی پیام بدی، یا توی گروه منشنم کنی / به پیام‌هام ریپلای بزنی.\n\n' +
    'قابلیت‌ها:\n' +
    '• چت متنی با هوش مصنوعی Cloudflare\n' +
    '• حفظ کانتکست مکالمه\n' +
    '• بررسی ادعا با منابع زنده وب از طریق دستور /check\n' +
    '• تبدیل ویس به متن با Cloudflare Whisper\n' +
    '• تحلیل عکس با مدل Vision\n' +
    '• تحلیل تصویر بندانگشتی ویدیو/GIF وقتی موجود باشد';

  await replyToMessage(message, text, env);
}

async function handleHelp(message, env) {
  const text =
    '🤖 راهنما\n\n' +
    '• در چت خصوصی هر پیامی بفرستی جواب می‌دم.\n' +
    '• در گروه باید منشنم کنی یا به پیام من ریپلای بزنی.\n' +
    '• روی متن‌ها، عکس‌ها، ویس‌ها و مدیاها می‌تونی ریپلای بزنی.\n' +
    '• برای بررسی یک ادعا بنویس: /check متن ادعا؛ یا روی پیام حاوی ادعا ریپلای کن و /check بفرست.\n' +
    '• ویدیو و GIF فعلاً با تصویر بندانگشتی تحلیل می‌شوند، نه کل محتوای ویدیو.\n\n' +
    'Powered by Cloudflare Workers AI';

  await replyToMessage(message, text, env);
}

async function handleTextMessage(message, env, ctx) {
  const chatId = getChatId(message);
  const username = getUserDisplayName(message);
  const originalText = message.text || '';
  const shouldRespond = shouldBotRespond(message, env);

  if (!shouldRespond) {
    await storeIncomingTextMessage(message, env, false);
    return;
  }

  let userMessage = isPrivateChat(message)
    ? originalText
    : stripBotMention(originalText, normalizedBotUsername(env));
  userMessage = userMessage.trim();

  const replyMsg = message.reply_to_message;

  if (replyMsg && replyMsg.voice) {
    await storeIncomingTextMessage(message, env, true);
    await handleVoiceTranscription(message, replyMsg, env);
    return;
  }

  if (replyMsg && replyMsg.photo) {
    await storeIncomingTextMessage(message, env, true);
    await handleReplyToMedia(message, replyMsg, 'photo', userMessage, env);
    return;
  }

  if (replyMsg && replyMsg.video) {
    await storeIncomingTextMessage(message, env, true);
    await handleReplyToMedia(message, replyMsg, 'video', userMessage, env);
    return;
  }

  if (replyMsg && replyMsg.animation) {
    await storeIncomingTextMessage(message, env, true);
    await handleReplyToMedia(message, replyMsg, 'animation', userMessage, env);
    return;
  }

  if (replyMsg && replyMsg.text) {
    userMessage = `The user is replying to:\n"""\n${replyMsg.text}\n"""\n\nUser's message: ${userMessage}`;
  }

  if (!userMessage.trim()) {
    await storeIncomingTextMessage(message, env, true);
    return;
  }

  await withTyping(chatId, env, async () => {
    try {
      // Read context before storing this update so the current message appears only once in the prompt.
      const chatContext = await getChatContext(chatId, env, userMessage);
      await storeIncomingTextMessage(message, env, true);
      const fullPrompt = chatContext
        ? `${chatContext}\n\nCurrent message from ${username}: ${userMessage}`
        : userMessage;

      const response = await generateTextResult(fullPrompt, env);
      await storeMessage(chatId, normalizedBotUsername(env) || 'Assistant', response.text, env, true);
      await replyToMessageWithSources(message, response.text, response.sources, env);
    } catch (error) {
      console.error('Text handling error:', formatError(error));
      await replyToMessage(message, ERROR_API_UNAVAILABLE, env);
    }
  });
}

async function handleDirectVoice(message, env, ctx) {
  if (!isPrivateChat(message)) {
    return;
  }

  await handleVoiceTranscription(message, message, env);
}

async function handleVoiceTranscription(triggerMessage, sourceMessage, env) {
  const chatId = getChatId(triggerMessage);

  await withTyping(chatId, env, async () => {
    try {
      const voice = sourceMessage.voice;
      if (!voice || !voice.file_id) {
        throw new Error('No voice file_id');
      }

      assertMediaSize(voice, MAX_AUDIO_BYTES);
      const { buffer } = await getTelegramFileBytes(voice.file_id, env, MAX_AUDIO_BYTES);
      const transcription = await transcribeAudioWithWorkersAI(buffer, env);

      await replyToMessage(triggerMessage, `Transcription:\n\n${transcription}`, env);
    } catch (error) {
      console.error('Voice transcription error:', formatError(error));
      await replyToMessage(triggerMessage, isFileTooLargeError(error) ? ERROR_FILE_TOO_LARGE : ERROR_VOICE_PROCESS, env);
    }
  });
}

async function handlePhotoMessage(message, env, ctx) {
  const caption = message.caption || '';
  if (!shouldBotRespond(message, env, caption)) {
    return;
  }

  const prompt = stripBotMention(caption, normalizedBotUsername(env)).trim() || 'Please describe this in detail.';

  await withTyping(getChatId(message), env, async () => {
    try {
      const response = await analyzePhotoMessage(message, prompt, env);
      await replyToMessage(message, response, env);
    } catch (error) {
      console.error('Image handling error:', formatError(error));
      await replyToMessage(message, isFileTooLargeError(error) ? ERROR_FILE_TOO_LARGE : ERROR_IMAGE_PROCESS, env);
    }
  });
}

async function handleVideoMessage(message, env, ctx) {
  const caption = message.caption || '';
  if (!shouldBotRespond(message, env, caption)) {
    return;
  }

  const prompt = stripBotMention(caption, normalizedBotUsername(env)).trim() || 'Please describe this video.';

  await withTyping(getChatId(message), env, async () => {
    try {
      const response = await analyzeVideoOrAnimationThumbnail(message.video, prompt, env, 'video');
      await replyToMessage(message, response, env);
    } catch (error) {
      console.error('Video handling error:', formatError(error));
      const fallback = error && error.code === 'NO_THUMBNAIL' ? ERROR_VIDEO_THUMBNAIL_UNAVAILABLE : ERROR_VIDEO_PROCESS;
      await replyToMessage(message, isFileTooLargeError(error) ? ERROR_FILE_TOO_LARGE : fallback, env);
    }
  });
}

async function handleAnimationMessage(message, env, ctx) {
  const caption = message.caption || '';
  if (!shouldBotRespond(message, env, caption)) {
    return;
  }

  const prompt = stripBotMention(caption, normalizedBotUsername(env)).trim() || 'Please describe this GIF/animation.';

  await withTyping(getChatId(message), env, async () => {
    try {
      const response = await analyzeVideoOrAnimationThumbnail(message.animation, prompt, env, 'animation');
      await replyToMessage(message, response, env);
    } catch (error) {
      console.error('Animation handling error:', formatError(error));
      const fallback = error && error.code === 'NO_THUMBNAIL' ? ERROR_ANIMATION_THUMBNAIL_UNAVAILABLE : ERROR_ANIMATION_PROCESS;
      await replyToMessage(message, isFileTooLargeError(error) ? ERROR_FILE_TOO_LARGE : fallback, env);
    }
  });
}

async function handleReplyToMedia(triggerMessage, repliedMessage, mediaType, userPrompt, env) {
  await withTyping(getChatId(triggerMessage), env, async () => {
    try {
      let response;
      if (mediaType === 'photo') {
        response = await analyzePhotoMessage(repliedMessage, userPrompt || 'Please describe this photo in detail.', env);
      } else if (mediaType === 'video') {
        response = await analyzeVideoOrAnimationThumbnail(
          repliedMessage.video,
          userPrompt || 'Please describe this video.',
          env,
          'video'
        );
      } else if (mediaType === 'animation') {
        response = await analyzeVideoOrAnimationThumbnail(
          repliedMessage.animation,
          userPrompt || 'Please describe this GIF/animation.',
          env,
          'animation'
        );
      } else {
        throw new Error(`Unsupported media type: ${mediaType}`);
      }

      await replyToMessage(triggerMessage, response, env);
    } catch (error) {
      console.error('Reply to media error:', formatError(error));

      if (isFileTooLargeError(error)) {
        await replyToMessage(triggerMessage, ERROR_FILE_TOO_LARGE, env);
        return;
      }

      if (error && error.code === 'NO_THUMBNAIL' && mediaType === 'video') {
        await replyToMessage(triggerMessage, ERROR_VIDEO_THUMBNAIL_UNAVAILABLE, env);
        return;
      }

      if (error && error.code === 'NO_THUMBNAIL' && mediaType === 'animation') {
        await replyToMessage(triggerMessage, ERROR_ANIMATION_THUMBNAIL_UNAVAILABLE, env);
        return;
      }

      const errorMessage = mediaType === 'photo'
        ? ERROR_IMAGE_PROCESS
        : mediaType === 'video'
          ? ERROR_VIDEO_PROCESS
          : ERROR_ANIMATION_PROCESS;
      await replyToMessage(triggerMessage, errorMessage, env);
    }
  });
}
