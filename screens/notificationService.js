import { supabase } from '../supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

// 🚀 Configura como a notificação vai aparecer se o app estiver aberto
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export async function registerForPushNotificationsAsync() {
  let token;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#00ff66',
    });
  }

  if (Device.isDevice) {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') return null;
    
    try {
      const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
      token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    } catch (e) { console.log(e); }
  }
  return token;
}

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
    
    if (friendProfile && friendProfile.onesignal_id && /^ExponentPushToken\[.+\]$/.test(friendProfile.onesignal_id)) {
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

      console.log('➡️ Preparando envio para Expo Token:', friendProfile.onesignal_id);

      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: friendProfile.onesignal_id, // O banco continuará usando a coluna onesignal_id, mas agora salvará o Token do Expo lá
          sound: 'default',
          title: notifTitle,
          body: notifBody,
          data: { friendCode: userCode }, // Passa o seu código para o app do amigo saber quem mandou
        })
      });

      const result = await response.json();
      const ticket = Array.isArray(result.data) ? result.data[0] : result.data;
      
      if (!response.ok || ticket?.status === 'error') {
        console.error('❌ Falha real no envio:', ticket?.details?.error || result);
      } else {
        console.log('✅ Push enviado com sucesso via Expo!');
      }
    } else {
      console.log('⚠️ Token de notificação inválido ou ausente para este contato.');
    }
  } catch (e) { console.log('Erro ao notificar', e); }
};