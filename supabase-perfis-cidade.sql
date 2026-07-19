-- Execute uma única vez no SQL Editor do Supabase.
-- A cidade fica no perfil do destinatário para a push usar o clima correto.
alter table public.perfis
add column if not exists city text;
