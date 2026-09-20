# Live Weather

Aplicativo mobile de previsao do tempo com recursos de comunicacao em tempo real. O projeto foi desenvolvido com Expo e React Native, com persistencia e autenticacao integradas ao Supabase.
## Recursos

- Consulta do clima atual por cidade.
- Previsao para os proximos dias.
- Busca de municipios brasileiros.
- Cache local da ultima consulta para melhorar a experiencia offline.
- Perfis de usuario com cidade associada.
- Lista de conversas e salas de chat individuais ou em grupo.
- Envio de mensagens, imagens, videos, audio, documentos e figurinhas.
- Respostas, mensagens fixadas, busca e visualizacao de links.
- Notificacoes relacionadas ao clima e ao chat.
- Tema visual adaptado as condicoes meteorologicas.

## Tecnologias

- [Expo](https://expo.dev/) 54
- React 19
- React Native 0.81
- Supabase
- OpenWeather API
- AsyncStorage
- Expo Notifications, Camera, Media Library, AV e Image Picker

## Requisitos

- Node.js 20 ou superior
- npm
- Expo Go para testar em um dispositivo, ou Android Studio/Xcode para executar localmente
- Chave da API OpenWeather
- Projeto Supabase configurado

## Instalacao

```bash
npm install
```

Configure as credenciais e servicos externos antes de executar o app. As chaves nao devem ser commitadas no repositorio. Para novas instalacoes, prefira variaveis de ambiente ou um arquivo local ignorado pelo Git.

O arquivo `google-services.json` e usado pela configuracao Android do Expo. Use um arquivo pertencente ao seu proprio projeto Firebase e mantenha credenciais administrativas fora do repositorio.

## Executar

Inicie o servidor de desenvolvimento:

```bash
npm start
```

Comandos disponiveis:

```bash
npm run android   # Executa no Android
npm run ios       # Executa no iOS
npm run web       # Executa na web
npm run build:apk # Gera build Android pelo EAS
```

## Supabase

Os scripts SQL na raiz do projeto criam ou atualizam as estruturas usadas pelo app, incluindo perfis, grupos, descricoes e preview de links. Execute-os no SQL Editor do projeto Supabase na ordem adequada ao seu ambiente.

Para habilitar a sincronizacao dos favoritos de GIF, execute `supabase-stickers.sql`. O app armazena apenas URLs e reconstroi os GIFs recentes pelas mensagens enviadas, sem copiar imagens para o Storage. Depois de reinstalar, use o codigo do terminal anterior para recuperar o mesmo perfil e seus favoritos.

A funcao em `supabase/functions/link-preview` trata a obtencao de informacoes para previews de links. Consulte a documentacao do Supabase para publicar Edge Functions.

## Estrutura principal

```text
App.js                       Entrada e navegacao principal
screens/WeatherScreen.js    Consulta e exibicao do clima
screens/ChatListScreen.js    Lista de conversas e grupos
screens/ChatRoomScreen.js    Sala de conversa e envio de midia
screens/notificationService.js
							 Servico de notificacoes
components/                  Componentes reutilizaveis
supabase.js                  Cliente Supabase
supabase/functions/          Edge Functions
assets/                      Icones e imagens do app
```

## Seguranca

Nao adicione ao Git arquivos `.env`, chaves privadas, tokens, certificados ou credenciais administrativas. O `.gitignore` ja exclui arquivos de credenciais Firebase Admin e outros segredos comuns. Se uma chave for exposta, revogue-a no respectivo provedor e gere outra imediatamente.

## Status

Versao atual: **3.0.0**
Este projeto esta em desenvolvimento.