// Supabase Edge Function: link-preview
// Deploy: supabase functions deploy link-preview

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const clean = (value: string | null | undefined, max = 300) =>
  (value || '').replace(/\s+/g, ' ').trim().slice(0, max);

const decodeHtml = (value: string) => value
  .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');

const attr = (html: string, property: string) => {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return '';
};

const safeUrl = (value: string) => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const blocked = host === 'localhost' || host.endsWith('.local') ||
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) || /^0\./.test(host) || host === '::1';
    return ['http:', 'https:'].includes(url.protocol) && !blocked ? url : null;
  } catch {
    return null;
  }
};

const isTikTokUrl = (url: URL) => /(^|\.)tiktok\.com$/i.test(url.hostname);
const isYouTubeUrl = (url: URL) => /(^|\.)(youtube\.com|youtu\.be)$/i.test(url.hostname);

const getTikTokPreview = async (url: URL) => {
  try {
    const response = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url.toString())}`, {
      headers: { 'User-Agent': 'LiveWeather Link Preview/1.0' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const imageUrl = typeof data.thumbnail_url === 'string' ? safeUrl(data.thumbnail_url)?.toString() || null : null;
    const author = clean(data.author_name, 100);
    const title = clean(data.title, 300);
    if (!imageUrl && !title) return null;
    return {
      url: url.toString(),
      title: title || (author ? `TikTok · ${author}` : 'TikTok'),
      description: author ? `Vídeo de ${author}` : null,
      image_url: imageUrl,
      site_name: 'TikTok',
    };
  } catch {
    return null;
  }
};

const getYouTubePreview = async (url: URL) => {
  try {
    // Funciona também para /shorts/ e evita depender do HTML dinâmico do YouTube.
    const shortId = url.pathname.match(/^\/shorts\/([^/?]+)/i)?.[1];
    const oembedTarget = shortId ? `https://www.youtube.com/watch?v=${shortId}` : url.toString();
    const response = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(oembedTarget)}`);
    if (!response.ok) return null;
    const data = await response.json();
    const imageUrl = typeof data.thumbnail_url === 'string' ? safeUrl(data.thumbnail_url)?.toString() || null : null;
    const title = clean(data.title, 300);
    const author = clean(data.author_name, 100);
    if (!imageUrl && !title) return null;
    return {
      url: url.toString(), title: title || 'YouTube',
      description: author ? `Canal: ${author}` : null,
      image_url: imageUrl, site_name: 'YouTube',
    };
  } catch {
    return null;
  }
};

const getProviderPreview = async (url: URL) => {
  if (isYouTubeUrl(url)) return getYouTubePreview(url);
  if (isTikTokUrl(url)) return getTikTokPreview(url);
  return null;
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return Response.json({ error: 'Método não permitido.' }, { status: 405, headers: corsHeaders });

  try {
    const { url: rawUrl } = await request.json();
    const url = typeof rawUrl === 'string' ? safeUrl(rawUrl) : null;
    if (!url) return Response.json({ preview: null }, { headers: corsHeaders });

    // Primeiro tenta os provedores oficiais: YouTube Shorts e TikTok são páginas dinâmicas.
    const directProviderPreview = await getProviderPreview(url);
    if (directProviderPreview) return Response.json({ preview: directProviderPreview }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'LiveWeather Link Preview/1.0' },
    });
    clearTimeout(timeout);
    const resolvedUrl = safeUrl(response.url);
    if (!resolvedUrl) return Response.json({ preview: null }, { headers: corsHeaders });

    // TikTok muitas vezes devolve uma página genérica; o oEmbed entrega a miniatura do vídeo.
    const resolvedProviderPreview = await getProviderPreview(resolvedUrl);
    if (resolvedProviderPreview) return Response.json({ preview: resolvedProviderPreview }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
      return Response.json({ preview: null }, { headers: corsHeaders });
    }

    const html = (await response.text()).slice(0, 500_000);
    const title = clean(attr(html, 'og:title') || attr(html, 'twitter:title') || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
    const description = clean(attr(html, 'og:description') || attr(html, 'description') || attr(html, 'twitter:description'), 500);
    const image = attr(html, 'og:image') || attr(html, 'twitter:image');
    const imageUrl = image ? safeUrl(new URL(image, resolvedUrl).toString())?.toString() || null : null;
    const siteName = clean(attr(html, 'og:site_name') || resolvedUrl.hostname, 100);

    return Response.json({ preview: title || description || imageUrl ? {
      url: resolvedUrl.toString(), title: title || null, description: description || null,
      image_url: imageUrl, site_name: siteName || null,
    } : null }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.warn('Link preview failed:', error?.message || error);
    return Response.json({ preview: null }, { headers: corsHeaders });
  }
});
