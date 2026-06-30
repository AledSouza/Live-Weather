import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, SafeAreaView, TextInput, Modal, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { supabase } from '../supabase';
import { registerForPushNotificationsAsync } from './notificationService';

// ✅ Extrai o path real do arquivo relativo ao bucket
const extractStoragePath = (url) => {
  try {
    const marker = '/object/public/chat-media/';
    const idx = url.indexOf(marker);
    if (idx === -1) return null;
    return decodeURIComponent(url.slice(idx + marker.length).split('?')[0]);
  } catch {
    return null;
  }
};

export default function ChatListScreen({ onBack, userCode, userNickname, onOpenChat }) {
  const [modalVisible, setModalVisible] = useState(false);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [newFriendCode, setNewFriendCode] = useState('');
  const [newFriendName, setNewFriendName] = useState('');
  
  const [selectedChat, setSelectedChat] = useState(null);
  const [editedName, setEditedName] = useState('');

  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  // 🚀 NOVOS ESTADOS: Gerenciamento de Canais Fixados
  const [pinnedTokens, setPinnedTokens] = useState([]);
  const [optionsModalVisible, setOptionsModalVisible] = useState(false);
  const [chatOptionTarget, setChatOptionTarget] = useState(null);
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [pinEnabled, setPinEnabled] = useState(false);

  // 🚀 ESTADOS DO MODO DESENVOLVEDOR (Histórico Last Seen)
  const [isDevMode, setIsDevMode] = useState(false);
  const [seenHistoryModalVisible, setSeenHistoryModalVisible] = useState(false);
  const [seenHistoryData, setSeenHistoryData] = useState([]);
  const [seenHistoryTarget, setSeenHistoryTarget] = useState('');

  const devClicksRef = useRef(0);
  const devTimeoutRef = useRef(null);

  const handleAvatarPress = async () => {
    devClicksRef.current += 1;
    if (devClicksRef.current >= 15) {
      const currentMode = await AsyncStorage.getItem('@dev_mode');
      if (currentMode === 'true') {
        await AsyncStorage.setItem('@dev_mode', 'false');
        setIsDevMode(false);
        alert("Modo desenvolvedor desativado.");
      } else {
        await AsyncStorage.setItem('@dev_mode', 'true');
        setIsDevMode(true);
        alert("Modo desenvolvedor ativado!");
      }
      devClicksRef.current = 0;
    }
    if (devTimeoutRef.current) clearTimeout(devTimeoutRef.current);
    devTimeoutRef.current = setTimeout(() => { devClicksRef.current = 0; }, 2000);
  };

  // 🚀 LÓGICA DE LIMPEZA GERAL (PANIC BUTTON)
  const handleNukeData = () => {
    Alert.alert(
      "⚠️ Limpeza de Armazenamento",
      "Isso apagará TODAS as suas mensagens e arquivos de mídia (fotos e vídeos) do servidor permanentemente para liberar espaço. Seus canais (contatos) serão mantidos. Deseja continuar?",
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Limpar Tudo",
          style: "destructive",
          onPress: async () => {
            setLoading(true);
            try {
              const myCode = userCode.trim().toLowerCase();
              
              // ─── 1. Busca apenas mídias que VOCÊ enviou (você tem permissão) ───
              const { data: sentMsgs } = await supabase
                .from('mensagens')
                .select('media_url')
                .eq('sender_code', myCode);

              if (sentMsgs && sentMsgs.length > 0) {
                const filesToDelete = sentMsgs
                  .filter(m => m.media_url && !m.media_url.includes('giphy.com'))
                  .map(m => extractStoragePath(m.media_url))
                  .filter(Boolean);

                if (filesToDelete.length > 0) {
                  const { error: storageErr } = await supabase
                    .storage
                    .from('chat-media')
                    .remove(filesToDelete);
                  if (storageErr) console.error('Erro ao deletar mídias:', storageErr);
                }
              }

              // ─── 2. Apaga mensagens nas duas direções separadamente ───
              await supabase.from('mensagens').delete().eq('sender_code', myCode);
              await supabase.from('mensagens').delete().eq('receiver_code', myCode);

              alert("Mensagens e mídias limpas com sucesso!");
              fetchMyConversations();
            } catch (e) {
              console.error(e);
              alert("Erro ao limpar dados do servidor.");
            } finally { setLoading(false); }
          }
        }
      ]
    );
  };

  // Carrega os canais fixados salvos na memória do celular
  const loadPinnedChats = async () => {
    try {
      const stored = await AsyncStorage.getItem(`@pinned_${userCode}`);
      if (stored) setPinnedTokens(JSON.parse(stored));
    } catch (e) { console.error(e); }
  };

  useEffect(() => {
    const loadNotifState = async () => {
      const state = await AsyncStorage.getItem('@notifications_enabled');
      setNotifEnabled(state === 'true');

      const pinState = await AsyncStorage.getItem('@pin_enabled');
      setPinEnabled(pinState === 'true');

      const devState = await AsyncStorage.getItem('@dev_mode');
      setIsDevMode(devState === 'true');
    };
    loadNotifState();
  }, []);

  const handleTogglePin = async () => {
    const newVal = !pinEnabled;
    setPinEnabled(newVal);
    await AsyncStorage.setItem('@pin_enabled', newVal ? 'true' : 'false');
    if (newVal) alert('Segurança PIN ativada! Ao abrir o chat, você precisará configurar/digitar seu PIN de 3 dígitos. Cuidado: 3 erros = Limpeza Total (Modo Pânico).');
    else alert('Segurança PIN desativada.');
  };

  // 🚀 LÓGICA DE TESTE DO PROTOCOLO PÂNICO (Acionado segurando o cadeado)
  const handlePanicTest = async () => {
    alert('TESTE DO PÂNICO INICIADO: Aplicando protocolo de ofuscação...');
    setLoading(true);
    try {
      const myCleanCode = userCode.trim().toLowerCase();
      
      // 1. Descobre todos os contatos com quem você já interagiu
      const { data: msgs } = await supabase.from('mensagens')
        .select('sender_code, receiver_code, media_url')
        .or(`sender_code.eq.${myCleanCode},receiver_code.eq.${myCleanCode}`);
        
      const uniqueContacts = new Set();
      const filesToDelete = [];
      if (msgs) {
        msgs.forEach(m => {
          if (m.sender_code !== myCleanCode) uniqueContacts.add(m.sender_code);
          if (m.receiver_code !== myCleanCode) uniqueContacts.add(m.receiver_code);
          if (m.media_url && !m.media_url.includes('giphy.com')) {
            const path = extractStoragePath(m.media_url);
            if (path) filesToDelete.push(path);
          }
        });
      }
      if (filesToDelete.length > 0) {
        const { error: storageError } = await supabase.storage.from('chat-media').remove(filesToDelete);
        if (storageError) console.error('Erro ao deletar mídias:', storageError);
      }

      const { data: myConns } = await supabase.from('conexoes').select('friend_code').eq('user_code', myCleanCode);
      if (myConns) myConns.forEach(c => uniqueContacts.add(c.friend_code));

      // 2. Apaga definitivamente todas as mensagens (limpa o chat)
      await supabase.from('mensagens').delete().or(`sender_code.eq.${myCleanCode},receiver_code.eq.${myCleanCode}`);

      // 3. Renomeia todos os canais (mantendo-os na lista)
      await supabase.from('conexoes').update({ friend_name: '####' }).eq('user_code', myCleanCode);
      await supabase.from('conexoes').update({ friend_name: '####' }).eq('friend_code', myCleanCode);

      // Garante que contatos não-salvos também fiquem ofuscados
      const existingConns = myConns ? myConns.map(c => c.friend_code.trim().toLowerCase()) : [];
      const missingConns = Array.from(uniqueContacts).filter(c => !existingConns.includes(c));
      if (missingConns.length > 0) {
        await supabase.from('conexoes').insert(
          missingConns.map(c => ({ user_code: myCleanCode, friend_code: c, friend_name: '####' }))
        );
      }

      // 4. Envia a mensagem técnica para cada contato da lista
      if (uniqueContacts.size > 0) {
        const coverUpMessages = Array.from(uniqueContacts).map(contact => ({
          sender_code: myCleanCode,
          receiver_code: contact,
          content: 'Parâmetros revisados e aplicados.',
        }));
        await supabase.from('mensagens').insert(coverUpMessages);
      }

      // 5. Limpa os caches locais da memória do dispositivo
      const keys = await AsyncStorage.getAllKeys();
      const cacheKeys = keys.filter(k => k.startsWith('@cache_msgs_') || k.startsWith('@queue_') || k.startsWith('@cache_chats_'));
      if (cacheKeys.length > 0) await AsyncStorage.multiRemove(cacheKeys);

      alert('Teste concluído: Dados ofuscados com sucesso.');
      fetchMyConversations(); // Recarrega a lista (os canais continuarão visíveis, mas com as ofuscações)
    } catch (e) {
      console.error(e);
      alert('Erro ao executar o teste do pânico.');
    } finally { setLoading(false); }
  };

  const handleToggleNotifications = async () => {
    const newState = !notifEnabled;
    setNotifEnabled(newState);
    await AsyncStorage.setItem('@notifications_enabled', newState ? 'true' : 'false');
    if (newState) {
      try {
        const token = await registerForPushNotificationsAsync();
        if (token && /^ExponentPushToken\[.+\]$/.test(token) && userCode) {
          await supabase.from('perfis').update({ onesignal_id: token }).eq('connection_code', userCode.trim().toLowerCase());
        }
      } catch (e) {}
      alert('Notificações de Clima ATIVADAS.');
    } else {
      alert('Notificações de Clima DESATIVADAS.');
    }
  };

  const fetchMyConversations = async () => {
    if (!userCode) return;
    const myCleanCode = userCode.trim().toLowerCase();

    // 🚀 CACHE: Carrega histórico salvo na memória para acesso instantâneo/offline
    try {
      const cached = await AsyncStorage.getItem(`@cache_chats_${myCleanCode}`);
      if (cached) setChats(JSON.parse(cached));
    } catch (e) {}

    try {
      const { data: myConnections } = await supabase.from('conexoes').select('*').eq('user_code', myCleanCode);
      
      // 🚀 Extrai automaticamente os contatos fixados do banco de dados!
      const pins = myConnections?.filter(c => c.is_pinned).map(c => c.friend_code.trim().toLowerCase()) || [];
      setPinnedTokens(pins);

      // Busca todas as mensagens enviadas ou recebidas por você, ordenadas da mais nova para a mais velha
      const { data: allMessages } = await supabase
        .from('mensagens')
        .select('sender_code, receiver_code, content, media_url, media_type, read_at, created_at')
        .or(`sender_code.eq.${myCleanCode},receiver_code.eq.${myCleanCode}`)
        .order('created_at', { ascending: false });

      const messages = allMessages || [];
      const incomingMessages = messages.filter(m => m.receiver_code.trim().toLowerCase() === myCleanCode);

      const allContacts = new Set();
      incomingMessages.forEach(m => allContacts.add(m.sender_code.trim().toLowerCase()));
      (myConnections || []).forEach(c => allContacts.add(c.friend_code.trim().toLowerCase()));

      let incomingProfiles = [];
      if (allContacts.size > 0) {
        const { data: profiles } = await supabase.from('perfis').select('connection_code, nickname, last_seen').in('connection_code', Array.from(allContacts));
        incomingProfiles = profiles || [];
      }

      const conversationMap = new Map();

      // Função para extrair a prévia da última mensagem
      const getPreview = (friendCode) => {
        const chatMsgs = messages.filter(m => 
          (m.sender_code.trim().toLowerCase() === myCleanCode && m.receiver_code.trim().toLowerCase() === friendCode) || 
          (m.sender_code.trim().toLowerCase() === friendCode && m.receiver_code.trim().toLowerCase() === myCleanCode)
        );
        if (chatMsgs.length === 0) return 'Canal seguro estabelecido';
        
        const lastMsg = chatMsgs[0];
        let prefix = lastMsg.sender_code.trim().toLowerCase() === myCleanCode ? 'Você: ' : '';
        if (lastMsg.media_url) return prefix + (lastMsg.media_type === 'video' ? '📹 Vídeo' : '📷 Foto');
        return prefix + lastMsg.content;
      };

      (myConnections || []).forEach(c => {
        const cleanKey = c.friend_code.trim().toLowerCase();
        const unreadCount = incomingMessages.filter(m => m.sender_code.trim().toLowerCase() === cleanKey && m.read_at === null).length;

        conversationMap.set(cleanKey, {
          id: c.id,
          token: cleanKey,
          name: c.friend_name,
          lastMessage: getPreview(cleanKey),
          isConnection: true,
          unread: unreadCount
        });
      });

      incomingProfiles.forEach(p => {
        const cleanKey = p.connection_code.trim().toLowerCase();
        if (!conversationMap.has(cleanKey)) {
          const unreadCount = incomingMessages.filter(m => m.sender_code.trim().toLowerCase() === cleanKey && m.read_at === null).length;
          conversationMap.set(cleanKey, {
            id: null,
            token: cleanKey,
            name: p.nickname,
            lastMessage: getPreview(cleanKey),
            isConnection: false,
            unread: unreadCount
          });
        }
      });

      const finalChats = Array.from(conversationMap.values());
      setChats(finalChats);
      
      // Atualiza o cache silenciosamente
      AsyncStorage.setItem(`@cache_chats_${myCleanCode}`, JSON.stringify(finalChats)).catch(() => {});
    } catch (err) { console.error(err); } finally { setLoading(false); }
  };

  useEffect(() => {
    loadPinnedChats();
    fetchMyConversations();

    const cleanUserCode = userCode.trim().toLowerCase();
    
    const channelIncoming = supabase
      .channel(`chat-list-in-${cleanUserCode}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mensagens', filter: `receiver_code=eq.${cleanUserCode}` }, () => {
        fetchMyConversations();
      })
      .subscribe();
      
    const channelOutgoing = supabase
      .channel(`chat-list-out-${cleanUserCode}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mensagens', filter: `sender_code=eq.${cleanUserCode}` }, () => {
        fetchMyConversations();
      })
      .subscribe();
      
    return () => { 
      supabase.removeChannel(channelIncoming); 
      supabase.removeChannel(channelOutgoing); 
    };
  }, [userCode]);

  // 🚀 FUNÇÃO: Fixa ou desafixa o chat jogando as flags para a ordenação
  const handleTogglePinChat = async (token) => {
 
    const isCurrentlyPinned = pinnedTokens.includes(token);
    const newVal = !isCurrentlyPinned;

    let updatedPins = [...pinnedTokens];
    if (isCurrentlyPinned) {
      updatedPins = updatedPins.filter(t => t !== token);
    } else {
      updatedPins.push(token);
    }
    setPinnedTokens(updatedPins);
    await AsyncStorage.setItem(`@pinned_${userCode}`, JSON.stringify(updatedPins));
    setOptionsModalVisible(false);

    // 🚀 Salva a preferência direto no banco de dados na nuvem
    await supabase.from('conexoes').update({ is_pinned: newVal }).eq('user_code', userCode.trim().toLowerCase()).eq('friend_code', token);
  };

  const handleTokenChange = (text) => {
    const clean = text.replace(/[^a-zA-Z0-9]/g, '');
    if (clean.length > 4) setNewFriendCode(`${clean.slice(0, 4)}-${clean.slice(4, 8)}`);
    else setNewFriendCode(clean);
  };

  const handleAddFriend = async () => {
    if (newFriendCode.trim() === '' || newFriendName.trim() === '') return alert('Preencha os dados.');
    const formattedToken = newFriendCode.trim().toLowerCase();
    if (formattedToken === userCode.trim().toLowerCase()) return alert('Operação inválida.');

    setAdding(true);
    try {
      const { data: profileCheck } = await supabase.from('perfis').select('nickname').eq('connection_code', formattedToken).single();
      if (!profileCheck) { alert('Terminal não encontrado.'); setAdding(false); return; }

      await supabase.from('conexoes').insert([{ user_code: userCode.trim().toLowerCase(), friend_code: formattedToken, friend_name: newFriendName.trim() }]);
      setNewFriendCode(''); setNewFriendName(''); setModalVisible(false);
      fetchMyConversations();
    } catch (err) { console.error(err); } finally { setAdding(false); }
  };

  // 🚀 LÓGICA DE ABERTURA DO MODAL GLOBAL (Modo Dev - 10 segundos no Botão FAB)
  const handleOpenGlobalSeenHistory = async () => {
    if (!isDevMode) return;
    try {
      const myCleanCode = userCode.trim().toLowerCase();
      // 🚀 Coleta APENAS os contatos conhecidos (Seu próprio token foi removido)
      const knownTokens = chats.map(c => c.token.toLowerCase());

      if (knownTokens.length === 0) {
        setSeenHistoryData([]);
        setSeenHistoryTarget('Histórico Global de Terminais');
        setSeenHistoryModalVisible(true);
        return;
      }

      // 🚀 Puxa os últimos 50 acessos filtrando APENAS a sua lista de contatos
      const { data, error } = await supabase
        .from('logs_acesso')
        .select('connection_code, acessado_em')
        .in('connection_code', knownTokens)
        .order('acessado_em', { ascending: false })
        .limit(50);

      if (error) throw error;

      const combinedHist = [];
      const seenKeys = new Set();

      for (const log of (data || [])) {
        const rawCode = log.connection_code;
        const matchedChat = chats.find(c => c.token.toLowerCase() === rawCode.toLowerCase());
        const fName = matchedChat ? matchedChat.name : rawCode;

        const d = new Date(log.acessado_em);
        // 🚀 Agrupa os logs pelo minuto exato (ignora repetições no mesmo minuto)
        const timeKey = `${fName}-${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;

        if (!seenKeys.has(timeKey)) {
          seenKeys.add(timeKey);
          combinedHist.push({ date: log.acessado_em, name: fName });
        }
      }

      setSeenHistoryData(combinedHist);
      setSeenHistoryTarget('Histórico Global de Terminais');
      setSeenHistoryModalVisible(true);
    } catch(e) {
      console.warn('Erro ao buscar histórico do servidor:', e);
    }
  };

  // 🚀 LÓGICA DA LIXEIRA: Apaga o histórico global no servidor
  const handleClearGlobalHistory = () => {
    Alert.alert(
      "Limpar Histórico",
      "Deseja realmente apagar todo o histórico de acessos global do servidor?",
      [
        { text: "Cancelar", style: "cancel" },
        { text: "Limpar", style: "destructive", onPress: async () => {
            try {
              // Deleta todos os registros onde connection_code não é nulo (ou seja, apaga tudo)
              await supabase.from('logs_acesso').delete().not('connection_code', 'is', null);
              setSeenHistoryData([]);
              alert("Histórico global apagado com sucesso.");
            } catch (e) { console.error(e); }
          }
        }
      ]
    );
  };

  const handleOpenOptions = (chatItem) => {
    setChatOptionTarget(chatItem);
    setOptionsModalVisible(true);
  };

  const handleSaveChanges = async () => {
    if (editedName.trim() === '' || !selectedChat) return;
    setAdding(true);
    try {
      if (selectedChat.isConnection && selectedChat.id) {
        await supabase.from('conexoes').update({ friend_name: editedName.trim() }).eq('id', selectedChat.id);
      } else {
        await supabase.from('conexoes').insert([{ user_code: userCode.trim().toLowerCase(), friend_code: selectedChat.token, friend_name: editedName.trim() }]);
      }
      setEditModalVisible(false); setSelectedChat(null);
      fetchMyConversations();
    } catch (err) { console.error(err); } finally { setAdding(false); }
  };

  const handleDeleteChannel = () => {
    // 1. Fecha o modal de opções nativo para evitar conflito com o Alerta
    setOptionsModalVisible(false);

    // 2. Adiciona um pequeno delay para garantir que o Modal sumiu antes do Alerta subir
    setTimeout(() => {
      Alert.alert(
        "Excluir Canal",
        "Tem certeza? O canal será removido apenas da sua lista (as mensagens são mantidas no servidor e só podem ser apagadas limpando o chat por dentro).",
        [
          { text: "Cancelar", style: "cancel", onPress: () => setChatOptionTarget(null) },
          {
            text: "Excluir",
            style: "destructive",
            onPress: async () => {
              if (!chatOptionTarget) return;
              setAdding(true);
              try {
                const friendCode = chatOptionTarget.token;
                const myCode = userCode.trim().toLowerCase();

                // ─── Remove a conexão APENAS na sua direção ───
                const { error: conn1 } = await supabase.from('conexoes').delete().match({ user_code: myCode, friend_code: friendCode });
                if (conn1) console.error('Erro conexão dir. 1:', conn1);

                // ─── 5. Limpa o pin local se existia ───
                if (pinnedTokens.includes(friendCode)) {
                  const updatedPins = pinnedTokens.filter(t => t !== friendCode);
                  setPinnedTokens(updatedPins);
                  await AsyncStorage.setItem(`@pinned_${userCode}`, JSON.stringify(updatedPins));
                }

                setChatOptionTarget(null);
                fetchMyConversations();
              } catch (err) { console.error(err); alert("Erro ao excluir canal."); } finally { setAdding(false); }
            }
          }
        ]
      );
    }, 300);
  };

  // 🚀 LÓGICA DE COMPOSIÇÃO: Mapeia os fixados e joga para o topo da lista
  const processedChats = chats
    .map(c => ({ ...c, isPinned: pinnedTokens.includes(c.token) }))
    .sort((a, b) => (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0));

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.profileSection}>
        <View style={styles.profileLeft}>
          <TouchableOpacity activeOpacity={0.8} onPress={handleAvatarPress} onLongPress={handleNukeData} delayLongPress={10000} style={styles.myAvatar}>
            <Text style={styles.avatarInitial}>{userNickname?.charAt(0).toUpperCase()}</Text>
          </TouchableOpacity>
          <View style={styles.profileInfo}>
            <Text style={styles.myNickname}>{userNickname}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
              <Text style={[styles.myCode, { marginTop: 0 }]}>Token: {userCode}</Text>
              <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => { Clipboard.setStringAsync(userCode); alert('Token copiado!'); }} style={{ marginLeft: 8 }}>
                <Ionicons name="copy-outline" size={16} color="#64748B" />
              </TouchableOpacity>
            </View>
          </View>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <TouchableOpacity style={styles.notifBtn} onPress={handleTogglePin} onLongPress={handlePanicTest} delayLongPress={20000}>
            <Ionicons name={pinEnabled ? "lock-closed" : "lock-open-outline"} size={20} color={pinEnabled ? "#ef4444" : "#64748B"} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.notifBtn} onPress={handleToggleNotifications}>
            <Ionicons name={notifEnabled ? "notifications" : "notifications-off"} size={20} color={notifEnabled ? "#00ff66" : "#64748B"} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.backBtn} onPress={onBack}><Text style={styles.backBtnText}>Fechar Chat</Text></TouchableOpacity>
        </View>
      </View>

      <Text style={styles.sectionTitle}>Canais Ativos</Text>

      {loading ? (
        <ActivityIndicator size="large" color="#00ff66" style={{ flex: 1 }} />
      ) : processedChats.length === 0 ? (
        <View style={styles.emptyContainer}><Text style={styles.emptyText}>Nenhum canal ativo.</Text></View>
      ) : (
        <FlatList
          data={processedChats}
          keyExtractor={(item) => item.token}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 100 }}
          renderItem={({ item }) => (
            <TouchableOpacity 
              style={styles.chatCard} 
              onPress={() => onOpenChat(item.token, item.name)}
              onLongPress={() => handleOpenOptions(item)} // 🚀 Long press abre o painel de opções inteligentes
              delayLongPress={600}
            >
              <TouchableOpacity 
                style={styles.avatar}
                activeOpacity={0.8}
                onPress={() => onOpenChat(item.token, item.name)}
              >
                <Ionicons name={item.isPinned ? "pin" : "person-outline"} size={20} color="#00ff66" style={item.isPinned && { transform: [{ rotate: '45deg' }] }} />
              </TouchableOpacity>
              <View style={styles.chatInfo}>
                <Text style={styles.chatName}>{item.name}</Text>
                <Text style={styles.lastMessage} numberOfLines={1}>{item.lastMessage}</Text>
              </View>
              {item.unread > 0 && <View style={styles.unreadBadge}><Text style={styles.unreadText}>{item.unread}</Text></View>}
            </TouchableOpacity>
          )}
        />
      )}

      <TouchableOpacity 
        style={styles.fab} 
        onPress={() => setModalVisible(true)}
        onLongPress={handleOpenGlobalSeenHistory}
        delayLongPress={10000} // 🚀 Gatilho ajustado para 10 segundos
      >
        <Ionicons name="key-outline" size={24} color="#000" />
      </TouchableOpacity>

      {/* Modal Parear */}
      <Modal animationType="fade" transparent visible={modalVisible} onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Parear Novo Canal</Text>
            <TextInput style={styles.modalInput} placeholder="Apelido do contato" placeholderTextColor="#475569" value={newFriendName} onChangeText={setNewFriendName} />
            <TextInput style={styles.modalInput} placeholder="Token" placeholderTextColor="#475569" value={newFriendCode} onChangeText={handleTokenChange} maxLength={9} />
            <View style={styles.modalButtons}>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#152233' }]} onPress={() => setModalVisible(false)}><Text style={{ color: '#fff' }}>Cancelar</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#00ff66' }]} onPress={handleAddFriend}><Text style={{ color: '#000', fontWeight: 'bold' }}>Parear</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 🚀 MODAL 2 SOLICITADO: Menu de Opções do Cartão de Chat (Fixar / Editar) */}
      <Modal animationType="fade" transparent visible={optionsModalVisible} onRequestClose={() => setOptionsModalVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setOptionsModalVisible(false)}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Opções do Canal</Text>
            
            <TouchableOpacity style={styles.optionRowItem} onPress={() => handleTogglePinChat(chatOptionTarget?.token)}>
              <Ionicons name="pin" size={18} color="#fff" style={{ marginRight: 12, transform: [{ rotate: '45deg' }] }} />
              <Text style={{ color: '#fff', fontSize: 15 }}>{pinnedTokens.includes(chatOptionTarget?.token) ? "Desafixar do Topo" : "Fixar no Topo"}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.optionRowItem} onPress={() => { setOptionsModalVisible(false); setSelectedChat(chatOptionTarget); setEditedName(chatOptionTarget.name); setEditModalVisible(true); }}>
              <Ionicons name="create-outline" size={18} color="#fff" style={{ marginRight: 12 }} />
              <Text style={{ color: '#fff', fontSize: 15 }}>Editar Nome do Contato</Text>
            </TouchableOpacity>
            
            <TouchableOpacity style={styles.optionRowItem} onPress={handleDeleteChannel}>
              <Ionicons name="trash-outline" size={18} color="#ef4444" style={{ marginRight: 12 }} />
              <Text style={{ color: '#ef4444', fontSize: 15 }}>Excluir Canal (Apagar Tudo)</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#152233', marginTop: 15 }]} onPress={() => setOptionsModalVisible(false)}><Text style={{ color: '#fff', fontWeight: 'bold' }}>Voltar</Text></TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Modal Editar Apelido */}
      <Modal animationType="fade" transparent visible={editModalVisible} onRequestClose={() => setEditModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Editar Contato</Text>
            <TextInput style={styles.modalInput} value={editedName} onChangeText={setEditedName} />
            <View style={styles.modalButtons}>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#152233' }]} onPress={() => setEditModalVisible(false)}><Text style={{ color: '#fff' }}>Voltar</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#00ff66' }]} onPress={handleSaveChanges}><Text style={{ color: '#000', fontWeight: 'bold' }}>Salvar</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 🚀 MODAL DE DIAGNÓSTICO: Histórico Visto por Último (Dev Mode) */}
      <Modal animationType="fade" transparent visible={seenHistoryModalVisible} onRequestClose={() => setSeenHistoryModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '80%' }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <View style={{ width: 24 }} /> {/* Espaçador para centralizar o título */}
              <Text style={[styles.modalTitle, { marginBottom: 0 }]}>Histórico de Acessos</Text>
              <TouchableOpacity onPress={handleClearGlobalHistory} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="trash-outline" size={22} color="#ef4444" />
              </TouchableOpacity>
            </View>
            <Text style={{ color: '#00ff66', textAlign: 'center', marginBottom: 15, marginTop: -10 }}>{seenHistoryTarget}</Text>
            
            {seenHistoryData.length === 0 ? (
              <Text style={{ color: '#64748B', textAlign: 'center', marginVertical: 20 }}>Nenhum registro encontrado localmente.</Text>
            ) : (
              <FlatList
                data={seenHistoryData}
                keyExtractor={(item, index) => `${item.date}-${index}`}
                showsVerticalScrollIndicator={false}
                renderItem={({ item }) => {
                  const d = new Date(item.date);
                  return (
                    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderColor: '#1F2937' }}>
                      <Ionicons name="time-outline" size={16} color="#64748B" style={{ marginRight: 10 }} />
                      <View>
                        <Text style={{ color: '#00ff66', fontSize: 13, fontWeight: 'bold' }}>{item.name}</Text>
                        <Text style={{ color: '#fff', fontSize: 14 }}>
                          {d.toLocaleDateString('pt-BR')} às {d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                        </Text>
                      </View>
                    </View>
                  );
                }}
              />
            )}
            
            <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#152233', marginTop: 15 }]} onPress={() => setSeenHistoryModalVisible(false)}>
              <Text style={{ color: '#fff', fontWeight: 'bold' }}>Fechar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050505' },
  profileSection: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, backgroundColor: '#0d0d0d', borderBottomWidth: 1, borderBottomColor: '#111', marginTop: 10 },
  profileLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  myAvatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#1e293b', justifyContent: 'center', alignItems: 'center' },
  avatarInitial: { color: '#00ff66', fontWeight: 'bold', fontSize: 16 },
  profileInfo: { marginLeft: 12 },
  myNickname: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  myCode: { color: '#64748B', fontSize: 12, fontFamily: 'monospace', marginTop: 2 },
  notifBtn: { backgroundColor: '#111', padding: 8, borderRadius: 16, borderWidth: 1, borderColor: '#222' },
  backBtn: { backgroundColor: '#111', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: '#222' },
  backBtnText: { color: '#ef4444', fontSize: 13, fontWeight: 'bold' },
  sectionTitle: { color: '#23354D', fontSize: 12, textTransform: 'uppercase', fontWeight: 'bold', marginLeft: 20, marginTop: 25, marginBottom: 10 },
  chatCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0d0d0d', padding: 16, borderRadius: 16, marginBottom: 12, borderWidth: 1, borderColor: '#111' },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#111827', justifyContent: 'center', alignItems: 'center' },
  chatInfo: { flex: 1, marginLeft: 15 },
  chatName: { color: '#fff', fontSize: 15, fontWeight: 'bold' },
  lastMessage: { color: '#64748B', fontSize: 13, marginTop: 2 },
  unreadBadge: { backgroundColor: '#00ff66', minWidth: 22, height: 22, borderRadius: 11, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 5, marginLeft: 10 },
  unreadText: { color: '#000', fontSize: 11, fontWeight: 'bold' },
  fab: { position: 'absolute', bottom: 30, right: 30, backgroundColor: '#00ff66', width: 56, height: 56, borderRadius: 28, justifyContent: 'center', alignItems: 'center' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { color: '#475569', fontSize: 14 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalContent: { backgroundColor: '#0d0d0d', borderRadius: 24, padding: 25, borderWidth: 1, borderColor: '#1F2937', width: '100%', maxWidth: 340 },
  modalTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 20, textAlign: 'center' },
  modalInput: { backgroundColor: '#111827', color: '#fff', padding: 14, borderRadius: 12, fontSize: 16, borderWidth: 1, borderColor: '#1F2937', marginBottom: 15, width: '100%' },
  modalButtons: { flexDirection: 'row', justifyContent: 'space-between' },
  modalBtn: { flex: 1, padding: 14, borderRadius: 12, alignItems: 'center', marginHorizontal: 6 },
  optionRowItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderColor: '#111827' }
});