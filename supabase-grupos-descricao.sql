-- Execute este script no SQL Editor do Supabase uma única vez.
-- Mantém grupos já existentes com a descrição vazia.
alter table public.grupos
add column if not exists description text not null default '';

-- Limite alinhado ao aplicativo.
alter table public.grupos
drop constraint if exists grupos_description_length;

alter table public.grupos
add constraint grupos_description_length check (char_length(description) <= 500);

-- A tabela grupos já é acompanhada pelo app em tempo real. Caso ela ainda não
-- esteja na publicação do Realtime, descomente a linha abaixo e execute-a uma vez.
-- alter publication supabase_realtime add table public.grupos;
