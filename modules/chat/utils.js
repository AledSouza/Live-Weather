const URL_PATTERN = /https?:\/\/[^\s<>()]+/i;

export const getFirstValidHttpUrl = (text) => {
  const match = String(text || '').match(URL_PATTERN);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
};

export const getReplyPreviewText = (message) => {
  if (!message) return 'Mensagem';
  if (message.media_url) {
    const mediaType = String(message.media_type || '').toLowerCase();
    if (mediaType.includes('video')) return 'Vídeo';
    if (mediaType === 'audio') return 'Áudio';
    if (mediaType === 'document') return 'Documento';
    if (mediaType === 'sticker') return 'Figurinha';
    return 'Foto';
  }
  return message.preview_title || message.content || message.link_url || 'Mensagem';
};

export const getLinkDomain = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'Link'; }
};

export const hasReplyThumbnail = (message) => {
  if (!message) return false;
  if (message.link_url) return true;
  const mediaType = String(message.media_type || '').toLowerCase();
  return mediaType.includes('image') || mediaType.includes('video');
};

export const extractStoragePath = (url) => {
  try {
    const marker = '/object/public/chat-media/';
    const idx = url.indexOf(marker);
    if (idx === -1) return null;
    return decodeURIComponent(url.slice(idx + marker.length).split('?')[0]);
  } catch {
    return null;
  }
};

export const getDocumentIcon = (content) => {
  const filename = (content || '|').split('|')[0].toLowerCase();
  const ext = filename.split('.').pop();

  if (['mp3', 'wav', 'm4a', 'ogg', 'aac'].includes(ext)) return 'musical-notes-outline';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive-outline';
  if (ext === 'pdf') return 'book-outline';
  return 'document-text-outline';
};

export const formatAudioMillis = (millis) => {
  if (!millis) return '0:00';
  const totalSeconds = Math.floor(millis / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
};

export const getPinnedMessagePreview = (message) => {
  if (!message) return '';
  if (!message.media_url) return message.content || 'Mensagem';

  const mediaType = String(message.media_type || '').toLowerCase();
  if (mediaType.includes('spoiler')) return 'Midia com spoiler';
  if (mediaType === 'audio') return 'Audio';
  if (mediaType === 'video') return 'Video';
  if (mediaType === 'document') return 'Documento';
  if (mediaType === 'sticker') return 'Sticker';
  return 'Foto';
};

export const generateWaveformBars = (seed, count = 27) => {
  const str = String(seed || 'default');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) & 0xffffffff;
  }
  let currentSeed = Math.abs(hash) || 1;
  const bars = [];
  for (let i = 0; i < count; i++) {
    currentSeed = (currentSeed * 1103515245 + 12345) & 0x7fffffff;
    const normalized = (currentSeed % 100) / 100;
    bars.push(4 + Math.round(normalized * 16));
  }
  return bars;
};
