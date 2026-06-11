import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity,
  SafeAreaView, ActivityIndicator, KeyboardAvoidingView, Platform, Linking,
  StatusBar, Modal, Image, Animated, PanResponder, useWindowDimensions, ScrollView
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { Video, ResizeMode } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
// import { OneSignal } from 'react-native-onesignal';
import { supabase } from '../supabase';
import { sendWeatherNotification } from './notificationService';

const SUPABASE_URL = 'https://rzmhvinmavwgtglrhqmf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6bWh2aW5tYXZ3Z3RnbHJocW1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwNTA0NTcsImV4cCI6MjA5NjYyNjQ1N30.Yp6w81vNORd7sKguYV7x6kl476KJoMbl5es1GdwjpLc';

// 🚀 Sincronizador Global de Tempo (Proteção contra hora errada no celular)
let globalTimeOffset = 0;
let isTimeSynced = false;

const syncTimeWithServer = async () => {
  if (isTimeSynced) return;
  try {
    const start = Date.now();
    // Pede apenas o cabeçalho do servidor para não consumir banda de download
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, { method: 'HEAD' });
    const dateHeader = res.headers.get('date');
    if (dateHeader) {
      const serverTime = new Date(dateHeader).getTime();
      const latency = (Date.now() - start) / 2; // Desconta o atraso da internet
      globalTimeOffset = serverTime - Date.now() + latency;
      isTimeSynced = true;
    }
  } catch (e) { console.warn('Falha na sincronização de tempo', e); }
};
const getSyncedTime = () => Date.now() + globalTimeOffset;

const SwipeableMessage = ({ children, onReply }) => {
  const pan = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(
    PanResponder.create({
      // 🚀 TRAVA RIGOROSA: Ignora qualquer arraste se o dedo se mover na vertical (rolagem de tela)
      onMoveShouldSetPanResponder: (_, gestureState) => gestureState.dx > 25 && Math.abs(gestureState.dy) < 15,
      onPanResponderMove: (_, gestureState) => { 
        // Efeito de fricção (elástico): a mensagem move menos que o dedo, exigindo intenção real
        if (gestureState.dx > 0) pan.setValue(gestureState.dx * 0.45); 
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dx > 70) onReply();
        // Volta rápida e fluida (efeito mola)
        Animated.spring(pan, { toValue: 0, friction: 6, tension: 40, useNativeDriver: true }).start();
      }
    })
  ).current;

  return (
    <View style={styles.swipeContainer}>
      <Animated.View style={[styles.replyIconLeft, { 
        opacity: pan.interpolate({ inputRange: [0, 15], outputRange: [0, 1], extrapolate: 'clamp' }),
        transform: [{ scale: pan.interpolate({ inputRange: [0, 25], outputRange: [0.3, 1], extrapolate: 'clamp' }) }]
      }]}>
        <View style={{ backgroundColor: 'rgba(0,255,102,0.15)', padding: 6, borderRadius: 20 }}>
          <Ionicons name="arrow-undo" size={14} color="#00ff66" />
        </View>
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX: pan }], width: '100%' }} {...panResponder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
};

