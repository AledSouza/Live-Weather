import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity,
  SafeAreaView, ActivityIndicator, KeyboardAvoidingView, Platform,
  StatusBar, Modal, Image, Animated, PanResponder, useWindowDimensions
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabase';

const SUPABASE_URL = 'https://rzmhvinmavwgtglrhqmf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6bWh2aW5tYXZ3Z3RnbHJocW1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwNTA0NTcsImV4cCI6MjA5NjYyNjQ1N30.Yp6w81vNORd7sKguYV7x6kl476KJoMbl5es1GdwjpLc';

const SwipeableMessage = ({ children, onReply }) => {
  const pan = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => Math.abs(gestureState.dx) > 20 && Math.abs(gestureState.dy) < 10,
      onPanResponderMove: (_, gestureState) => { if (gestureState.dx > 0) pan.setValue(gestureState.dx); },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dx > 70) onReply();
        Animated.spring(pan, { toValue: 0, useNativeDriver: true }).start();
      }
    })
  ).current;

  return (
    <View style={styles.swipeContainer}>
      <Animated.View style={[styles.replyIconLeft, { opacity: pan.interpolate({ inputRange: [0, 60], outputRange: [0, 1] }) }]}>
        <Ionicons name="arrow-undo" size={16} color="#00ff66" />
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX: pan }], width: '100%' }} {...panResponder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
};

