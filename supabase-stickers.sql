-- Execute no SQL Editor do Supabase antes de usar a sincronizacao de figurinhas.
alter table public.perfis
  add column if not exists favorite_gifs jsonb not null default '[]'::jsonb;

alter table public.perfis
  drop constraint if exists perfis_favorite_gifs_array;

alter table public.perfis
  add constraint perfis_favorite_gifs_array
  check (jsonb_typeof(favorite_gifs) = 'array');
