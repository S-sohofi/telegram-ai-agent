

export function extractTextFromAIResponse(aiResponse) {
  if (!aiResponse) return null;

  if (typeof aiResponse === 'string') {
    return aiResponse;
  }

  if (aiResponse.response != null) {
    const responseText = extractTextFromContentValue(aiResponse.response);
    if (responseText) return responseText;
  }

  if (aiResponse.text != null) {
    const directText = extractTextFromContentValue(aiResponse.text);
    if (directText) return directText;
  }

  if (aiResponse.content != null) {
    const contentText = extractTextFromContentValue(aiResponse.content);
    if (contentText) return contentText;
  }

  if (aiResponse.choices && Array.isArray(aiResponse.choices) && aiResponse.choices.length > 0) {
    const choice = aiResponse.choices[0];
    if (choice.message) {
      const messageContent = extractTextFromContentValue(choice.message.content);
      if (messageContent) return messageContent;
      const messageText = extractTextFromContentValue(choice.message.text);
      if (messageText) return messageText;
    }
    const choiceText = extractTextFromContentValue(choice.text);
    if (choiceText) return choiceText;
  }

  if (aiResponse.output && Array.isArray(aiResponse.output)) {
    const assistantMsg = aiResponse.output.find((item) => item.role === 'assistant');
    if (assistantMsg) {
      if (Array.isArray(assistantMsg.content)) {
        const textItem = assistantMsg.content.find((c) => c.type === 'output_text' && c.text);
        if (textItem) return textItem.text;
        const textItem2 = assistantMsg.content.find((c) => c.type === 'text' && c.text);
        if (textItem2) return textItem2.text;
        const anyText = assistantMsg.content.find((c) => c.text);
        if (anyText) return anyText.text;
      } else if (typeof assistantMsg.content === 'string') {
        return assistantMsg.content;
      }
    }
  }

  if (Array.isArray(aiResponse)) {
    const assistantMsg = aiResponse.find((item) => item.role === 'assistant');
    if (assistantMsg) {
      if (Array.isArray(assistantMsg.content)) {
        const textItem = assistantMsg.content.find((c) => c.type === 'output_text' && c.text);
        if (textItem) return textItem.text;
        const textItem2 = assistantMsg.content.find((c) => c.text);
        if (textItem2) return textItem2.text;
      } else if (typeof assistantMsg.content === 'string') {
        return assistantMsg.content;
      } else if (assistantMsg.text) {
        return assistantMsg.text;
      }
    }
  }

  if (aiResponse.result) {
    if (typeof aiResponse.result === 'string') return aiResponse.result;
    const nested = extractTextFromAIResponse(aiResponse.result);
    if (nested) return nested;
  }

  const keys = Object.keys(aiResponse);
  if (keys.length === 1 && typeof aiResponse[keys[0]] === 'string') {
    return aiResponse[keys[0]];
  }

  return null;
}

function extractTextFromContentValue(content, depth = 0) {
  if (content == null || depth > 4) return null;
  if (typeof content === 'string') return content.trim() || null;

  if (Array.isArray(content)) {
    const parts = content
      .map((item) => extractTextFromContentValue(item, depth + 1))
      .filter(Boolean);
    const text = parts.join('\n').trim();
    return text || null;
  }

  if (typeof content !== 'object') return null;
  for (const key of ['text', 'output_text', 'content', 'value', 'response']) {
    if (content[key] == null) continue;
    const text = extractTextFromContentValue(content[key], depth + 1);
    if (text) return text;
  }

  return null;
}

export function getAIFinishReason(response) {
  const choice = response && Array.isArray(response.choices) ? response.choices[0] : null;
  const reason = choice && (choice.finish_reason || choice.finishReason || choice.stop_reason);
  return reason ? String(reason).toLowerCase() : '';
}

export function summarizeAIResponseShape(response) {
  if (response == null) return JSON.stringify({ type: String(response) });
  if (typeof response === 'string') {
    return JSON.stringify({ type: 'string', length: response.length });
  }
  if (Array.isArray(response)) {
    return JSON.stringify({ type: 'array', length: response.length });
  }

  const summary = {
    type: typeof response,
    keys: Object.keys(response).slice(0, 20)
  };
  if (typeof response.response === 'string') {
    summary.responseLength = response.response.length;
  }
  if (Array.isArray(response.choices)) {
    summary.choices = response.choices.slice(0, 3).map((choice) => ({
      keys: choice && typeof choice === 'object' ? Object.keys(choice).slice(0, 20) : [],
      messageKeys: choice && choice.message && typeof choice.message === 'object'
        ? Object.keys(choice.message).slice(0, 20)
        : [],
      contentType: choice && choice.message
        ? choice.message.content === null
          ? 'null'
          : Array.isArray(choice.message.content)
            ? 'array'
            : typeof choice.message.content
        : 'missing',
      contentKeys: choice && choice.message && choice.message.content && typeof choice.message.content === 'object'
        ? Object.keys(choice.message.content).slice(0, 20)
        : [],
      contentLength: choice && choice.message && typeof choice.message.content === 'string'
        ? choice.message.content.length
        : null,
      reasoningLength: choice && choice.message && typeof choice.message.reasoning_content === 'string'
        ? choice.message.reasoning_content.length
        : null,
      finishReason: choice && (choice.finish_reason || choice.finishReason) || null
    }));
  }
  return JSON.stringify(summary);
}

export function extractFinalAnswer(text) {
  if (!text) return '';

  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/\*\*My Thought Process[\s\S]*?\*\*[\s\S]*?(?=\n\n[^*\n]|$)/gi, '')
    .replace(/(?:Okay|Ok|Alright),?\s*here'?s?\s+how\s+I'?m\s+(?:approaching|thinking)[\s\S]*?(?=\n\n[^A-Z]|$)/gi, '')
    .replace(/(?:First|Next|Now|Finally|So),?\s+I\s+(?:need to|have to|will|started|know|want)[\s\S]*?(?=\n\n|$)/g, '')
    .replace(/Draft\s*\d+[\s\S]*?(?=Draft\s*\d+|\n\n[^D]|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
