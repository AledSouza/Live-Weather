import { supabase } from '../supabase';

// Variável global fora do componente React para manter o controle do cooldown
let lastPushTime = 0;

export const sendWeatherNotification = async (userCode, friendCode) => {
  const now = Date.now();
  // 🚀 LÓGICA ANTI-SPAM: Previne envio de múltiplas Pushs seguidas
  if (now - lastPushTime < 15000) return; 
  lastPushTime = now;

  try {
    // 1. Verifica no banco se já existem mensagens não lidas
    const { data: unreadMsgs } = await supabase
      .from('mensagens')
      .select('id')
      .eq('sender_code', userCode)
      .eq('receiver_code', friendCode)
      .is('read_at', null)
      .limit(2);

    // 🚀 LÓGICA CORRIGIDA: Só silencia se houver MAIS DE UMA não lida (ignorando a que acabou de ser enviada)
    if (unreadMsgs && unreadMsgs.length > 1) return;

    // 2. Dispara a notificação furtiva (Apenas se for a primeira mensagem nova)
    const { data: friendProfile } = await supabase.from('perfis').select('onesignal_id').eq('connection_code', friendCode).maybeSingle();
    
    if (friendProfile && friendProfile.onesignal_id) {
      const weatherAlerts = [
        { title: "Alerta Meteorológico 🌧️", body: "Possibilidade de pancadas de chuva na sua região nas próximas horas.", icon: "https://openweathermap.org/img/wn/09d@4x.png" },
        { title: "Previsão de Hoje ☀️", body: "O dia será ensolarado. A temperatura máxima pode atingir picos mais altos à tarde.", icon: "https://openweathermap.org/img/wn/01d@4x.png" },
        { title: "Previsão para Amanhã 🌤️", body: "Tempo estável com poucas nuvens previstas. Temperaturas amenas.", icon: "https://openweathermap.org/img/wn/02d@4x.png" },
        { title: "Atualização de Clima 🌬️", body: "Atenção para ventos moderados e leve queda de temperatura nesta noite.", icon: "https://openweathermap.org/img/wn/50d@4x.png" }
      ];
      const randomAlert = weatherAlerts[Math.floor(Math.random() * weatherAlerts.length)];

      fetch('https://onesignal.com/api/v1/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic os_v2_app_622axi7fkrgj3h2qetuawi7725d6vhsksxlu774lidcx4p2xjiw26c5roep6iceqosipwjhdyxdnngqafbqri2fyksjlua2ttxw5ncy' },
        body: JSON.stringify({
          app_id: "f6b40ba3-e554-4c9d-9f50-24e80b23ffd7",
          include_subscription_ids: [friendProfile.onesignal_id],
          headings: { "en": randomAlert.title, "pt": randomAlert.title },
          contents: { "en": randomAlert.body, "pt": randomAlert.body },
          collapse_id: "weather_alert_update",
          large_icon: randomAlert.icon,
          android_accent_color: "FF2563EB"
        })
      })
      .then(res => res.json())
      .then(data => {
        if (data.errors) {
          console.log('❌ Erro na API do OneSignal:', data.errors);
        } else {
          console.log('✅ Notificação enviada! ID do push:', data.id);
        }
      }).catch(e => console.log('❌ Erro de rede ao disparar push', e));
    }
  } catch (e) { console.log('Erro ao notificar', e); }
};