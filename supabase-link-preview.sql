-- Execute uma única vez no SQL Editor do Supabase.
-- Apenas adiciona campos opcionais: mensagens existentes e o chat atual continuam funcionando.
alter table public.mensagens add column if not exists link_url text;
alter table public.mensagens add column if not exists preview_title text;
alter table public.mensagens add column if not exists preview_description text;
alter table public.mensagens add column if not exists preview_image_url text;
alter table public.mensagens add column if not exists preview_site_name text;

-- Opcional, mas útil para consultas futuras por link.
create index if not exists mensagens_link_url_idx on public.mensagens (link_url) where link_url is not null;
