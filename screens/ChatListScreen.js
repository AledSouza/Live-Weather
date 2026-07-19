import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, SafeAreaView, TextInput, Modal, ActivityIndicator, Alert, Image, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from '../supabase';
import { registerForPushNotificationsAsync } from './notificationService';
import { useToast } from '../components/Toast';

const SUPABASE_URL = 'https://rzmhvinmavwgtglrhqmf.supabase.co';
const GROUP_PREFIX = 'group:';
const getGroupToken = (groupId) => `${GROUP_PREFIX}${groupId}`;
const isGroupToken = (token) => String(token || '').startsWith(GROUP_PREFIX);
const normalizeToken = (token) => String(token || '').trim().toLowerCase();
const normalizePinnedTokens = (tokens = []) => [...new Set((tokens || []).map(normalizeToken).filter(Boolean))];
const getPinnedStorageKey = (value) => `@pinned_${normalizeToken(value)}`;

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

export default function ChatListScreen({ onBack, userCode, userNickname, onOpenChat, setPickerActive }) {
  const toast = useToast();
  const [modalVisible, setModalVisible] = useState(false);
  const [groupModalVisible, setGroupModalVisible] = useState(false);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [newFriendCode, setNewFriendCode] = useState('');
  const [newFriendName, setNewFriendName] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupPhoto, setNewGroupPhoto] = useState(null);
  const [selectedGroupContacts, setSelectedGroupContacts] = useState([]);
  
  const [selectedChat, setSelectedChat] = useState(null);
  const [editedName, setEditedName] = useState('');

  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
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
        toast("Modo desenvolvedor desativado.");
      } else {
        await AsyncStorage.setItem('@dev_mode', 'true');
        setIsDevMode(true);
        toast("Modo desenvolvedor ativado!");
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

              const { data: myGroupLinks } = await supabase.from('grupo_membros').select('group_id').eq('member_code', myCode);
              const myGroupIds = (myGroupLinks || []).map(g => g.group_id);
              const myGroupTokens = myGroupIds.map(getGroupToken);
              if (myGroupTokens.length > 0) {
                await supabase.from('mensagens').delete().in('receiver_code', myGroupTokens);
                await supabase.from('pins').delete().in('room_key', myGroupTokens);
                await supabase.from('grupo_membros').delete().eq('member_code', myCode);
              }
              const { data: ownedGroups } = await supabase.from('grupos').select('id, photo_url').eq('created_by', myCode);
              const ownedGroupFiles = (ownedGroups || [])
                .map(g => g.photo_url)
                .filter(Boolean)
                .map(extractStoragePath)
                .filter(Boolean);
              if (ownedGroupFiles.length > 0) {
                await supabase.storage.from('chat-media').remove(ownedGroupFiles);
              }
              await supabase.from('grupos').delete().eq('created_by', myCode);

              toast("Mensagens e mídias limpas com sucesso!");
              fetchMyConversations();
            } catch (e) {
              console.error(e);
              toast("Erro ao limpar dados do servidor.", { tone: 'error' });
            } finally { setLoading(false); }
          }
        }
      ]
    );
  };

  // Carrega os canais fixados salvos na memória do celular
  const loadPinnedChats = async () => {
    try {
      const storageKey = getPinnedStorageKey(userCode);
      const legacyKey = `@pinned_${String(userCode || '').trim()}`;
      const [currentStored, legacyStored] = await Promise.all([
        AsyncStorage.getItem(storageKey),
        AsyncStorage.getItem(legacyKey)
      ]);
      const merged = normalizePinnedTokens([
        ...(currentStored ? JSON.parse(currentStored) : []),
        ...(legacyStored ? JSON.parse(legacyStored) : [])
      ]);
      if (merged.length > 0) {
        setPinnedTokens(merged);
      }
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
    if (newVal) toast('Segurança PIN ativada! Ao abrir o chat, você precisará configurar/digitar seu PIN de 3 dígitos. Cuidado: 3 erros = Limpeza Total (Modo Pânico).');
    else toast('Segurança PIN desativada.');
  };

  // 🚀 LÓGICA DE TESTE DO PROTOCOLO PÂNICO (Acionado segurando o cadeado)
  const handlePanicTest = async () => {
    toast('TESTE DO PÂNICO INICIADO: Aplicando protocolo de ofuscação...');
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

      const { data: myGroupLinks } = await supabase.from('grupo_membros').select('group_id').eq('member_code', myCleanCode);
      const myGroupIds = (myGroupLinks || []).map(g => g.group_id);
      const myGroupTokens = myGroupIds.map(getGroupToken);
      if (myGroupTokens.length > 0) {
        const { data: groupMsgs } = await supabase.from('mensagens')
          .select('media_url')
          .in('receiver_code', myGroupTokens);
        (groupMsgs || []).forEach(m => {
          if (m.media_url && !m.media_url.includes('giphy.com')) {
            const path = extractStoragePath(m.media_url);
            if (path) filesToDelete.push(path);
          }
        });
      }
      if (filesToDelete.length > 0) {
        const { error: groupStorageError } = await supabase.storage.from('chat-media').remove(filesToDelete);
        if (groupStorageError) console.error('Erro ao deletar midias de grupos:', groupStorageError);
      }

      // 2. Apaga definitivamente todas as mensagens (limpa o chat)
      await supabase.from('mensagens').delete().or(`sender_code.eq.${myCleanCode},receiver_code.eq.${myCleanCode}`);
      if (myGroupTokens.length > 0) {
        await supabase.from('mensagens').delete().in('receiver_code', myGroupTokens);
        await supabase.from('pins').delete().in('room_key', myGroupTokens);
        await supabase.from('grupo_membros').delete().eq('member_code', myCleanCode);
      }
      const { data: ownedGroups } = await supabase.from('grupos').select('id, photo_url').eq('created_by', myCleanCode);
      const ownedGroupFiles = (ownedGroups || [])
        .map(g => g.photo_url)
        .filter(Boolean)
        .map(extractStoragePath)
        .filter(Boolean);
      if (ownedGroupFiles.length > 0) {
        await supabase.storage.from('chat-media').remove(ownedGroupFiles);
      }
      await supabase.from('grupos').delete().eq('created_by', myCleanCode);

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

      toast('Teste concluído: Dados ofuscados com sucesso.');
      fetchMyConversations(); // Recarrega a lista (os canais continuarão visíveis, mas com as ofuscações)
    } catch (e) {
      console.error(e);
      toast('Erro ao executar o teste do pânico.', { tone: 'error' });
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
      toast('Notificações de Clima ATIVADAS.');
    } else {
      toast('Notificações de Clima DESATIVADAS.');
    }
  };

  const getMessagePreview = (lastMsg, prefix = '') => {
    if (!lastMsg) return 'Canal seguro estabelecido';
    if (lastMsg.media_url) {
      if (lastMsg.media_type?.includes('_spoiler')) return prefix + 'Midia com Spoiler';
      if (lastMsg.media_type === 'audio') return prefix + 'Audio';
      if (lastMsg.media_type === 'video') return prefix + 'Video';
      if (lastMsg.media_type === 'document') return prefix + 'Documento';
      if (lastMsg.media_type === 'sticker') return prefix + 'Sticker';
      return prefix + 'Foto';
    }
    return prefix + (lastMsg.content || '');
  };

  const pickGroupPhoto = async () => {
    try {
      setPickerActive?.(true);
      const res = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!res.granted) return toast('Permissao necessaria para acessar a galeria.');
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.75,
      });
      if (!result.canceled && result.assets?.[0]?.uri) {
        setNewGroupPhoto(result.assets[0].uri);
      }
    } catch (err) {
      console.error(err);
      toast('Erro ao escolher a foto do grupo.', { tone: 'error' });
    } finally {
      setPickerActive?.(false);
    }
  };

  const uploadGroupPhoto = async (uri, ownerCode) => {
    if (!uri) return null;
    const filename = `groups/${ownerCode}-${Date.now()}-${Math.floor(Math.random() * 1000)}.jpg`;
    try {
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const lookup = new Uint8Array(256);
      for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
      let bufferLength = base64.length * 0.75;
      if (base64[base64.length - 1] === '=') bufferLength--;
      if (base64[base64.length - 2] === '=') bufferLength--;
      const bytes = new Uint8Array(bufferLength);
      let p = 0;
      for (let i = 0; i < base64.length; i += 4) {
        const encoded1 = lookup[base64.charCodeAt(i)];
        const encoded2 = lookup[base64.charCodeAt(i + 1)];
        const encoded3 = lookup[base64.charCodeAt(i + 2)];
        const encoded4 = lookup[base64.charCodeAt(i + 3)];
        bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
        if (encoded3 !== 64) bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
        if (encoded4 !== 64) bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
      }

      const { error } = await supabase.storage.from('chat-media').upload(filename, bytes, {
        contentType: 'image/jpeg',
        upsert: false,
      });
      if (error) throw error;
      return `${SUPABASE_URL}/storage/v1/object/public/chat-media/${filename}`;
    } catch (err) {
      console.error('Erro ao enviar foto do grupo:', err);
      throw err;
    }
  };

  const toggleGroupContact = (token) => {
    setSelectedGroupContacts(prev => (
      prev.includes(token) ? prev.filter(t => t !== token) : [...prev, token]
    ));
  };

  const resetGroupForm = () => {
    setNewGroupName('');
    setNewGroupPhoto(null);
    setSelectedGroupContacts([]);
  };

  const handleCreateGroup = async () => {
    const myCode = userCode.trim().toLowerCase();
    const groupName = newGroupName.trim();
    if (!groupName) return toast('Escolha um nome para o grupo.');
    if (selectedGroupContacts.length === 0) return toast('Selecione pelo menos um contato.');

    setAdding(true);
    try {
      const photoUrl = await uploadGroupPhoto(newGroupPhoto, myCode);
      const { data: group, error: groupError } = await supabase
        .from('grupos')
        .insert([{ name: groupName, photo_url: photoUrl, created_by: myCode }])
        .select()
        .single();
      if (groupError) throw groupError;

      const members = Array.from(new Set([myCode, ...selectedGroupContacts])).map(memberCode => ({
        group_id: group.id,
        member_code: memberCode,
      }));
      const { error: membersError } = await supabase.from('grupo_membros').insert(members);
      if (membersError) throw membersError;

      resetGroupForm();
      setGroupModalVisible(false);
      fetchMyConversations();
      onOpenChat(getGroupToken(group.id), group.name);
    } catch (err) {
      console.error(err);
      toast('Erro ao criar grupo. Verifique o SQL do Supabase.', { tone: 'error' });
    } finally {
      setAdding(false);
    }
  };

  const fetchMyConversations = async () => {
    if (!userCode) return;
    const myCleanCode = userCode.trim().toLowerCase();
    const withTimeout = (promise, ms = 15000) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Tempo limite ao carregar canais')), ms)),
    ]);

    // 🚀 CACHE: Carrega histórico salvo na memória para acesso instantâneo/offline
    try {
      const cached = await AsyncStorage.getItem(`@cache_chats_${myCleanCode}`);
      if (cached) setChats(JSON.parse(cached));
    } catch (e) {}

    try {
      const { data: myConnections, error: connectionsError } = await withTimeout(supabase.from('conexoes').select('*').eq('user_code', myCleanCode));
      if (connectionsError) throw connectionsError;
      const { data: myGroupLinks, error: linksError } = await withTimeout(supabase.from('grupo_membros').select('group_id').eq('member_code', myCleanCode));
      if (linksError) throw linksError;
      const myGroupIds = (myGroupLinks || []).map(g => g.group_id);
      let myGroups = [];
      if (myGroupIds.length > 0) {
        const { data: groupRows, error: groupsError } = await withTimeout(supabase.from('grupos').select('*').in('id', myGroupIds));
        if (groupsError) throw groupsError;
        myGroups = groupRows || [];
      }
      const groupTokens = myGroupIds.map(getGroupToken);
      
      // 🚀 Extrai automaticamente os contatos fixados do banco de dados!
      const cloudPins = myConnections?.filter(c => c.is_pinned).map(c => normalizeToken(c.friend_code)) || [];
      // Os grupos não possuem coluna is_pinned. Preserve os fixados locais deles ao
      // sincronizar os contatos, em vez de apagá-los a cada atualização da lista.
      let localPins = [];
      try {
        const storageKey = getPinnedStorageKey(userCode);
        const legacyKey = `@pinned_${String(userCode || '').trim()}`;
        const [currentStored, legacyStored] = await Promise.all([
          AsyncStorage.getItem(storageKey),
          AsyncStorage.getItem(legacyKey)
        ]);
        localPins = [
          ...(currentStored ? JSON.parse(currentStored) : []),
          ...(legacyStored ? JSON.parse(legacyStored) : [])
        ];
      } catch (_) {}
      setPinnedTokens([...new Set([...cloudPins, ...normalizePinnedTokens(localPins)])]);

      // Busca todas as mensagens enviadas ou recebidas por você, ordenadas da mais nova para a mais velha
      const { data: allMessages, error: messagesError } = await withTimeout(supabase
        .from('mensagens')
        .select('sender_code, receiver_code, content, media_url, media_type, read_at, created_at')
        .or(`sender_code.eq.${myCleanCode},receiver_code.eq.${myCleanCode}`)
        .order('created_at', { ascending: false }));
      if (messagesError) throw messagesError;

      let groupMessages = [];
      if (groupTokens.length > 0) {
        const { data: groupMsgRows, error: groupMessagesError } = await withTimeout(supabase
          .from('mensagens')
          .select('sender_code, receiver_code, content, media_url, media_type, read_at, created_at')
          .in('receiver_code', groupTokens)
          .order('created_at', { ascending: false }));
        if (groupMessagesError) throw groupMessagesError;
        groupMessages = groupMsgRows || [];
      }

      const messages = [...(allMessages || []), ...groupMessages].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const incomingMessages = messages.filter(m => m.receiver_code.trim().toLowerCase() === myCleanCode);

      const allContacts = new Set();
      incomingMessages.forEach(m => allContacts.add(m.sender_code.trim().toLowerCase()));
      (myConnections || []).forEach(c => allContacts.add(c.friend_code.trim().toLowerCase()));

      let incomingProfiles = [];
      if (allContacts.size > 0) {
        const { data: profiles, error: profilesError } = await withTimeout(supabase.from('perfis').select('connection_code, nickname, last_seen').in('connection_code', Array.from(allContacts)));
        if (profilesError) throw profilesError;
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
        if (lastMsg.media_url) {
          if (lastMsg.media_type?.includes('_spoiler')) return prefix + '🤫 Mídia com Spoiler';
          if (lastMsg.media_type === 'audio') return prefix + '🎤 Áudio';
          if (lastMsg.media_type === 'video') return prefix + '📹 Vídeo';
          if (lastMsg.media_type === 'document') return prefix + '📄 Documento';
          if (lastMsg.media_type === 'sticker') return prefix + '🎉 Sticker';
          return prefix + '📷 Foto';
        }
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
          lastActivity: messages.find(m =>
            (m.sender_code.trim().toLowerCase() === myCleanCode && m.receiver_code.trim().toLowerCase() === cleanKey) ||
            (m.sender_code.trim().toLowerCase() === cleanKey && m.receiver_code.trim().toLowerCase() === myCleanCode)
          )?.created_at || null,
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
            lastActivity: messages.find(m =>
              (m.sender_code.trim().toLowerCase() === myCleanCode && m.receiver_code.trim().toLowerCase() === cleanKey) ||
              (m.sender_code.trim().toLowerCase() === cleanKey && m.receiver_code.trim().toLowerCase() === myCleanCode)
            )?.created_at || null,
            isConnection: false,
            unread: unreadCount
          });
        }
      });

      myGroups.forEach(group => {
        const groupToken = getGroupToken(group.id);
        const groupMsgs = messages.filter(m => m.receiver_code?.trim?.().toLowerCase() === groupToken);
        const lastMsg = groupMsgs[0];
        const prefix = lastMsg?.sender_code?.trim?.().toLowerCase() === myCleanCode ? 'Voce: ' : '';
        conversationMap.set(groupToken, {
          id: group.id,
          token: groupToken,
          name: group.name,
          photoUrl: group.photo_url,
          createdBy: group.created_by,
          lastMessage: getMessagePreview(lastMsg, prefix),
          lastActivity: lastMsg?.created_at || null,
          isConnection: false,
          isGroup: true,
          unread: groupMsgs.filter(m => m.sender_code?.trim?.().toLowerCase() !== myCleanCode && m.read_at === null).length
        });
      });

      const finalChats = Array.from(conversationMap.values());
      setChats(finalChats);
      setLoadError(false);
      
      // Atualiza o cache silenciosamente
      AsyncStorage.setItem(`@cache_chats_${myCleanCode}`, JSON.stringify(finalChats)).catch(() => {});
    } catch (err) {
      console.error('Erro ao carregar canais:', err);
      setLoadError(true);
    } finally { setLoading(false); }
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

    const channelGroups = supabase
      .channel(`chat-list-groups-${cleanUserCode}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'grupo_membros', filter: `member_code=eq.${cleanUserCode}` }, () => {
        fetchMyConversations();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'grupos' }, () => {
        fetchMyConversations();
      })
      .subscribe();

    const groupPoll = setInterval(fetchMyConversations, 5000);
      
    return () => { 
      clearInterval(groupPoll);
      supabase.removeChannel(channelIncoming); 
      supabase.removeChannel(channelOutgoing); 
      supabase.removeChannel(channelGroups);
    };
  }, [userCode]);

  // 🚀 FUNÇÃO: Fixa ou desafixa o chat jogando as flags para a ordenação
  const handleTogglePinChat = async (token) => {
    const normalizedToken = normalizeToken(token);
    const isCurrentlyPinned = pinnedTokens.some(pin => normalizeToken(pin) === normalizedToken);
    const newVal = !isCurrentlyPinned;

    let updatedPins = normalizePinnedTokens(pinnedTokens);
    if (isCurrentlyPinned) {
      updatedPins = updatedPins.filter(t => t !== normalizedToken);
    } else {
      updatedPins.push(normalizedToken);
    }
    setPinnedTokens(updatedPins);
    await AsyncStorage.setItem(getPinnedStorageKey(userCode), JSON.stringify(updatedPins));
    setOptionsModalVisible(false);

    // 🚀 Salva a preferência direto no banco de dados na nuvem
    if (!isGroupToken(token)) {
      await supabase.from('conexoes').update({ is_pinned: newVal }).eq('user_code', userCode.trim().toLowerCase()).eq('friend_code', normalizedToken);
    }
  };

  const handleTokenChange = (text) => {
    const clean = text.replace(/[^a-zA-Z0-9]/g, '');
    if (clean.length > 4) setNewFriendCode(`${clean.slice(0, 4)}-${clean.slice(4, 8)}`);
    else setNewFriendCode(clean);
  };

  const handleAddFriend = async () => {
    if (newFriendCode.trim() === '' || newFriendName.trim() === '') return toast('Preencha os dados.');
    const formattedToken = newFriendCode.trim().toLowerCase();
    if (formattedToken === userCode.trim().toLowerCase()) return toast('Operação inválida.');

    setAdding(true);
    try {
      const { data: profileCheck } = await supabase.from('perfis').select('nickname').eq('connection_code', formattedToken).single();
      if (!profileCheck) { toast('Terminal não encontrado.'); setAdding(false); return; }

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
              toast("Histórico global apagado com sucesso.");
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

                if (isGroupToken(friendCode)) {
                  const groupId = friendCode.replace(GROUP_PREFIX, '');
                  await supabase.from('grupo_membros').delete().match({ group_id: groupId, member_code: myCode });
                  await supabase.from('pins').delete().eq('room_key', friendCode);
                  if (chatOptionTarget.createdBy === myCode) {
                    if (chatOptionTarget.photoUrl) {
                      const photoPath = extractStoragePath(chatOptionTarget.photoUrl);
                      if (photoPath) await supabase.storage.from('chat-media').remove([photoPath]);
                    }
                    await supabase.from('mensagens').delete().eq('receiver_code', friendCode);
                    await supabase.from('grupos').delete().eq('id', groupId);
                  }
                  setChatOptionTarget(null);
                  fetchMyConversations();
                  return;
                }
                // ─── Remove a conexão APENAS na sua direção ───
                const { error: conn1 } = await supabase.from('conexoes').delete().match({ user_code: myCode, friend_code: friendCode });
                if (conn1) console.error('Erro conexão dir. 1:', conn1);

                // ─── 5. Limpa o pin local se existia ───
                if (pinnedTokens.some(pin => normalizeToken(pin) === normalizeToken(friendCode))) {
                  const updatedPins = normalizePinnedTokens(pinnedTokens).filter(t => t !== normalizeToken(friendCode));
                  setPinnedTokens(updatedPins);
                  await AsyncStorage.setItem(getPinnedStorageKey(userCode), JSON.stringify(updatedPins));
                }

                setChatOptionTarget(null);
                fetchMyConversations();
              } catch (err) { console.error(err); toast("Erro ao excluir canal.", { tone: 'error' }); } finally { setAdding(false); }
            }
          }
        ]
      );
    }, 300);
  };

  // 🚀 LÓGICA DE COMPOSIÇÃO: Fixados sempre ficam acima e os demais seguem por atividade recente
  const normalizedPinnedTokens = new Set(normalizePinnedTokens(pinnedTokens));
  const pinnedChats = [];
  const regularChats = [];

  chats.forEach((chat) => {
    const item = { ...chat, isPinned: normalizedPinnedTokens.has(normalizeToken(chat.token)) };
    if (item.isPinned) {
      pinnedChats.push(item);
    } else {
      regularChats.push(item);
    }
  });

  pinnedChats.sort((a, b) => {
    const activityDiff = new Date(b.lastActivity || 0).getTime() - new Date(a.lastActivity || 0).getTime();
    if (activityDiff !== 0) return activityDiff;
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
  });
  regularChats.sort((a, b) => {
    const activityDiff = new Date(b.lastActivity || 0).getTime() - new Date(a.lastActivity || 0).getTime();
    if (activityDiff !== 0) return activityDiff;
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
  });

  const processedChats = [...pinnedChats, ...regularChats];
  const groupContactOptions = chats.filter(c => !isGroupToken(c.token));

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
              <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => { Clipboard.setStringAsync(userCode); toast('Token copiado!'); }} style={{ marginLeft: 8 }}>
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
      ) : loadError ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>Nao foi possivel carregar os canais.</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => { setLoading(true); fetchMyConversations(); }}>
            <Text style={styles.retryButtonText}>Tentar novamente</Text>
          </TouchableOpacity>
        </View>
      ) : processedChats.length === 0 ? (
        <View style={styles.emptyContainer}><Text style={styles.emptyText}>Nenhum canal ativo.</Text></View>
      ) : (
        <FlatList
          data={processedChats}
          keyExtractor={(item) => item.token}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 100 }}
          onRefresh={() => { setLoading(true); fetchMyConversations(); }}
          refreshing={false}
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
                {item.photoUrl ? (
                  <Image source={{ uri: item.photoUrl }} style={styles.avatarImage} />
                ) : (
                  <Ionicons name={item.isPinned ? "pin" : (item.isGroup ? "people-outline" : "person-outline")} size={20} color="#00ff66" style={item.isPinned && { transform: [{ rotate: '45deg' }] }} />
                )}
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

      <TouchableOpacity
        style={styles.groupFab}
        onPress={() => setGroupModalVisible(true)}
      >
        <Ionicons name="add" size={30} color="#000" />
      </TouchableOpacity>

      <Modal animationType="fade" transparent visible={groupModalVisible} onRequestClose={() => setGroupModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '85%' }]}>
            <Text style={styles.modalTitle}>Criar Grupo</Text>

            <TouchableOpacity style={styles.groupPhotoButton} onPress={pickGroupPhoto}>
              {newGroupPhoto ? (
                <Image source={{ uri: newGroupPhoto }} style={styles.groupPhotoPreview} />
              ) : (
                <Ionicons name="camera-outline" size={28} color="#00ff66" />
              )}
            </TouchableOpacity>

            <TextInput
              style={styles.modalInput}
              placeholder="Nome do grupo"
              placeholderTextColor="#475569"
              value={newGroupName}
              onChangeText={setNewGroupName}
            />

            <Text style={styles.groupSectionLabel}>Contatos</Text>
            {groupContactOptions.length === 0 ? (
              <Text style={styles.emptyGroupText}>Adicione um contato antes de criar um grupo.</Text>
            ) : (
              <ScrollView style={styles.groupContactsList} showsVerticalScrollIndicator={false}>
                {groupContactOptions.map(contact => {
                  const selected = selectedGroupContacts.includes(contact.token);
                  return (
                    <TouchableOpacity key={contact.token} style={styles.groupContactRow} onPress={() => toggleGroupContact(contact.token)}>
                      <Ionicons name={selected ? "checkbox" : "square-outline"} size={22} color={selected ? "#00ff66" : "#64748B"} />
                      <View style={{ flex: 1, marginLeft: 10 }}>
                        <Text style={styles.groupContactName}>{contact.name}</Text>
                        <Text style={styles.groupContactToken}>{contact.token}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            <View style={styles.modalButtons}>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#152233' }]} onPress={() => { resetGroupForm(); setGroupModalVisible(false); }}>
                <Text style={{ color: '#fff' }}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#00ff66', opacity: adding ? 0.7 : 1 }]} onPress={handleCreateGroup} disabled={adding}>
                <Text style={{ color: '#000', fontWeight: 'bold' }}>{adding ? 'Criando...' : 'Criar'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>


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
              <Text style={{ color: '#fff', fontSize: 15 }}>{pinnedTokens.some(pin => normalizeToken(pin) === normalizeToken(chatOptionTarget?.token)) ? "Desafixar do Topo" : "Fixar no Topo"}</Text>
            </TouchableOpacity>

            {!isGroupToken(chatOptionTarget?.token) && (
              <TouchableOpacity style={styles.optionRowItem} onPress={() => { setOptionsModalVisible(false); setSelectedChat(chatOptionTarget); setEditedName(chatOptionTarget.name); setEditModalVisible(true); }}>
                <Ionicons name="create-outline" size={18} color="#fff" style={{ marginRight: 12 }} />
                <Text style={{ color: '#fff', fontSize: 15 }}>Editar Nome do Contato</Text>
              </TouchableOpacity>
            )}
            
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
  groupFab: { position: 'absolute', bottom: 30, left: 30, backgroundColor: '#00ff66', width: 56, height: 56, borderRadius: 28, justifyContent: 'center', alignItems: 'center' },
  avatarImage: { width: 44, height: 44, borderRadius: 22 },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { color: '#475569', fontSize: 14 },
  retryButton: { marginTop: 14, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 12, backgroundColor: '#00ff66' },
  retryButtonText: { color: '#000', fontWeight: 'bold' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalContent: { backgroundColor: '#0d0d0d', borderRadius: 24, padding: 25, borderWidth: 1, borderColor: '#1F2937', width: '100%', maxWidth: 340 },
  modalTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 20, textAlign: 'center' },
  modalInput: { backgroundColor: '#111827', color: '#fff', padding: 14, borderRadius: 12, fontSize: 16, borderWidth: 1, borderColor: '#1F2937', marginBottom: 15, width: '100%' },
  modalButtons: { flexDirection: 'row', justifyContent: 'space-between' },
  modalBtn: { flex: 1, padding: 14, borderRadius: 12, alignItems: 'center', marginHorizontal: 6 },
  groupPhotoButton: { width: 78, height: 78, borderRadius: 39, backgroundColor: '#111827', borderWidth: 1, borderColor: '#1F2937', justifyContent: 'center', alignItems: 'center', alignSelf: 'center', marginBottom: 16, overflow: 'hidden' },
  groupPhotoPreview: { width: 78, height: 78, borderRadius: 39 },
  groupSectionLabel: { color: '#64748B', fontSize: 12, textTransform: 'uppercase', fontWeight: 'bold', marginBottom: 8 },
  emptyGroupText: { color: '#64748B', fontSize: 13, textAlign: 'center', marginBottom: 16 },
  groupContactsList: { maxHeight: 220, marginBottom: 16 },
  groupContactRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderColor: '#111827' },
  groupContactName: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  groupContactToken: { color: '#64748B', fontSize: 12, marginTop: 2 },
  optionRowItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderColor: '#111827' }
});