export default function ChatRoomScreen({ onBack, userCode, friendCode, friendName }) {
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  const [currentFriendName, setCurrentFriendName] = useState(friendName);
  const [menuVisible, setMenuVisible] = useState(false);
  const [editNameVisible, setEditNameVisible] = useState(false);
  const [newNameInput, setNewNameInput] = useState(friendName);
  const [replyingTo, setReplyingTo] = useState(null);
  const [fullscreenImage, setFullscreenImage] = useState(null);

  const [isFriendTyping, setIsFriendTyping] = useState(false);
  const [reactionTargetMessage, setReactionTargetMessage] = useState(null);
  const [showCustomEmojiInput, setShowCustomEmojiInput] = useState(false);
  const [infoModalMessage, setInfoModalMessage] = useState(null);
  const [mediaGalleryVisible, setMediaGalleryVisible] = useState(false);

  const [pendingQueue, setPendingQueue] = useState([]);

  const shortTimer = useRef(null);
  const longTimer = useRef(null);
  const hasTriggeredShort = useRef(false);
  const hasTriggeredLong = useRef(false);

  const flatListRef = useRef();
  const channelRef = useRef(null);
  const { width: SCREEN_WIDTH } = useWindowDimensions();
  const IMAGE_SIZE = Math.min(SCREEN_WIDTH * 0.65, 320);

  useEffect(() => {
    const initializeChatState = async () => {
      try {
        const savedDraft = await AsyncStorage.getItem(`@draft_${userCode}_${friendCode}`);
        if (savedDraft) setInputText(savedDraft);

        const storedQueue = await AsyncStorage.getItem(`@queue_${userCode}_${friendCode}`);
        if (storedQueue) setPendingQueue(JSON.parse(storedQueue));
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
    const processQueue = async () => {
      const nextMessage = pendingQueue.find(m => m.status === 'sending');
      if (!nextMessage) return;

      try {
        const { error } = await supabase.from('mensagens').insert([{
          sender_code: nextMessage.sender_code,
          receiver_code: nextMessage.receiver_code,
          content: nextMessage.content,
          reply_to_id: nextMessage.reply_to_id
        }]);
        if (error) throw error;
      } catch (err) {
        setPendingQueue(prev => prev.map(m => m.id === nextMessage.id ? { ...m, status: 'failed' } : m));
      }
    };
    processQueue();
  }, [pendingQueue]);

  useEffect(() => {
    const autoRetryInterval = setInterval(() => {
      setPendingQueue(prev => {
        const hasFailedMessages = prev.some(m => m.status === 'failed');
        if (!hasFailedMessages) return prev;
        return prev.map(m => m.status === 'failed' ? { ...m, status: 'sending' } : m);
      });
    }, 6000);
    return () => clearInterval(autoRetryInterval);
  }, []);

  useEffect(() => {
    const fetchMessages = async () => {
      try {
        const { data, error } = await supabase
          .from('mensagens')
          .select('*')
          .or(`and(sender_code.eq.${userCode},receiver_code.eq.${friendCode}),and(sender_code.eq.${friendCode},receiver_code.eq.${userCode})`)
          .order('created_at', { ascending: false });

        if (!error) {
          setMessages(data || []);
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
            setMessages((prev) => [newMsg, ...prev]);
            if (newMsg.sender_code === userCode) {
              setPendingQueue(prev => prev.filter(m => m.content !== newMsg.content));
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
    await supabase.from('mensagens').update({ read_at: new Date().toISOString() }).eq('sender_code', friendCode).eq('receiver_code', userCode).is('read_at', null);
  };

  const handleTextChange = async (text) => {
    setInputText(text);
    try {
      await AsyncStorage.setItem(`@draft_${userCode}_${friendCode}`, text);
    } catch (e) { console.error(e); }

    channelRef.current?.send({
      type: 'broadcast',
      event: 'typing',
      payload: { sender: userCode, isTyping: text.trim().length > 0 }
    });
  };

  const handleSendMessage = async () => {
    if (inputText.trim() === '') return;
    const messageContent = inputText.trim();
    const currentReplyId = replyingTo ? replyingTo.id : null;
    
    setInputText('');
    setReplyingTo(null);

    try {
      await AsyncStorage.removeItem(`@draft_${userCode}_${friendCode}`);
    } catch (e) { console.error(e); }

    channelRef.current?.send({ type: 'broadcast', event: 'typing', payload: { sender: userCode, isTyping: false } });

    const newPendingMessage = {
      id: `pending-${Date.now()}-${Math.random()}`,
      content: messageContent,
      sender_code: userCode,
      receiver_code: friendCode,
      reply_to_id: currentReplyId,
      created_at: new Date().toISOString(),
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
    const now = new Date();
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

  const handleUploadAndSendMedia = async (uri, mediaType, base64Data) => {
    try {
      setUploading(true);
      const tempId = `temp-${Date.now()}`;
      setMessages((prev) => [{ id: tempId, sender_code: userCode, receiver_code: friendCode, content: 'Enviando...', media_url: uri, media_type: mediaType, created_at: new Date().toISOString(), is_uploading: true }, ...prev]);

      const filename = `${userCode}-${Date.now()}.jpg`;
      if (!base64Data) throw new Error("O Snack não suporta vídeos.");

      const response = await fetch(`data:image/jpeg;base64,${base64Data}`);
      const arrayBuffer = await response.arrayBuffer();

      const { error: uploadError } = await supabase.storage.from('chat-media').upload(filename, arrayBuffer, { contentType: 'image/jpeg', upsert: true });
      if (uploadError) throw uploadError;

      const mediaUrl = `${SUPABASE_URL}/storage/v1/object/public/chat-media/${filename}`;
      await supabase.from('mensagens').insert([{ sender_code: userCode, receiver_code: friendCode, content: '📩 Arquivo de mídia enviado', media_url: mediaUrl, media_type: mediaType, reply_to_id: replyingTo?.id }]);

      setMessages((prev) => prev.filter(msg => msg.id !== tempId));
      setReplyingTo(null);
    } catch (err) { alert(`Falha: ${err.message}`); } finally { setUploading(false); }
  };

  const handleSelectMedia = async (type) => {
    setMenuVisible(false);
    try {
      const resPhoto = await ImagePicker.requestMediaLibraryPermissionsAsync();
      const resCam = await ImagePicker.requestCameraPermissionsAsync();
      if (!resPhoto.granted || !resCam.granted) return alert('Permissões necessárias.');

      let result = null;
      if (type === 'camera') result = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, quality: 0.5, base64: true });
      else if (type === 'gallery_photo') result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsMultipleSelection: false, quality: 0.5, base64: true });

      if (result && !result.canceled && result.assets && result.assets[0].uri) {
        await handleUploadAndSendMedia(result.assets[0].uri, 'image', result.assets[0].base64 || null);
      }
    } catch (err) { console.error(err); }
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
      await supabase.from('mensagens').delete().or(`and(sender_code.eq.${userCode},receiver_code.eq.${friendCode}),and(sender_code.eq.${friendCode},receiver_code.eq.${userCode})`);
      setMessages([]);
      setMenuVisible(false);
    } catch (err) { console.error(err); }
  };

  const renderItem = ({ item }) => {
    const isMyMessage = item.sender_code === userCode;
    const timeString = new Date(item.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const quotedMsg = item.reply_to_id ? messages.find(m => m.id === item.reply_to_id) : null;
    const rList = item.reacoes ? Object.values(item.reacoes).filter(Boolean) : [];

    let statusIcon = <Ionicons name={item.read_at ? 'checkmark-done' : 'checkmark'} size={15} color={item.read_at ? '#00bfff' : '#475569'} style={{ marginLeft: 4 }} />;
    if (item.status === 'sending') {
      statusIcon = <Ionicons name="time-outline" size={15} color="#64748B" style={{ marginLeft: 4 }} />;
    } else if (item.status === 'failed') {
      statusIcon = <Ionicons name="alert-circle" size={15} color="#ef4444" style={{ marginLeft: 4 }} />;
    }

    return (
      <SwipeableMessage onReply={() => setReplyingTo(item)}>
        <TouchableOpacity
          activeOpacity={0.9}
          onPressIn={() => {
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
          onPressOut={() => {
            clearTimeout(shortTimer.current);
            clearTimeout(longTimer.current);

            if (!hasTriggeredShort.current && !hasTriggeredLong.current) {
              if (item.status === 'failed') {
                forceManualRetry(item.id);
              } else if (item.media_url) {
                setFullscreenImage(item.media_url);
              } else {
                setReplyingTo(item);
              }
            }
          }}
          style={[styles.messageBubble, isMyMessage ? styles.myBubble : styles.theirBubble, { maxWidth: SCREEN_WIDTH * 0.78 }]}
        >
          {quotedMsg && (
            <View style={styles.quoteInsideBubble}>
              <Text style={styles.quoteInsideText} numberOfLines={1}>{quotedMsg.content}</Text>
            </View>
          )}

          {item.media_url ? (
            <View>
              <Image source={{ uri: item.media_url }} style={[styles.imageBubble, { width: IMAGE_SIZE, height: IMAGE_SIZE }]} resizeMode="cover" />
              <View style={[styles.bubbleFooter, { paddingHorizontal: 8, paddingBottom: 6 }]}>
                <Text style={styles.messageTime}>{timeString}</Text>
                {isMyMessage && statusIcon}
              </View>
            </View>
          ) : (
            <>
              <Text style={[styles.messageText, item.status === 'failed' && { color: '#94a3b8' }]}>{item.content}</Text>
              <View style={styles.bubbleFooter}>
                <Text style={styles.messageTime}>{timeString}</Text>
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
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        
        <View style={styles.chatHeader}>
          <TouchableOpacity onPress={onBack} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="chevron-back" size={24} color="#00ff66" />
          </TouchableOpacity>
          <View style={styles.headerInfo}>
            <Text style={styles.friendName} numberOfLines={1}>{currentFriendName}</Text>
            <Text style={[styles.friendStatus, isFriendTyping && { color: '#00ff66', fontWeight: 'bold' }]}>
              {isFriendTyping ? 'digitando...' : 'Canal seguro ativo'}
            </Text>
          </View>
          <TouchableOpacity onPress={() => setMenuVisible(true)} style={styles.menuBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="ellipsis-vertical" size={20} color="#00ff66" />
          </TouchableOpacity>
        </View>

        <View style={{ flex: 1, backgroundColor: '#050505' }}>
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
            />
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
            <TouchableOpacity onPress={() => setMenuVisible(true)} style={styles.attachBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="attach-outline" size={22} color="#64748B" />
            </TouchableOpacity>
            <TextInput style={styles.textInput} placeholder="Criptografar..." placeholderTextColor="#475569" value={inputText} onChangeText={handleTextChange} multiline maxLength={2000} />
            <TouchableOpacity style={styles.sendBtn} onPress={handleSendMessage}><Ionicons name="send" size={18} color="#000" /></TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* MODAL 1: Menu Geral */}
      <Modal animationType="fade" transparent visible={menuVisible} onRequestClose={() => setMenuVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setMenuVisible(false)}>
          <View style={[styles.menuContent, { width: Math.min(SCREEN_WIDTH * 0.85, 320) }]}>
            <Text style={styles.menuSectionTitle}>Enviar Mídia</Text>
            <TouchableOpacity style={styles.menuItem} onPress={() => handleSelectMedia('camera')}><Ionicons name="camera-outline" size={18} color="#fff" style={{ marginRight: 10 }} /><Text style={styles.menuItemText}>Tirar Foto</Text></TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={() => handleSelectMedia('gallery_photo')}><Ionicons name="image-outline" size={18} color="#fff" style={{ marginRight: 10 }} /><Text style={styles.menuItemText}>Escolher Foto</Text></TouchableOpacity>
            <View style={styles.menuDivider} />
            <Text style={styles.menuSectionTitle}>Ações do Chat</Text>
            <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuVisible(false); setMediaGalleryVisible(true); }}><Ionicons name="images-outline" size={18} color="#fff" style={{ marginRight: 10 }} /><Text style={styles.menuItemText}>Mídias do Chat</Text></TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={() => { setMenuVisible(false); setEditNameVisible(true); }}><Ionicons name="create-outline" size={18} color="#fff" style={{ marginRight: 10 }} /><Text style={styles.menuItemText}>Editar Nome do Amigo</Text></TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={handleClearChat}><Ionicons name="trash-outline" size={18} color="#ef4444" style={{ marginRight: 10 }} /><Text style={[styles.menuItemText, { color: '#ef4444' }]}>Excluir Bate-papo</Text></TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* MODAL 2: Editar Nome do Amigo */}
      <Modal animationType="fade" transparent visible={editNameVisible} onRequestClose={() => setEditNameVisible(false)}>
        <View style={styles.modalOverlayDark}>
          <View style={styles.editNameCard}>
            <Text style={styles.modalTitle}>Alterar Nome do Amigo</Text>
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
          <View style={styles.editNameCard}>
            <Text style={styles.modalTitle}>Metadados do Arquivo</Text>
            {infoModalMessage && (
              <View style={styles.metaContainer}>
                <View style={styles.metaRow}><Text style={styles.metaLabel}>Registrado em:</Text><Text style={styles.metaValue}>{getMessageLifetime(infoModalMessage.created_at).exato}</Text></View>
                <View style={styles.metaRow}><Text style={styles.metaLabel}>Autodestruição em:</Text><Text style={[styles.metaValue, { color: '#00ff66', fontWeight: 'bold' }]}>{getMessageLifetime(infoModalMessage.created_at).restante}</Text></View>
              </View>
            )}
            <View style={styles.modalButtons}>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#152233' }]} onPress={() => setInfoModalMessage(null)}><Text style={{ color: '#fff' }}>Voltar</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#ef4444' }]} onPress={() => handleDeleteMessage(infoModalMessage.id)}><Text style={{ color: '#fff', fontWeight: 'bold' }}>Excluir para mim</Text></TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* MODAL 4: Menu de Reações Flutuantes (Short Hold) */}
      <Modal animationType="fade" transparent visible={!!reactionTargetMessage} onRequestClose={() => { setReactionTargetMessage(null); setShowCustomEmojiInput(false); }}>
        <TouchableOpacity style={styles.reactionOverlay} activeOpacity={1} onPress={() => { setReactionTargetMessage(null); setShowCustomEmojiInput(false); }}>
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
      </Modal>

      {/* MODAL 5: Imagem em Tela Cheia */}
      <Modal animationType="fade" transparent visible={!!fullscreenImage} onRequestClose={() => setFullscreenImage(null)}>
        <View style={styles.fullscreenOverlay}>
          <TouchableOpacity style={styles.closeFullscreenBtn} onPress={() => setFullscreenImage(null)}><Ionicons name="close" size={28} color="#fff" /></TouchableOpacity>
          {fullscreenImage && <Image source={{ uri: fullscreenImage }} style={styles.fullscreenImage} resizeMode="contain" />}
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
              <TouchableOpacity style={{ flex: 1/3, aspectRatio: 1, padding: 2 }} onPress={() => setFullscreenImage(item.media_url)}>
                <Image source={{ uri: item.media_url }} style={{ width: '100%', height: '100%', borderRadius: 4 }} />
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
  mainContainer: { flex: 1, backgroundColor: '#050505', paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 },
  chatHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15, paddingVertical: 10, backgroundColor: '#0d0d0d', borderBottomWidth: 1, borderBottomColor: '#111', minHeight: 65 },
  backBtn: { paddingRight: 12 },
  menuBtn: { padding: 5 },
  headerInfo: { flex: 1, minWidth: 0, justifyContent: 'center' }, 
  friendName: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  friendStatus: { color: '#64748B', fontSize: 11, marginTop: 2 },
  messagesList: { paddingVertical: 18 },
  swipeContainer: { flexDirection: 'row', alignItems: 'center', width: '100%', position: 'relative' },
  replyIconLeft: { position: 'absolute', left: -25, justifyContent: 'center', height: '100%' },
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
  reactionOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  reactionRowBar: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', backgroundColor: '#0d0d0d', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 30, borderWidth: 1, borderColor: '#1F2937', gap: 14, elevation: 10 },
  reactionEmojiBtn: { padding: 4 },
  replyBarContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0d0d0d', paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#1F2937' },
  replyBarLeft: { borderLeftWidth: 3, borderLeftColor: '#00ff66', paddingLeft: 10, flex: 1 },
  replyUserTarget: { color: '#00ff66', fontSize: 12, fontWeight: 'bold' },
  replyTextTarget: { color: '#64748B', fontSize: 13, marginTop: 2 },
  inputWrapper: { backgroundColor: '#0d0d0d', borderTopWidth: 1, borderTopColor: '#111', paddingBottom: Platform.OS === 'android' ? 24 : 24, paddingTop: 10 },
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
  fullscreenOverlay: { flex: 1, backgroundColor: 'black', justifyContent: 'center', alignItems: 'center' },
  fullscreenImage: { width: '100%', height: '100%' },
  closeFullscreenBtn: { position: 'absolute', top: Platform.OS === 'android' ? 40 : 50, right: 20, zIndex: 99, padding: 8, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 20 }
});