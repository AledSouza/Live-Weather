import { supabase } from '../supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Mapa global para manter o controle de tempo por contato (evita bloquear notificação de amigos diferentes)
const lastPushTimeMap = {};
const API_KEY = 'cb4d2d940cde8d6eb30c2531b3392c41';

export const sendWeatherNotification = async (userCode, friendCode) => {
  const now = Date.now();
  // 🚀 LÓGICA ANTI-SPAM: Previne envio de múltiplas Pushs seguidas para a MESMA pessoa
  if (now - (lastPushTimeMap[friendCode] || 0) < 15000) return; 
  lastPushTimeMap[friendCode] = now;

  try {
    // 1. Verifica no banco se já existem mensagens não lidas
    const { data: unreadMsgs } = await supabase
      .from('mensagens')
      .select('id')
      .eq('sender_code', userCode)
      .eq('receiver_code', friendCode)
      .is('read_at', null)
      .limit(2);

    // 🚀 FURTIVIDADE ATIVADA: Só notifica a PRIMEIRA mensagem.
    // Se já houver mensagens antigas não lidas aguardando na gaveta, fica em silêncio.
    if (unreadMsgs && unreadMsgs.length > 1) return;

    // 2. Dispara a notificação furtiva (Apenas se for a primeira mensagem nova)
    // Puxa apenas o ID de push (mantém o banco de dados seguro sem exigir a coluna 'city')
    const { data: friendProfile } = await supabase.from('perfis').select('onesignal_id').eq('connection_code', friendCode).maybeSingle();
    
    if (friendProfile && friendProfile.onesignal_id) {
      // Valores padrão (Fallback caso a API do clima não responda a tempo)
      let notifTitle = "Atualização de Clima 🌬️";
      let notifBody = "Possibilidade de alterações climáticas na sua região nas próximas horas.";
      let notifIcon = "https://openweathermap.org/img/wn/02d@4x.png";

      // 🚀 BUSCA O CLIMA REAL DA CIDADE SALVA NO MOMENTO DO ENVIO
      try {
        // Provisório: usa a cidade local do AsyncStorage para não quebrar o Supabase
        const savedCity = await AsyncStorage.getItem('@user_city') || 'São Paulo';
        const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(savedCity)},BR&appid=${API_KEY}&units=metric&lang=pt_br`);
        
        if (res.ok) {
          const data = await res.json();
          const temp = Math.round(data.main.temp);
          const desc = data.weather[0].description;
          const iconCode = data.weather[0].icon;
          
          notifTitle = `Previsão do Tempo ${iconCode.includes('n') ? '🌙' : '☀️'}`;
          notifBody = `${desc.charAt(0).toUpperCase() + desc.slice(1)}, ${temp}°C agora.`;
          notifIcon = `https://openweathermap.org/img/wn/${iconCode}@4x.png`;
        }
      } catch (err) { console.log('Erro ao buscar clima real para notificação', err); }

      console.log('➡️ Preparando envio para OneSignal ID:', friendProfile.onesignal_id);

      const response = await fetch('https://onesignal.com/api/v1/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic os_v2_app_622axi7fkrgj3h2qetuawi7726fcv3rwtncu5mufgmep3dp63xnnubjdq43wtu4wlefmrrbgg6ub5w4gnviicd4ahowme4r57uvenhq' },
        body: JSON.stringify({
          app_id: "f6b40ba3-e554-4c9d-9f50-24e80b23ffd7",
          target_channel: "push",
          include_subscription_ids: [friendProfile.onesignal_id],
          headings: { "en": notifTitle, "pt": notifTitle },
          contents: { "en": notifBody, "pt": notifBody },
          collapse_id: "weather_alert_update",
          large_icon: notifIcon,
          android_accent_color: "FF2563EB"
        })
      });

      if (!response.ok) {
        const errorBody = await response.json();
        console.error('❌ OneSignal erro HTTP:', response.status, errorBody);
      } else {
        const result = await response.json();
        console.log('✅ Push enviado com sucesso:', result.id);
      }
    }
  } catch (e) { console.log('Erro ao notificar', e); }
};