export default function ChatRoomScreen({ onBack, userCode, friendCode, friendName, setPickerActive }) {
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const inputTextRef = useRef(''); // 🚀 Captura instantânea do texto para evitar perda de palavras
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  const [currentFriendName, setCurrentFriendName] = useState(friendName);
  const [topMenuVisible, setTopMenuVisible] = useState(false);
  const [attachMenuVisible, setAttachMenuVisible] = useState(false);
  const [editNameVisible, setEditNameVisible] = useState(false);
  const [newNameInput, setNewNameInput] = useState(friendName);
  const [replyingTo, setReplyingTo] = useState(null);
  const [fullscreenImage, setFullscreenImage] = useState(null);
  const [fullscreenVideo, setFullscreenVideo] = useState(null);

  const [isFriendTyping, setIsFriendTyping] = useState(false);
  const [reactionTargetMessage, setReactionTargetMessage] = useState(null);
  const [showCustomEmojiInput, setShowCustomEmojiInput] = useState(false);
  const [infoModalMessage, setInfoModalMessage] = useState(null);
  const [mediaGalleryVisible, setMediaGalleryVisible] = useState(false);
  const [showBlueTicks, setShowBlueTicks] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const [pendingQueue, setPendingQueue] = useState([]);
  const pendingQueueRef = useRef(pendingQueue);
  pendingQueueRef.current = pendingQueue;
  const lastMessageTimeRef = useRef(Date.now());

  const shortTimer = useRef(null);
  const longTimer = useRef(null);
  const hasTriggeredShort = useRef(false);
  const hasTriggeredLong = useRef(false);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const isScrolling = useRef(false);

  const flatListRef = useRef();
  const channelRef = useRef(null);
  const { width: SCREEN_WIDTH } = useWindowDimensions();
  const IMAGE_SIZE = Math.min(SCREEN_WIDTH * 0.65, 320);

  useEffect(() => {
    syncTimeWithServer(); // Inicia a sincronização assim que abre a tela
    const initializeChatState = async () => {
      try {
        const savedDraft = await AsyncStorage.getItem(`@draft_${userCode}_${friendCode}`);
        if (savedDraft) {
          setInputText(savedDraft);
          inputTextRef.current = savedDraft; // 🚀 Sincroniza a referência
        }

        const storedQueue = await AsyncStorage.getItem(`@queue_${userCode}_${friendCode}`);
        if (storedQueue) setPendingQueue(JSON.parse(storedQueue));

        const devMode = await AsyncStorage.getItem('@dev_mode');
        setShowBlueTicks(devMode === 'true');
      } catch (e) { console.error(e); }
    };
    initializeChatState();
  }, [userCode, friendCode]);

  useEffect(() => {
    const persistQueue = async () => {
      try {
        await AsyncStorage.setItem(`@queue_${userCode}_${friendCode}`, JSON.stringify(pendingQueue));
      } catch (e) { console.error(e); }
    };
    persistQueue();
  }, [pendingQueue]);

  useEffect(() => {
    let isProcessingQueue = false;
    const processingIds = new Set();

    const queueWorker = async () => {
      if (isProcessingQueue) return;
      isProcessingQueue = true;

      const currentQueue = pendingQueueRef.current || [];
      // Inverte para processar da mensagem mais velha para a mais nova
      const reversedQueue = [...currentQueue].reverse();

      for (const message of reversedQueue) {
        if (!processingIds.has(message.id)) {
          processingIds.add(message.id);
          try {
            // 🚀 FEEDBACK VISUAL: Se estava falha e a net voltar, o app muda pro reloginho sozinho
            if (message.status === 'failed') {
              setPendingQueue(prev => prev.map(m => m.id === message.id ? { ...m, status: 'sending' } : m));
            }

            const insertPromise = supabase.from('mensagens').insert([{
              sender_code: message.sender_code,
              receiver_code: message.receiver_code,
              content: message.content,
              reply_to_id: message.reply_to_id,
              created_at: message.created_at
            }]).select().single();

            // 🚀 TIMEOUT DE 15 SEGS: Impede que a fila trave para sempre se a internet cair silenciosamente
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout de rede')), 15000));
            
            const { data, error } = await Promise.race([insertPromise, timeoutPromise]);
            if (error) throw error;
            
            // 🚀 SUCESSO ABSOLUTO! Remove da fila e transfere para a tela de chat na hora
            setPendingQueue(prev => prev.filter(m => m.id !== message.id));
            setMessages(prev => {
              if (prev.some(m => m.id === data.id)) return prev;
              const updated = [data, ...prev].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
              AsyncStorage.setItem(`@cache_msgs_${userCode}_${friendCode}`, JSON.stringify(updated.slice(0, 60))).catch(() => {});
              return updated;
            });

            // 🚀 Aciona notificação somente quando a mensagem realmente chegar ao servidor
            sendWeatherNotification(userCode, friendCode);
          } catch (err) {
            processingIds.delete(message.id);
            // Muda para falha apenas se já não estiver marcado como falha (evita piscar a tela)
            if (message.status !== 'failed') {
              setPendingQueue(prev => prev.map(m => m.id === message.id ? { ...m, status: 'failed' } : m));
            }
            // Aborta para manter a ordem cronológica estrita
            break; 
          }
        } else {
          // Trava a fila se a mensagem atual ainda está aguardando confirmação do servidor
          break;
        }
      }

      isProcessingQueue = false;

      // Limpeza de memória
      const currentIds = new Set((pendingQueueRef.current || []).map(m => m.id));
      for (const id of processingIds) {
        if (!currentIds.has(id)) processingIds.delete(id);
      }
    };

    const intervalId = setInterval(queueWorker, 1000);
    queueWorker(); 

    return () => {
      clearInterval(intervalId);
      processingIds.clear();
    };
  }, []);

  useEffect(() => {
    const fetchMessages = async () => {
      // 🚀 CACHE: Carrega mensagens da memória para não deixar a tela vazia sem internet
      try {
        const cached = await AsyncStorage.getItem(`@cache_msgs_${userCode}_${friendCode}`);
        if (cached) setMessages(JSON.parse(cached));
      } catch (e) {}

      try {
        const clearedStr = await AsyncStorage.getItem(`@cleared_${userCode}_${friendCode}`);
        const clearedTime = clearedStr ? new Date(clearedStr).getTime() : 0;

        const { data, error } = await supabase
          .from('mensagens')
          .select('*')
          .or(`and(sender_code.eq.${userCode},receiver_code.eq.${friendCode}),and(sender_code.eq.${friendCode},receiver_code.eq.${userCode})`)
          .order('created_at', { ascending: false });

        if (!error) {
          const filteredData = (data || []).filter(m => new Date(m.created_at).getTime() > clearedTime);
          setMessages(filteredData);
          AsyncStorage.setItem(`@cache_msgs_${userCode}_${friendCode}`, JSON.stringify(filteredData.slice(0, 60))).catch(() => {});
          marcarComoLidas();
        }
      } catch (err) { console.error(err); } finally { setLoading(false); }
    };

    fetchMessages();

    const subscription = supabase
      .channel(`room-${userCode}-${friendCode}`, { config: { broadcast: { ack: true } } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mensagens' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const newMsg = payload.new;
          if ((newMsg.sender_code === userCode && newMsg.receiver_code === friendCode) || (newMsg.sender_code === friendCode && newMsg.receiver_code === userCode)) {
            setMessages((prev) => {
              if (prev.some(m => m.id === newMsg.id)) return prev;
              const updated = [newMsg, ...prev];
              const finalSorted = updated.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
              AsyncStorage.setItem(`@cache_msgs_${userCode}_${friendCode}`, JSON.stringify(finalSorted.slice(0, 60))).catch(() => {});
              return finalSorted;
            });
            if (newMsg.sender_code === userCode) {
              setPendingQueue(prev => {
                const matchIndex = prev.findIndex(m => new Date(m.created_at).getTime() === new Date(newMsg.created_at).getTime());
                if (matchIndex > -1) {
                  const newQueue = [...prev];
                  newQueue.splice(matchIndex, 1);
                  return newQueue;
                }
                return prev;
              });
            }
            if (newMsg.receiver_code === userCode) marcarComoLidas();
          }
        }
        if (payload.eventType === 'DELETE') {
          setMessages((prev) => prev.filter((msg) => msg.id !== payload.old.id));
        }
        if (payload.eventType === 'UPDATE') {
          setMessages((prev) => prev.map((msg) => (msg.id === payload.new.id ? payload.new : msg)));
        }
      })
      .on('broadcast', { event: 'typing' }, (payload) => {
        if (payload.payload.sender === friendCode) {
          setIsFriendTyping(payload.payload.isTyping);
        }
      })
      .subscribe();

    channelRef.current = subscription;
    return () => supabase.removeChannel(subscription);
  }, [userCode, friendCode]);

  const marcarComoLidas = async () => {
    await supabase.from('mensagens').update({ read_at: new Date(getSyncedTime()).toISOString() }).eq('sender_code', friendCode).eq('receiver_code', userCode).is('read_at', null);
    // Limpa a notificação da gaveta do celular assim que a pessoa entra no chat
    // OneSignal.Notifications.clearAll();
  };

  const handleTextChange = (text) => {
    inputTextRef.current = text; // 🚀 Salva imediatamente na memória absoluta
    setInputText(text);
    
    // 🚀 Removemos o 'await' para não engasgar o teclado ao digitar rápido
    AsyncStorage.setItem(`@draft_${userCode}_${friendCode}`, text).catch(() => {});

    channelRef.current?.send({
      type: 'broadcast',
      event: 'typing',
      payload: { sender: userCode, isTyping: text.trim().length > 0 }
    });
  };

  const handleSendMessage = async () => {
    const currentText = inputTextRef.current; // 🚀 Lê da referência (garante a última palavra)
    if (currentText.trim() === '') return;
    
    const messageContent = currentText.trim();
    const currentReplyId = replyingTo ? replyingTo.id : null;
    
    inputTextRef.current = '';
    setInputText('');
    setReplyingTo(null);

    try {
      await AsyncStorage.removeItem(`@draft_${userCode}_${friendCode}`);
    } catch (e) { console.error(e); }

    channelRef.current?.send({ type: 'broadcast', event: 'typing', payload: { sender: userCode, isTyping: false } });

    let newTime = getSyncedTime();
    if (newTime <= lastMessageTimeRef.current) {
      newTime = lastMessageTimeRef.current + 1;
    }
    lastMessageTimeRef.current = newTime;

    const newPendingMessage = {
      id: `pending-${newTime}-${Math.random()}`,
      content: messageContent,
      sender_code: userCode,
      receiver_code: friendCode,
      reply_to_id: currentReplyId,
      created_at: new Date(newTime).toISOString(),
      status: 'sending'
    };

    setPendingQueue(prev => [newPendingMessage, ...prev]);
  };

  const forceManualRetry = (msgId) => {
    setPendingQueue(prev => prev.map(m => m.id === msgId ? { ...m, status: 'sending' } : m));
  };

  const handleDeleteMessage = async (messageId) => {
    try {
      await supabase.from('mensagens').delete().eq('id', messageId);
      setInfoModalMessage(null);
    } catch (err) { console.error(err); }
  };

  const getMessageLifetime = (createdAt) => {
    const creationDate = new Date(createdAt);
    const expirationDate = new Date(creationDate.getTime() + 7 * 24 * 60 * 60 * 1000);
    const now = new Date(getSyncedTime()); // Usa a hora sincronizada no timer de destruição
    const diffMs = expirationDate - now;

    if (diffMs <= 0) return { exato: creationDate.toLocaleString('pt-BR'), restante: "Expirando..." };

    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    return {
      exato: creationDate.toLocaleString('pt-BR'),
      restante: `${diffDays}d ${diffHours}h ${diffMins}min`
    };
  };

  const handleReactToMessage = async (messageId, emoji) => {
    try {
      const msgTarget = messages.find(m => m.id === messageId);
      const reacoesAtuais = msgTarget.reacoes || {};
      const novasReacoes = { ...reacoesAtuais, [userCode]: emoji };
      await supabase.from('mensagens').update({ reacoes: novasReacoes }).eq('id', messageId);
      setReactionTargetMessage(null);
    } catch (err) { console.error(err); }
  };

  const handleRemoveReaction = async (messageId) => {
    try {
      const msgTarget = messages.find(m => m.id === messageId);
      if (!msgTarget || !msgTarget.reacoes || !msgTarget.reacoes[userCode]) return;
      const reacoesAtuais = { ...msgTarget.reacoes };
      delete reacoesAtuais[userCode];
      await supabase.from('mensagens').update({ reacoes: reacoesAtuais }).eq('id', messageId);
    } catch (err) { console.error(err); }
  };

  const handleUploadAndSendMedia = async (uri, mediaType) => {
    const tempTime = getSyncedTime();
    const tempId = `temp-${tempTime}`;
    try {
      setUploading(true);
      setMessages((prev) => [{ id: tempId, sender_code: userCode, receiver_code: friendCode, content: 'Enviando...', media_url: uri, media_type: mediaType, created_at: new Date(tempTime).toISOString(), is_uploading: true }, ...prev]);

      const ext = mediaType === 'video' ? 'mp4' : 'jpg';
      const filename = `${userCode}-${tempTime}.${ext}`;
      const mimeType = mediaType === 'video' ? 'video/mp4' : 'image/jpeg';

      const formData = new FormData();
      formData.append('file', {
        uri: uri,
        name: filename,
        type: mimeType,
      });

      const { error: uploadError } = await supabase.storage.from('chat-media').upload(filename, formData);
      if (uploadError) throw uploadError;

      const mediaUrl = `${SUPABASE_URL}/storage/v1/object/public/chat-media/${filename}`;
      await supabase.from('mensagens').insert([{ sender_code: userCode, receiver_code: friendCode, content: mediaType === 'video' ? '📹 Vídeo enviado' : '📩 Arquivo de mídia enviado', media_url: mediaUrl, media_type: mediaType, reply_to_id: replyingTo?.id }]);

      setMessages((prev) => prev.filter(msg => msg.id !== tempId));
      
      sendWeatherNotification(userCode, friendCode);
      setReplyingTo(null);
    } catch (err) { 
      setMessages((prev) => prev.filter(msg => msg.id !== tempId));
      alert(`Falha no envio. O servidor de mídias pode estar cheio. Considere fazer uma limpeza de armazenamento.\n\nErro: ${err.message}`); 
    } finally { setUploading(false); }
  };

  const handleDownloadMedia = async (url) => {
    try {
      if (setPickerActive) setPickerActive(true); // Previne o lock da tela ao abrir o modal de permissão nativo
      const { status } = await MediaLibrary.requestPermissionsAsync(true);
      if (status !== 'granted') {
        if (setPickerActive) setPickerActive(false);
        return alert('Permissão necessária para salvar na galeria.');
      }
      
      // Remove query params e garante que exista uma extensão de arquivo válida
      const rawFilename = url.split('/').pop().split('?')[0];
      const filename = rawFilename.includes('.') ? rawFilename : `${rawFilename}.jpg`;
      const fileUri = `${FileSystem.documentDirectory}${filename}`;
      
      const downloadRes = await FileSystem.downloadAsync(url, fileUri);
      await MediaLibrary.saveToLibraryAsync(downloadRes.uri);
      
      if (setPickerActive) setPickerActive(false);
      alert('Mídia salva na galeria com sucesso!');
    } catch (err) {
      if (setPickerActive) setPickerActive(false);
      console.error(err);
      alert('Erro ao salvar o arquivo: ' + err.message);
    }
  };

  const handleSelectMedia = async (type) => {
    setAttachMenuVisible(false);
    try {
      if (setPickerActive) setPickerActive(true); // Ativa ANTES de pedir as permissões!
      
      const resPhoto = await ImagePicker.requestMediaLibraryPermissionsAsync();
      const resCam = await ImagePicker.requestCameraPermissionsAsync();
      if (!resPhoto.granted || !resCam.granted) {
        if (setPickerActive) setPickerActive(false);
        return alert('Permissões necessárias.');
      }

      let result = null;
      if (type === 'camera_photo') {
        result = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: false });
      } else if (type === 'camera_video') {
        result = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Videos, allowsEditing: false });
      } else if (type === 'gallery') {
        result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.All, allowsMultipleSelection: false });
      }

      if (setPickerActive) setPickerActive(false);

      if (result && !result.canceled && result.assets && result.assets[0].uri) {
          await handleUploadAndSendMedia(result.assets[0].uri, result.assets[0].type || 'image');
      }
    } catch (err) { 
      if (setPickerActive) setPickerActive(false);
      console.error(err); 
    }
  };

  const handleUpdateFriendName = async () => {
    if (newNameInput.trim() === '') return;
    try {
      const myCleanCode = userCode.trim().toLowerCase();
      const friendCleanCode = friendCode.trim().toLowerCase();
      const { data: checkConn } = await supabase.from('conexoes').select('id').eq('user_code', myCleanCode).eq('friend_code', friendCleanCode).maybeSingle();

      if (checkConn) {
        await supabase.from('conexoes').update({ friend_name: newNameInput.trim() }).eq('id', checkConn.id);
      } else {
        await supabase.from('conexoes').insert([{ user_code: myCleanCode, friend_code: friendCleanCode, friend_name: newNameInput.trim() }]);
      }
      setCurrentFriendName(newNameInput.trim());
      setEditNameVisible(false);
    } catch (err) { console.error(err); }
  };

  const handleClearChat = async () => {
    try {
      // Extrai o nome dos arquivos (fotos/vídeos) e os apaga do balde de armazenamento
      const mediaMessages = messages.filter(m => m.media_url);
      if (mediaMessages.length > 0) {
        const filesToDelete = mediaMessages.map(m => m.media_url.split('/').pop());
        await supabase.storage.from('chat-media').remove(filesToDelete);
      }
      
      // Deleta definitivamente as mensagens do banco de dados (para os dois usuários)
      await supabase.from('mensagens').delete().match({ sender_code: userCode, receiver_code: friendCode });
      await supabase.from('mensagens').delete().match({ sender_code: friendCode, receiver_code: userCode });
      setMessages([]);
      AsyncStorage.removeItem(`@cache_msgs_${userCode}_${friendCode}`).catch(() => {});
      setTopMenuVisible(false);
    } catch (err) { console.error(err); }
  };

  // Função que converte as URLs dentro do texto em Links azuis clicáveis
  const renderMessageText = (text, isFailed, isEmojiOnly) => {
    if (!text) return null;
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = text.split(urlRegex);
    
    return (
      <Text style={[styles.messageText, isFailed && { color: '#94a3b8' }, isEmojiOnly && { fontSize: 50, lineHeight: 60, textAlign: 'center' }]}>
        {parts.map((part, index) => {
          if (part.match(urlRegex)) {
            return (
              <Text key={index} style={{ color: '#00bfff', textDecorationLine: 'underline' }} onPress={() => Linking.openURL(part).catch(() => alert('Não foi possível abrir o link.'))}>
                {part}
              </Text>
            );
          }
          return <Text key={index}>{part}</Text>;
        })}
      </Text>
    );
  };

  const handleScroll = (event) => {
    const yOffset = event.nativeEvent.contentOffset.y;
    setShowScrollToBottom(yOffset > 250);
  };

  const renderItem = ({ item }) => {
    const isMyMessage = item.sender_code === userCode;
    const timeString = new Date(item.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const quotedMsg = item.reply_to_id ? messages.find(m => m.id === item.reply_to_id) : null;
    const rList = item.reacoes ? Object.values(item.reacoes).filter(Boolean) : [];

    // 🚀 LÓGICA WHATSAPP: Verifica se a mensagem contém APENAS emojis (1 a 3 emojis no máximo)
    let isEmojiOnly = false;
    if (!item.media_url && item.content && !quotedMsg) {
      const cleanText = item.content.replace(/[\s\n]/g, '');
      if (cleanText.length > 0 && cleanText.length <= 25) {
        const isAllEmoji = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D]+$/u.test(cleanText);
        const emojiCount = (cleanText.match(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu) || []).length;
        if (isAllEmoji && emojiCount > 0 && emojiCount <= 3) {
          isEmojiOnly = true;
        }
      }
    }

    let statusIcon = <Ionicons name="checkmark-done" size={15} color={item.read_at && showBlueTicks ? '#00bfff' : '#475569'} style={{ marginLeft: 4 }} />;
    if (item.status === 'sending') {
      statusIcon = <Ionicons name="time-outline" size={15} color="#64748B" style={{ marginLeft: 4 }} />;
    } else if (item.status === 'failed') {
      statusIcon = <Ionicons name="alert-circle" size={15} color="#ef4444" style={{ marginLeft: 4 }} />;
    }

    return (
      <SwipeableMessage onReply={() => setReplyingTo(item)}>
        <TouchableOpacity
          activeOpacity={0.9}
          onPressIn={(e) => {
            touchStartX.current = e.nativeEvent.pageX;
            touchStartY.current = e.nativeEvent.pageY;
            isScrolling.current = false;

            hasTriggeredShort.current = false;
            hasTriggeredLong.current = false;

            shortTimer.current = setTimeout(() => {
              if (!hasTriggeredLong.current) {
                setReactionTargetMessage(item);
                hasTriggeredShort.current = true;
              }
            }, 350);

            longTimer.current = setTimeout(() => {
              setReactionTargetMessage(null);
              setInfoModalMessage(item);
              hasTriggeredLong.current = true;
            }, 1300);
          }}
          onPressOut={(e) => {
            clearTimeout(shortTimer.current);
            clearTimeout(longTimer.current);

            // Mede a distância percorrida pelo dedo. Se foi > 15px, foi rolagem de tela!
            const dx = Math.abs(e.nativeEvent.pageX - touchStartX.current);
            const dy = Math.abs(e.nativeEvent.pageY - touchStartY.current);
            if (dx > 15 || dy > 15) {
              isScrolling.current = true;
            }
          }}
          onPress={() => {
            if (isScrolling.current) return;

            if (!hasTriggeredShort.current && !hasTriggeredLong.current) {
              if (item.status === 'failed') {
                forceManualRetry(item.id);
              } else if (item.media_url) {
                if (item.media_type === 'video') {
                  setFullscreenVideo(item.media_url);
                } else {
                  setFullscreenImage(item.media_url);
                }
              } else {
                setReplyingTo(item);
              }
            }
          }}
      style={[
        styles.messageBubble, 
        isMyMessage ? styles.myBubble : styles.theirBubble, 
        { maxWidth: SCREEN_WIDTH * 0.78 },
        isEmojiOnly && { backgroundColor: 'transparent', borderWidth: 0, elevation: 0, paddingBottom: 4 }
      ]}
        >
          {quotedMsg && (
            <View style={styles.quoteInsideBubble}>
              <Text style={styles.quoteInsideText} numberOfLines={1}>{quotedMsg.content}</Text>
            </View>
          )}

          {item.media_url ? (
            <View>
              {item.media_type === 'video' ? (
                <View style={[styles.imageBubble, { width: IMAGE_SIZE, height: IMAGE_SIZE, backgroundColor: '#1E293B', overflow: 'hidden', justifyContent: 'center', alignItems: 'center' }]}>
                  <Video source={{ uri: item.media_url }} style={StyleSheet.absoluteFill} resizeMode={ResizeMode.COVER} shouldPlay={false} isMuted={true} />
                  <View style={{ position: 'absolute', backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 24 }}><Ionicons name="play-circle" size={48} color="#fff" /></View>
                  <TouchableOpacity style={styles.downloadBtn} onPress={() => handleDownloadMedia(item.media_url)}><Ionicons name="download" size={18} color="#fff" /></TouchableOpacity>
                </View>
              ) : (
                <View style={{ position: 'relative' }}>
                  <Image source={{ uri: item.media_url }} style={[styles.imageBubble, { width: IMAGE_SIZE, height: IMAGE_SIZE }]} resizeMode="cover" />
                  <TouchableOpacity style={styles.downloadBtn} onPress={() => handleDownloadMedia(item.media_url)}><Ionicons name="download" size={18} color="#fff" /></TouchableOpacity>
                </View>
              )}
              <View style={[styles.bubbleFooter, { paddingHorizontal: 8, paddingBottom: 6, paddingTop: 4 }]}>
                <Text style={styles.messageTime}>{timeString}</Text>
                {isMyMessage && statusIcon}
              </View>
            </View>
          ) : (
            <>
          {renderMessageText(item.content, item.status === 'failed', isEmojiOnly)}
          <View style={[styles.bubbleFooter, isEmojiOnly && { backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, alignSelf: 'flex-end', marginTop: -5 }]}>
            <Text style={[styles.messageTime, isEmojiOnly && { color: '#fff' }]}>{timeString}</Text>
                {isMyMessage && statusIcon}
              </View>
            </>
          )}

          {rList.length > 0 && (
            <TouchableOpacity activeOpacity={0.7} onPress={() => handleRemoveReaction(item.id)} style={[styles.reactionBadge, isMyMessage ? styles.myBadgePos : styles.theirBadgePos]} >
              <Text style={styles.reactionText}>{rList.slice(0, 3).join('')}</Text>
            </TouchableOpacity>
          )}
        </TouchableOpacity>
      </SwipeableMessage>
    );
  };

  return (
    <SafeAreaView style={styles.mainContainer}>
      <StatusBar barStyle="light-content" backgroundColor="#0d0d0d" />
      <KeyboardAvoidingView 
        style={{ flex: 1 }} 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'android' ? StatusBar.currentHeight : 0}
      >
        
        <View style={styles.chatHeader}>
          <TouchableOpacity onPress={onBack} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="chevron-back" size={24} color="#00ff66" />
          </TouchableOpacity>
          <View style={styles.headerInfo}>
            <Text style={styles.friendName} numberOfLines={1}>{currentFriendName}</Text>
            <Text style={[styles.friendStatus, isFriendTyping && { color: '#00ff66', fontWeight: 'bold' }]}>
              {isFriendTyping ? 'digitando...' : friendCode}
            </Text>
          </View>
          <TouchableOpacity onPress={() => setTopMenuVisible(true)} style={styles.menuBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="ellipsis-vertical" size={20} color="#00ff66" />
          </TouchableOpacity>
        </View>

        <View style={{ flex: 1, backgroundColor: '#050505', position: 'relative' }}>
          {loading ? (
            <ActivityIndicator size="large" color="#00ff66" style={{ flex: 1 }} />
          ) : (
            <FlatList
              ref={flatListRef}
              data={[...pendingQueue, ...messages]}
              keyExtractor={(item) => String(item.id)}
              renderItem={renderItem}
              inverted
              contentContainerStyle={[styles.messagesList, { paddingHorizontal: SCREEN_WIDTH < 360 ? 8 : 12 }]} 
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              onScroll={handleScroll}
              scrollEventThrottle={16}
            />
          )}
          {showScrollToBottom && (
            <TouchableOpacity 
              style={styles.scrollToBottomBtn} 
              onPress={() => flatListRef.current?.scrollToOffset({ offset: 0, animated: true })}
            >
              <Ionicons name="chevron-down" size={22} color="#64748B" />
            </TouchableOpacity>
          )}
        </View>

        {replyingTo && (
          <View style={styles.replyBarContainer}>
            <View style={styles.replyBarLeft}>
              <Text style={styles.replyUserTarget}>Respondendo</Text>
              <Text style={styles.replyTextTarget} numberOfLines={1}>{replyingTo.content}</Text>
            </View>
            <TouchableOpacity onPress={() => setReplyingTo(null)}><Ionicons name="close-circle" size={20} color="#ef4444" /></TouchableOpacity>
          </View>
        )}

        <View style={styles.inputWrapper}>
          <View style={styles.inputContainer}>
            <TouchableOpacity onPress={() => setAttachMenuVisible(true)} style={styles.attachBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="attach-outline" size={22} color="#64748B" />
            </TouchableOpacity>
            <TextInput style={styles.textInput} placeholder="Digite sua mensagem..." placeholderTextColor="#475569" value={inputText} onChangeText={handleTextChange} multiline maxLength={2000} />
            <TouchableOpacity style={styles.sendBtn} onPress={handleSendMessage}><Ionicons name="send" size={18} color="#000" /></TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* MODAL 1.1: Menu de Anexos (Clipe) */}
      <Modal animationType="fade" transparent visible={attachMenuVisible} onRequestClose={() => setAttachMenuVisible(false)}>
        <TouchableOpacity style={styles.attachMenuOverlay} activeOpacity={1} onPress={() => setAttachMenuVisible(false)}>
          <View style={styles.attachMenuContent}>
            <TouchableOpacity style={styles.attachMenuItem} onPress={() => handleSelectMedia('camera_photo')}><Ionicons name="camera-outline" size={22} color="#00ff66" style={{ marginRight: 15 }} /><Text style={styles.menuItemText}>Câmera (Foto)</Text></TouchableOpacity>
            <TouchableOpacity style={styles.attachMenuItem} onPress={() => handleSelectMedia('camera_video')}><Ionicons name="videocam-outline" size={22} color="#ef4444" style={{ marginRight: 15 }} /><Text style={styles.menuItemText}>Câmera (Vídeo)</Text></TouchableOpacity>
            <TouchableOpacity style={styles.attachMenuItem} onPress={() => handleSelectMedia('gallery')}><Ionicons name="images-outline" size={22} color="#3b82f6" style={{ marginRight: 15 }} /><Text style={styles.menuItemText}>Galeria</Text></TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* MODAL 1.2: Menu do Topo (Geral) */}
      <Modal animationType="fade" transparent visible={topMenuVisible} onRequestClose={() => setTopMenuVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setTopMenuVisible(false)}>
          <View style={[styles.menuContent, { width: Math.min(SCREEN_WIDTH * 0.85, 320) }]}>
            <Text style={styles.menuSectionTitle}>Ações do Chat</Text>
            <TouchableOpacity style={styles.menuItem} onPress={() => { setTopMenuVisible(false); setMediaGalleryVisible(true); }}><Ionicons name="images-outline" size={18} color="#fff" style={{ marginRight: 10 }} /><Text style={styles.menuItemText}>Mídias do Chat</Text></TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={() => { setTopMenuVisible(false); setEditNameVisible(true); }}><Ionicons name="create-outline" size={18} color="#fff" style={{ marginRight: 10 }} /><Text style={styles.menuItemText}>Editar Nome</Text></TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={handleClearChat}><Ionicons name="trash-outline" size={18} color="#ef4444" style={{ marginRight: 10 }} /><Text style={[styles.menuItemText, { color: '#ef4444' }]}>Excluir Bate-papo</Text></TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* MODAL 2: Editar Nome */}
      <Modal animationType="fade" transparent visible={editNameVisible} onRequestClose={() => setEditNameVisible(false)}>
        <View style={styles.modalOverlayDark}>
          <View style={styles.editNameCard}>
            <Text style={styles.modalTitle}>Alterar Nome</Text>
            <TextInput style={styles.modalInput} value={newNameInput} onChangeText={setNewNameInput} maxLength={20} autoFocus />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#152233' }]} onPress={() => setEditNameVisible(false)}><Text style={{ color: '#fff' }}>Cancelar</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#00ff66' }]} onPress={handleUpdateFriendName}><Text style={{ color: '#000', fontWeight: 'bold' }}>Salvar</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* MODAL 3: Detalhes e Autodestruição (Long Press) */}
      <Modal animationType="fade" transparent visible={!!infoModalMessage} onRequestClose={() => setInfoModalMessage(null)}>
        <TouchableOpacity style={styles.modalOverlayDark} activeOpacity={1} onPress={() => setInfoModalMessage(null)}>
          <TouchableOpacity activeOpacity={1} style={styles.editNameCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>Metadados do Arquivo</Text>
            {infoModalMessage && (
              <View style={styles.metaContainer}>
                <View style={styles.metaRow}><Text style={styles.metaLabel}>Registrado em:</Text><Text style={styles.metaValue}>{getMessageLifetime(infoModalMessage.created_at).exato}</Text></View>
                <View style={styles.metaRow}><Text style={styles.metaLabel}>Apagando em:</Text><Text style={[styles.metaValue, { color: '#00ff66', fontWeight: 'bold' }]}>{getMessageLifetime(infoModalMessage.created_at).restante}</Text></View>
              </View>
            )}
            {infoModalMessage?.content && !infoModalMessage?.media_url && (
              <View style={[styles.selectableTextContainer, { maxHeight: 250 }]}>
                <ScrollView nestedScrollEnabled indicatorStyle="white">
                  <Text selectable={true} style={styles.selectableText}>{infoModalMessage.content}</Text>
                </ScrollView>
                <Text style={{ color: '#64748B', fontSize: 10, marginTop: 10, textAlign: 'center' }}>Segure no texto acima para selecionar trechos</Text>
              </View>
            )}
            <View style={styles.modalButtons}>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#152233' }]} onPress={() => setInfoModalMessage(null)}><Text style={{ color: '#fff' }}>Voltar</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#ef4444' }]} onPress={() => handleDeleteMessage(infoModalMessage.id)}><Text style={{ color: '#fff', fontWeight: 'bold' }}>Excluir para mim</Text></TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* MODAL 4: Menu de Reações Flutuantes (Short Hold) */}
      <Modal animationType="fade" transparent visible={!!reactionTargetMessage} onRequestClose={() => { setReactionTargetMessage(null); setShowCustomEmojiInput(false); }}>
        <View style={styles.reactionOverlay}>
          {/* 🚀 Barra Superior Contextual (Estilo WhatsApp) */}
          <View style={styles.contextualHeaderContainer}>
            <TouchableOpacity onPress={() => { setReactionTargetMessage(null); setShowCustomEmojiInput(false); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="arrow-back" size={24} color="#fff" />
            </TouchableOpacity>
            
            <View style={styles.contextualActions}>
              {reactionTargetMessage && !reactionTargetMessage.media_url && (
                <TouchableOpacity onPress={async () => {
                  await Clipboard.setStringAsync(reactionTargetMessage.content || '');
                  setReactionTargetMessage(null);
                }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name="copy-outline" size={24} color="#fff" />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* Fundo clicável para fechar + Menu de Emojis */}
          <TouchableOpacity style={styles.reactionOverlayDismiss} activeOpacity={1} onPress={() => { setReactionTargetMessage(null); setShowCustomEmojiInput(false); }}>
            <View style={[styles.reactionRowBar, { maxWidth: SCREEN_WIDTH * 0.9 }]}>
              {showCustomEmojiInput ? (
                <TextInput autoFocus style={{ color: '#fff', fontSize: 26, minWidth: 50, textAlign: 'center' }} placeholder="+" placeholderTextColor="#64748B" onChangeText={(text) => { if (text.trim().length > 0) { handleReactToMessage(reactionTargetMessage.id, text.trim()); setShowCustomEmojiInput(false); } }} />
              ) : (
                <>
                  {['👍', '❤️', '😂', '😮', '😢', '🙏'].map((emoji) => (
                    <TouchableOpacity key={emoji} style={styles.reactionEmojiBtn} onPress={() => handleReactToMessage(reactionTargetMessage.id, emoji)}><Text style={{ fontSize: 26 }}>{emoji}</Text></TouchableOpacity>
                  ))}
                  <TouchableOpacity style={styles.reactionEmojiBtn} onPress={() => setShowCustomEmojiInput(true)}><Ionicons name="add-circle" size={32} color="#64748B" style={{ marginTop: 2 }} /></TouchableOpacity>
                </>
              )}
            </View>
          </TouchableOpacity>
        </View>
      </Modal>

      {/* MODAL 5: Imagem em Tela Cheia */}
      <Modal animationType="fade" transparent visible={!!fullscreenImage} onRequestClose={() => setFullscreenImage(null)}>
        <View style={styles.fullscreenOverlay}>
          <TouchableOpacity style={styles.closeFullscreenBtn} onPress={() => setFullscreenImage(null)}><Ionicons name="close" size={28} color="#fff" /></TouchableOpacity>
          {fullscreenImage && <Image source={{ uri: fullscreenImage }} style={styles.fullscreenImage} resizeMode="contain" />}
        </View>
      </Modal>

      {/* MODAL 7: Video em Tela Cheia */}
      <Modal animationType="fade" transparent visible={!!fullscreenVideo} onRequestClose={() => setFullscreenVideo(null)}>
        <View style={styles.fullscreenOverlay}>
          <TouchableOpacity style={styles.closeFullscreenBtn} onPress={() => setFullscreenVideo(null)}><Ionicons name="close" size={28} color="#fff" /></TouchableOpacity>
          {fullscreenVideo && (
            <Video
              style={styles.fullscreenImage}
              source={{ uri: fullscreenVideo }}
              useNativeControls
              resizeMode={ResizeMode.CONTAIN}
              shouldPlay
            />
          )}
        </View>
      </Modal>

      {/* MODAL 6: Mídias do Chat */}
      <Modal animationType="slide" transparent visible={mediaGalleryVisible} onRequestClose={() => setMediaGalleryVisible(false)}>
        <SafeAreaView style={[styles.mainContainer, { paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 }]}>
          <View style={[styles.chatHeader, { borderBottomWidth: 1, borderColor: '#111' }]}>
            <TouchableOpacity onPress={() => setMediaGalleryVisible(false)}><Ionicons name="close" size={26} color="#00ff66" /></TouchableOpacity>
            <Text style={styles.friendName}>Mídias Compartilhadas</Text>
          </View>
          <FlatList
            data={messages.filter(m => m.media_url)}
            keyExtractor={(item) => String(item.id)}
            numColumns={3}
            contentContainerStyle={{ padding: 4 }}
            renderItem={({ item }) => (
              <TouchableOpacity style={{ flex: 1/3, aspectRatio: 1, padding: 2 }} onPress={() => item.media_type === 'video' ? setFullscreenVideo(item.media_url) : setFullscreenImage(item.media_url)}>
                {item.media_type === 'video' ? (
                  <View style={{ width: '100%', height: '100%', borderRadius: 4, backgroundColor: '#1E293B', overflow: 'hidden', justifyContent: 'center', alignItems: 'center' }}>
                    <Video source={{ uri: item.media_url }} style={StyleSheet.absoluteFill} resizeMode={ResizeMode.COVER} shouldPlay={false} isMuted={true} />
                    <View style={{ position: 'absolute', backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 14 }}><Ionicons name="play" size={28} color="#fff" /></View>
                  </View>
                ) : (
                  <Image source={{ uri: item.media_url }} style={{ width: '100%', height: '100%', borderRadius: 4 }} />
                )}
              </TouchableOpacity>
            )}
            ListEmptyComponent={() => (
              <View style={{ flex: 1, alignItems: 'center', marginTop: 50 }}><Text style={{ color: '#475569' }}>Nenhuma mídia trocada.</Text></View>
            )}
          />
        </SafeAreaView>
      </Modal>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  mainContainer: { flex: 1, backgroundColor: '#050505' },
  chatHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15, paddingVertical: 10, backgroundColor: '#0d0d0d', borderBottomWidth: 1, borderBottomColor: '#111', minHeight: 65 },
  backBtn: { paddingRight: 12 },
  menuBtn: { padding: 5 },
  headerInfo: { flex: 1, minWidth: 0, justifyContent: 'center' }, 
  friendName: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  friendStatus: { color: '#64748B', fontSize: 11, marginTop: 2 },
  messagesList: { paddingVertical: 18 },
  swipeContainer: { flexDirection: 'row', alignItems: 'center', width: '100%', position: 'relative' },
  replyIconLeft: { position: 'absolute', left: -38, justifyContent: 'center', height: '100%' },
  messageBubble: { paddingHorizontal: 13, paddingVertical: 9, borderRadius: 16, marginBottom: 16, position: 'relative', minWidth: 60 },
  myBubble: { backgroundColor: '#1E293B', alignSelf: 'flex-end', borderBottomRightRadius: 4 },
  theirBubble: { backgroundColor: '#0d0d0d', alignSelf: 'flex-start', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: '#111' },
  imageBubble: { borderRadius: 14 },
  messageText: { color: '#fff', fontSize: 15, lineHeight: 21 },
  bubbleFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 4 },
  messageTime: { color: '#475569', fontSize: 10, fontFamily: 'monospace' },
  quoteInsideBubble: { backgroundColor: 'rgba(0,0,0,0.3)', borderLeftWidth: 2, borderLeftColor: '#00ff66', padding: 6, borderRadius: 4, marginBottom: 6 },
  quoteInsideText: { color: '#94a3b8', fontSize: 12 },
  reactionBadge: { position: 'absolute', bottom: -10, backgroundColor: '#111827', borderWidth: 1, borderColor: '#1F2937', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10, flexDirection: 'row', alignItems: 'center', minWidth: 24, justifyContent: 'center' },
  myBadgePos: { right: 10 },
  theirBadgePos: { left: 10 },
  reactionText: { color: '#fff', fontSize: 11 },
  reactionOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)' },
  contextualHeaderContainer: { backgroundColor: '#1E293B', width: '100%', paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 0) + 15 : 55, paddingBottom: 15, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', elevation: 5, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 3.84 },
  contextualActions: { flexDirection: 'row', alignItems: 'center' },
  reactionOverlayDismiss: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  reactionRowBar: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', backgroundColor: '#0d0d0d', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 30, borderWidth: 1, borderColor: '#1F2937', gap: 14, elevation: 10 },
  reactionEmojiBtn: { padding: 4 },
  replyBarContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0d0d0d', paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#1F2937' },
  replyBarLeft: { borderLeftWidth: 3, borderLeftColor: '#00ff66', paddingLeft: 10, flex: 1 },
  replyUserTarget: { color: '#00ff66', fontSize: 12, fontWeight: 'bold' },
  replyTextTarget: { color: '#64748B', fontSize: 13, marginTop: 2 },
  inputWrapper: { backgroundColor: '#0d0d0d', borderTopWidth: 1, borderTopColor: '#111', paddingBottom: Platform.OS === 'ios' ? 10 : 48, paddingTop: 10 },
  inputContainer: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12 },
  attachBtn: { padding: 8, marginRight: 4, marginBottom: 2 },
  textInput: { flex: 1, minHeight: 42, width: 0, backgroundColor: '#111827', color: '#fff', borderRadius: 22, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10, fontSize: 15, maxHeight: 120, marginRight: 10, textAlignVertical: 'center' },
  sendBtn: { backgroundColor: '#00ff66', width: 42, height: 42, borderRadius: 21, justifyContent: 'center', alignItems: 'center', marginBottom: 1 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-start', alignItems: 'flex-end', paddingRight: 15, paddingTop: Platform.OS === 'android' ? 65 : 70 },
  menuContent: { backgroundColor: '#0d0d0d', borderRadius: 16, padding: 15, borderWidth: 1, borderColor: '#1F2937', maxWidth: 320 },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  menuItemText: { color: '#fff', fontSize: 14, fontWeight: '500' },
  menuDivider: { height: 1, backgroundColor: '#1F2937', marginVertical: 8 },
  menuSectionTitle: { color: '#64748B', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase', marginBottom: 4, marginTop: 8 },
  attachMenuOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end', paddingBottom: Platform.OS === 'ios' ? 90 : 80, paddingLeft: 15 },
  attachMenuContent: { backgroundColor: '#111827', borderRadius: 16, paddingVertical: 8, paddingHorizontal: 15, borderWidth: 1, borderColor: '#1F2937', width: 220, marginBottom: 5 },
  attachMenuItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  modalOverlayDark: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  editNameCard: { backgroundColor: '#0d0d0d', borderRadius: 20, padding: 22, borderWidth: 1, borderColor: '#1F2937', width: '90%', maxWidth: 380 },
  modalTitle: { color: '#fff', fontSize: 16, fontWeight: 'bold', marginBottom: 15, textAlign: 'center' },
  modalInput: { backgroundColor: '#111827', color: '#fff', padding: 12, borderRadius: 10, fontSize: 16, borderWidth: 1, borderColor: '#1F2937', marginBottom: 20, width: '100%' },
  modalBtn: { flex: 1, padding: 12, borderRadius: 10, alignItems: 'center', marginHorizontal: 5 },
  metaContainer: { backgroundColor: '#111827', padding: 15, borderRadius: 12, marginBottom: 20, borderWidth: 1, borderColor: '#1F2937' },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 6 },
  metaLabel: { color: '#64748B', fontSize: 13 },
  metaValue: { color: '#fff', fontSize: 13, fontFamily: 'monospace' },
  modalButtons: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  selectableTextContainer: { backgroundColor: '#111827', padding: 15, borderRadius: 12, marginBottom: 15, borderWidth: 1, borderColor: '#1F2937', maxHeight: 150 },
  selectableText: { color: '#fff', fontSize: 15, lineHeight: 22 },
  fullscreenOverlay: { flex: 1, backgroundColor: 'black', justifyContent: 'center', alignItems: 'center' },
  fullscreenImage: { width: '100%', height: '100%' },
  closeFullscreenBtn: { position: 'absolute', top: Platform.OS === 'android' ? 40 : 50, right: 20, zIndex: 99, elevation: 99, padding: 8, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 20 },
  downloadFullscreenBtn: { position: 'absolute', top: Platform.OS === 'android' ? 40 : 50, right: 80, zIndex: 99, elevation: 99, padding: 8, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 20 },
  downloadBtn: { position: 'absolute', top: 8, right: 8, backgroundColor: 'rgba(0,0,0,0.5)', padding: 6, borderRadius: 16, zIndex: 10, elevation: 10 },
  linkPreviewContainer: { backgroundColor: '#111827', borderRadius: 8, marginTop: 8, overflow: 'hidden', borderWidth: 1, borderColor: '#1F2937' },
  linkPreviewImage: { width: '100%', height: 120, backgroundColor: '#1e293b' },
  linkPreviewTextContainer: { padding: 10 },
  linkPreviewTitle: { color: '#fff', fontSize: 14, fontWeight: 'bold', marginBottom: 4 },
  linkPreviewDesc: { color: '#94A3B8', fontSize: 12 },
  scrollToBottomBtn: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    backgroundColor: '#1E293B',
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3
  }
});