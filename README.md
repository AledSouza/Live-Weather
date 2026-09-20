# Live Weather

Aplicativo mobile de previsao do tempo e comunicacao em tempo real, construido com Expo e React Native. O backend usa Supabase para autenticacao, persistencia, Storage, Realtime e Edge Functions.

## Funcionalidades

- Clima atual, previsao estendida e busca de municipios brasileiros.
- Cache local da ultima consulta.
- Perfis associados a cidades.
- Conversas individuais e em grupo com texto, imagens, videos, audio, documentos e figurinhas.
- Respostas, mensagens fixadas, busca, preview de links e notificacoes.

## Stack

- Expo 54, React 19 e React Native 0.81
- Supabase (Database, Auth, Storage, Realtime e Edge Functions)
- OpenWeather API e Giphy API
- AsyncStorage e Expo Notifications

## Requisitos

- Node.js 20 ou superior
- npm
- Expo Go, Android Studio ou Xcode
- Projeto Supabase e chaves das APIs externas

## Configuracao local

1. Instale as dependencias:

	```bash
	npm install
	```

2. Copie `.env.example` para `.env` e preencha os valores do seu ambiente. Arquivos `.env` sao ignorados pelo Git.

3. Para builds Android, configure um `google-services.json` do seu proprio projeto Firebase. O arquivo e referenciado pelo `app.json` e nao deve conter credenciais administrativas.

4. Inicie o Expo:

	```bash
	npm start
	```

Comandos disponiveis:

```bash
npm run android
npm run ios
npm run web
npm run build:apk
```

## Supabase

Os scripts `supabase-*.sql` documentam a estrutura necessaria para um projeto novo. Execute-os no SQL Editor conforme as dependencias do seu ambiente. A Edge Function `supabase/functions/link-preview` pode ser publicada com:

```bash
supabase functions deploy link-preview
```

O estado local da CLI em `supabase/.temp` nao faz parte do repositorio.

## Estrutura

```text
App.js                       Entrada e navegacao
screens/                     Telas e notificacoes
components/                  Componentes reutilizaveis
modules/chat/                Constantes e utilitarios do chat
assets/                      Icones e ilustracoes do aplicativo
supabase.js                  Cliente Supabase
supabase/functions/          Edge Functions
supabase-*.sql               Scripts de banco de dados
```

## Seguranca

Nao versione `.env`, chaves privadas, certificados, tokens ou credenciais administrativas. O `google-services.json` contem configuracao publica do cliente Android; credenciais Firebase Admin devem permanecer fora do repositorio. Se uma chave for exposta, revogue-a no provedor e gere outra imediatamente.