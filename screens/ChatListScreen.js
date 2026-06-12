import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, SafeAreaView, TextInput, Modal, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { OneSignal } from 'react-native-onesignal';
import { supabase } from '../supabase';

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

  const devClicksRef = useRef(0);
  const devTimeoutRef = useRef(null);

  const handleAvatarPress = async () => {
    devClicksRef.current += 1;
    if (devClicksRef.current >= 15) {
      const currentMode = await AsyncStorage.getItem('@dev_mode');
      if (currentMode === 'true') {
        await AsyncStorage.setItem('@dev_mode', 'false');
        alert("Modo desenvolvedor desativado.");
      } else {
        await AsyncStorage.setItem('@dev_mode', 'true');
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
      "Isso apagará TODOS os seus canais, mensagens e arquivos de mídia (fotos e vídeos) do servidor permanentemente para liberar espaço. Deseja continuar?",
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Limpar Tudo",
          style: "destructive",
          onPress: async () => {
            setLoading(true);
            try {
              const myCleanCode = userCode.trim().toLowerCase();
              
              // 1. Busca todas as mídias (fotos/vídeos) ligadas a você e deleta do Storage
              const { data: msgs } = await supabase.from('mensagens').select('media_url').or(`sender_code.eq.${myCleanCode},receiver_code.eq.${myCleanCode}`);
              if (msgs && msgs.length > 0) {
                const filesToDelete = msgs.filter(m => m.media_url).map(m => m.media_url.split('/').pop());
                if (filesToDelete.length > 0) await supabase.storage.from('chat-media').remove(filesToDelete);
              }

              // 2. Apaga definitivamente as conversas e canais do banco de dados
              await supabase.from('mensagens').delete().or(`sender_code.eq.${myCleanCode},receiver_code.eq.${myCleanCode}`);
              await supabase.from('conexoes').delete().or(`user_code.eq.${myCleanCode},friend_code.eq.${myCleanCode}`);

              alert("Armazenamento e canais limpos com sucesso!");
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
    };
    loadNotifState();
  }, []);

  const handleToggleNotifications = async () => {
    const newState = !notifEnabled;
    setNotifEnabled(newState);
    await AsyncStorage.setItem('@notifications_enabled', newState ? 'true' : 'false');
    if (newState) {
      OneSignal.User.pushSubscription.optIn();
      try {
        const osId = await OneSignal.User.pushSubscription.getIdAsync();
        if (osId && userCode) {
          await supabase.from('perfis').update({ onesignal_id: osId }).eq('connection_code', userCode.trim().toLowerCase());
        }
      } catch (e) {}
      alert('Notificações de Clima ATIVADAS.');
    } else {
      OneSignal.User.pushSubscription.optOut();
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
      
      // Busca todas as mensagens enviadas ou recebidas por você, ordenadas da mais nova para a mais velha
      const { data: allMessages } = await supabase
        .from('mensagens')
        .select('sender_code, receiver_code, content, media_url, media_type, read_at, created_at')
        .or(`sender_code.eq.${myCleanCode},receiver_code.eq.${myCleanCode}`)
        .order('created_at', { ascending: false });

      const messages = allMessages || [];
      const incomingMessages = messages.filter(m => m.receiver_code.trim().toLowerCase() === myCleanCode);

      const uniqueSenders = [...new Set(incomingMessages.map(m => m.sender_code.trim().toLowerCase()))];
      let incomingProfiles = [];
      if (uniqueSenders.length > 0) {
        const { data: profiles } = await supabase.from('perfis').select('connection_code, nickname').in('connection_code', uniqueSenders);
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

    // 🚀 GARANTIA: Sincroniza o OneSignal ID mais recente com o servidor
    const syncOsId = async () => {
      try {
        const osId = await OneSignal.User.pushSubscription.getIdAsync();
        if (osId && userCode) {
          await supabase.from('perfis').update({ onesignal_id: osId }).eq('connection_code', userCode.trim().toLowerCase());
        }
      } catch (e) {}
    };
    syncOsId();

    // 🚀 BLINDAGEM ABSOLUTA: Escuta ativamente o status da OneSignal. Se o ID for gerado com atraso, salva na hora!
    const handlePushSubscriptionChange = async (event) => {
      if (event.current.id && userCode) {
        await supabase.from('perfis').update({ onesignal_id: event.current.id }).eq('connection_code', userCode.trim().toLowerCase());
      }
    };
    OneSignal.User.pushSubscription.addEventListener('change', handlePushSubscriptionChange);

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
      OneSignal.User.pushSubscription.removeEventListener('change', handlePushSubscriptionChange);
    };
  }, [userCode]);

  // 🚀 FUNÇÃO: Fixa ou desafixa o chat jogando as flags para a ordenação
  const handleTogglePin = async (token) => {
    let updatedPins = [...pinnedTokens];
    if (updatedPins.includes(token)) {
      updatedPins = updatedPins.filter(t => t !== token);
    } else {
      updatedPins.push(token);
    }
    setPinnedTokens(updatedPins);
    await AsyncStorage.setItem(`@pinned_${userCode}`, JSON.stringify(updatedPins));
    setOptionsModalVisible(false);
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
        "Tem certeza? Todas as mensagens serão apagadas permanentemente para ambos os terminais.",
        [
          { text: "Cancelar", style: "cancel", onPress: () => setChatOptionTarget(null) },
          {
            text: "Excluir",
            style: "destructive",
            onPress: async () => {
              if (!chatOptionTarget) return;
              setAdding(true);
              try {
                const friendCleanCode = chatOptionTarget.token;
                const myCleanCode = userCode.trim().toLowerCase();

                // 1. Deleta a conexão nas DUAS direções para garantir a exclusão total
                await supabase.from('conexoes').delete().match({ user_code: myCleanCode, friend_code: friendCleanCode });
                await supabase.from('conexoes').delete().match({ user_code: friendCleanCode, friend_code: myCleanCode });

                // 2. Deleta TODAS as mensagens nas DUAS direções (evita bugs do operador OR no banco)
                await supabase.from('mensagens').delete().match({ sender_code: myCleanCode, receiver_code: friendCleanCode });
                await supabase.from('mensagens').delete().match({ sender_code: friendCleanCode, receiver_code: myCleanCode });

                // 3. Remove de "Fixados" estritamente (sem fazer toggle reverso)
                if (pinnedTokens.includes(friendCleanCode)) {
                  const updatedPins = pinnedTokens.filter(t => t !== friendCleanCode);
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
              <View style={styles.avatar}>
                <Ionicons name={item.isPinned ? "pin" : "person-outline"} size={20} color="#00ff66" style={item.isPinned && { transform: [{ rotate: '45deg' }] }} />
              </View>
              <View style={styles.chatInfo}>
                <Text style={styles.chatName}>{item.name}</Text>
                <Text style={styles.lastMessage} numberOfLines={1}>{item.lastMessage}</Text>
              </View>
              {item.unread > 0 && <View style={styles.unreadBadge}><Text style={styles.unreadText}>{item.unread}</Text></View>}
            </TouchableOpacity>
          )}
        />
      )}

      <TouchableOpacity style={styles.fab} onPress={() => setModalVisible(true)}><Ionicons name="key-outline" size={24} color="#000" /></TouchableOpacity>

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
            
            <TouchableOpacity style={styles.optionRowItem} onPress={() => handleTogglePin(chatOptionTarget?.token)}>
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