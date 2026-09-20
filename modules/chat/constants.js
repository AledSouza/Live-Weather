export const SUPABASE_URL = 'https://byqldmxkbtltrhwwihjx.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_pDknu1ErFeiEZemV2_Z8ng_MH0HQY3k';
export const AI_SENDER_CODE = 'gemini';
export const GROUP_PREFIX = 'group:';
export const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-flash'];
export const DEFAULT_AI_NAME = 'Gemini';
export const DEFAULT_APP_THEME_COLOR = '#00ff66';
export const AI_DEFAULT_TIMEOUT_SECONDS = 35;
export const AI_DEFAULT_MAX_RETRIES = 2;
export const MESSAGE_PAGE_SIZE = 60;
export const SEARCH_PAGE_SIZE = 500;
export const MESSAGE_POLL_INTERVAL_MS = 15000;
export const GROUP_INFO_POLL_INTERVAL_MS = 30000;
export const MESSAGE_SEARCH_DEBOUNCE_MS = 600;
export const MIN_MESSAGE_SEARCH_LENGTH = 2;

export const isGroupToken = (token) => String(token || '').startsWith(GROUP_PREFIX);
