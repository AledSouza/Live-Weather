import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, InteractionManager,
  SafeAreaView, ActivityIndicator, KeyboardAvoidingView, Platform, Linking,
  StatusBar, Modal, Image, Animated, PanResponder, useWindowDimensions, ScrollView,
  ImageBackground, Alert, BackHandler, Dimensions
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { Audio, Video, ResizeMode, InterruptionModeIOS, InterruptionModeAndroid } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as ScreenCapture from 'expo-screen-capture';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import Slider from '@react-native-community/slider';
// import * as Notifications from 'expo-notifications';
import { supabase } from '../supabase';
import { sendWeatherNotification } from './notificationService';
import { useToast } from '../components/Toast';
import {
  AI_DEFAULT_MAX_RETRIES,
  AI_DEFAULT_TIMEOUT_SECONDS,
  AI_SENDER_CODE,
  DEFAULT_AI_NAME,
  DEFAULT_APP_THEME_COLOR,
  GEMINI_MODELS,
  GROUP_INFO_POLL_INTERVAL_MS,
  GROUP_PREFIX,
  MESSAGE_PAGE_SIZE,
  MESSAGE_POLL_INTERVAL_MS,
  MESSAGE_SEARCH_DEBOUNCE_MS,
  MIN_MESSAGE_SEARCH_LENGTH,
  SEARCH_PAGE_SIZE,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  isGroupToken,
} from '../modules/chat/constants';
import {
  extractStoragePath,
  formatAudioMillis,
  generateWaveformBars,
  getDocumentIcon,
  getFirstValidHttpUrl,
  getLinkDomain,
  getPinnedMessagePreview,
  getReplyPreviewText,
  hasReplyThumbnail,
} from '../modules/chat/utils';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const linkPreviewCache = new Map();
const linkPreviewRequests = new Map();

const decodeHtmlEntities = (value) => value
  .replace(/&#x([0-9a-f]+);?/gi, (_, code) => {
    try { return String.fromCodePoint(parseInt(code, 16)); } catch { return ''; }
  })
  .replace(/&#([0-9]+);?/g, (_, code) => {
    try { return String.fromCodePoint(Number(code)); } catch { return ''; }
  })
  .replace(/(?:&amp;)*&?#x([0-9a-f]+);?/gi, (_, code) => {
    try { return String.fromCodePoint(parseInt(code, 16)); } catch { return ''; }
  })
  .replace(/(?:&amp;)*&?#([0-9]+);?/g, (_, code) => {
    try { return String.fromCodePoint(Number(code)); } catch { return ''; }
  })
  .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');

const extractTextFromHtml = (html, pattern) => {
  const match = html.match(pattern);
  if (!match) return null;
  const text = match[1] || match[2] || '';
  return decodeHtmlEntities(text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
};

const getPreviewFromHtmlFallback = async (url) => {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LiveWeather/1.0; +https://example.com)' }
    });
    if (!response.ok) return null;

    const html = await response.text();
    const title = extractTextFromHtml(html, /<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i)
      || extractTextFromHtml(html, /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:title["'][^>]*>/i)
      || extractTextFromHtml(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const description = extractTextFromHtml(html, /<meta[^>]+(?:property|name)=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i)
      || extractTextFromHtml(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i)
      || extractTextFromHtml(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i);
    const imageUrl = extractTextFromHtml(html, /<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i)
      || extractTextFromHtml(html, /<meta[^>]+(?:property|name)=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i)
      || extractTextFromHtml(html, /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["'][^>]*>/i);
    const siteName = extractTextFromHtml(html, /<meta[^>]+(?:property|name)=["']og:site_name["'][^>]+content=["']([^"']+)["'][^>]*>/i)
      || extractTextFromHtml(html, /<meta[^>]+(?:property|name)=["']twitter:site["'][^>]+content=["']([^"']+)["'][^>]*>/i)
      || new URL(url).hostname.replace(/^www\./, '');

    if (!title && !description && !imageUrl) return null;

    return {
      url,
      title: title || null,
      description: description || null,
      image_url: imageUrl || null,
      site_name: siteName || null,
    };
  } catch (error) {
    console.warn('Fallback local de preview falhou:', error?.message || error);
    return null;
  }
};

const ReplyPreviewThumbnail = ({ message }) => {
  if (!message) return null;
  const mediaType = String(message.media_type || '').toLowerCase();
  const isVideo = mediaType.includes('video');
  const thumbnailUrl = message.media_url || message.preview_image_url;

  if (thumbnailUrl && isVideo) {
    return (
      <View style={styles.replyThumbnail}>
        <Video source={{ uri: thumbnailUrl }} style={StyleSheet.absoluteFill} resizeMode={ResizeMode.COVER} shouldPlay={false} isMuted />
        <View style={styles.replyPlayIcon}><Ionicons name="play" size={11} color="#fff" /></View>
      </View>
    );
  }
  if (thumbnailUrl) return <Image source={{ uri: thumbnailUrl }} style={styles.replyThumbnail} resizeMode="cover" />;

  return (
    <View style={[styles.replyThumbnail, styles.replyThumbnailFallback]}>
      <Ionicons name={message.link_url ? 'link-outline' : 'chatbubble-outline'} size={18} color="#cbd5e1" />
    </View>
  );
};

// 🚀 Sincronizador Global de Tempo (Proteção contra hora errada no celular)
let globalTimeOffset = 0;
let isTimeSynced = false;

const syncTimeWithServer = async () => {
  if (isTimeSynced) return;
  try {
    const start = Date.now();

    // Tentativa 1: HEAD (Rápido, mas pode ser bloqueado por proxies/redes corporativas)
    let res = await fetch(`${SUPABASE_URL}/rest/v1/`, { method: 'HEAD' }).catch(() => null);

    // Tentativa 2: Fallback seguro com GET caso o HEAD falhe
    if (!res || !res.headers.get('date')) {
      res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
        method: 'GET',
        headers: { 'apikey': SUPABASE_ANON_KEY }
      }).catch(() => null);
    }

    const dateHeader = res?.headers.get('date');
    if (dateHeader) {
      const serverTime = new Date(dateHeader).getTime();
      const latency = (Date.now() - start) / 2; // Desconta o atraso da internet
      globalTimeOffset = serverTime - Date.now() + latency;
      isTimeSynced = true;
    }
  } catch (e) { console.warn('Falha na sincronização de tempo', e); }
};
const getSyncedTime = () => Date.now() + globalTimeOffset;

// 🚀 COMPONENTE DO PLAYER DE ÁUDIO — visual estilo WhatsApp (botão circular + "forma de onda")
// Extraído para fora do componente principal e recebendo tudo via props: assim ele sempre
// renderiza com os dados mais recentes de reprodução, corrigindo o slider que não acompanhava o áudio.
const AudioBubble = React.memo(({ item, width, isThisAudioLoaded, isPlaying, positionMillis, durationMillis, onToggle, onSeek, timeString, timeColor, statusIcon, isMyMessage, accentColor, accentTextColor }) => {
  const progress = isThisAudioLoaded && durationMillis > 0 ? positionMillis / durationMillis : 0;
  const bars = React.useMemo(() => generateWaveformBars(item.id), [item.id]);
  const [waveformWidth, setWaveformWidth] = useState(0);

  const handleWaveformPress = (e) => {
    if (!waveformWidth) return;
    const x = e.nativeEvent.locationX;
    const ratio = Math.max(0, Math.min(1, x / waveformWidth));
    onSeek(ratio);
  };

  return (
    <View style={[styles.audioBubble, { width }]}>
      <TouchableOpacity onPress={() => onToggle(item)} style={[styles.audioPlayCircle, { backgroundColor: accentColor }]} activeOpacity={0.8}>
        <Ionicons name={isPlaying ? 'pause' : 'play'} size={18} color={accentTextColor} style={!isPlaying && { marginLeft: 2 }} />
      </TouchableOpacity>
      <View style={styles.audioContentContainer}>
        <TouchableOpacity
          activeOpacity={1}
          onPress={handleWaveformPress}
          onLayout={(e) => setWaveformWidth(e.nativeEvent.layout.width)}
          style={styles.waveformContainer}
        >
          {bars.map((h, i) => {
            const barPosition = bars.length > 1 ? i / (bars.length - 1) : 0;
            const isPast = barPosition <= progress;
            return (
              <View
                key={i}
                style={[
                  styles.waveformBar,
                  { height: h, backgroundColor: isPast ? accentColor : 'rgba(255,255,255,0.25)' }
                ]}
              />
            );
          })}
        </TouchableOpacity>
        <View style={styles.audioFooter}>
          <Text style={styles.audioDurationText}>
            {isThisAudioLoaded && positionMillis > 0 ? formatAudioMillis(positionMillis) : (item.content || '0:00')}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={[styles.messageTime, { color: timeColor }]}>{timeString}</Text>
            {isMyMessage && statusIcon}
          </View>
        </View>
      </View>
    </View>
  );
});

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
          <Ionicons name="arrow-undo" size={14} color={DEFAULT_APP_THEME_COLOR} />
        </View>
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX: pan }], width: '100%' }} {...panResponder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
};

export default function ChatRoomScreen({ onBack, userCode, friendCode, friendName, setPickerActive, onUserActivity, privacyBypassEnabled, onTogglePrivacyBypass }) {
  const toast = useToast();
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const inputTextRef = useRef(''); // 🚀 Captura instantânea do texto para evitar perda de palavras
  const textInputRef = useRef(null); // 🚀 Controle direto do foco do teclado
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  const [currentFriendName, setCurrentFriendName] = useState(friendName);
  const [groupInfoVisible, setGroupInfoVisible] = useState(false);
  const [groupInfo, setGroupInfo] = useState(null);
  const [groupMembers, setGroupMembers] = useState([]);
  const [groupDescriptionDraft, setGroupDescriptionDraft] = useState('');
  const [savingGroupDescription, setSavingGroupDescription] = useState(false);
  const [groupNameDraft, setGroupNameDraft] = useState('');
  const [groupPhotoDraft, setGroupPhotoDraft] = useState(null);
  const [savingGroupDetails, setSavingGroupDetails] = useState(false);
  const isEditingGroupInfoRef = useRef(false);
  const [topMenuVisible, setTopMenuVisible] = useState(false);
  const [aiMenuVisible, setAiMenuVisible] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiModel, setAiModel] = useState(GEMINI_MODELS[0]);
  const [aiName, setAiName] = useState(DEFAULT_AI_NAME);
  const [aiSystemPrompt, setAiSystemPrompt] = useState('Responda em português brasileiro, de forma útil e natural, participando da conversa como Gemini.');
  const [aiTrigger, setAiTrigger] = useState('@/'); 
  const [aiTimeoutSeconds, setAiTimeoutSeconds] = useState(String(AI_DEFAULT_TIMEOUT_SECONDS));
  const [aiMaxRetries, setAiMaxRetries] = useState(String(AI_DEFAULT_MAX_RETRIES));
  const [isAiResponding, setIsAiResponding] = useState(false);
  const [aiSettingsLoaded, setAiSettingsLoaded] = useState(false);
  const [attachMenuVisible, setAttachMenuVisible] = useState(false);
  const [editNameVisible, setEditNameVisible] = useState(false);
  const [newNameInput, setNewNameInput] = useState(friendName);
  const [replyingTo, setReplyingTo] = useState(null);
  const [fullscreenImage, setFullscreenImage] = useState(null);
  const [fullscreenVideo, setFullscreenVideo] = useState(null);
  const [fullscreenMediaList, setFullscreenMediaList] = useState([]); // 🚀 Lista de mídias para navegação
  const [fullscreenMediaIndex, setFullscreenMediaIndex] = useState(0); // 🚀 Índice da mídia atual

  const [reactionTargetMessage, setReactionTargetMessage] = useState(null);
  const [showCustomEmojiInput, setShowCustomEmojiInput] = useState(false);
  const [infoModalMessage, setInfoModalMessage] = useState(null);
  const [mediaGalleryVisible, setMediaGalleryVisible] = useState(false);
  const [mediaGalleryTab, setMediaGalleryTab] = useState('media');
  const [galleryMessages, setGalleryMessages] = useState(null);
  const [loadingGalleryMessages, setLoadingGalleryMessages] = useState(false);
  const [showBlueTicks, setShowBlueTicks] = useState(false);
  const showBlueTicksRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [recentEmojis, setRecentEmojis] = useState(['👍', '❤️', '😂', '😮', '😢', '🙏']);
  const [friendLastSeen, setFriendLastSeen] = useState(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState(null);
  const [scrollTarget, setScrollTarget] = useState(null);
  const [replyTargets, setReplyTargets] = useState({});
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [messageSearchQuery, setMessageSearchQuery] = useState('');
  const [settledMessageSearchQuery, setSettledMessageSearchQuery] = useState('');
  const [serverSearchResults, setServerSearchResults] = useState([]);
  const [searchResultIndex, setSearchResultIndex] = useState(0);
  const [hasOlderMessages, setHasOlderMessages] = useState(true);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const messageSearchInputRef = useRef(null);
  const messageSearchRequestRef = useRef(0);
  const [renderKey, setRenderKey] = useState(0);
  const [pinnedMessage, setPinnedMessage] = useState(null);

  // 🚀 ESTADOS DE GRAVAÇÃO E REPRODUÇÃO DE ÁUDIO
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false); // 🚀 Indica se a gravação de áudio está pausada
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [currentlyPlaying, setCurrentlyPlaying] = useState(null); // id da mensagem de áudio tocando
  const [playbackStatus, setPlaybackStatus] = useState(null);
  const [revealedSpoilers, setRevealedSpoilers] = useState(new Set());

  // 🚀 ESTADOS DE PRÉ-VISUALIZAÇÃO DO ÁUDIO GRAVADO (antes de enviar, estilo WhatsApp)
  const [recordedPreview, setRecordedPreview] = useState(null); // { uri, duration, size }
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [previewStatus, setPreviewStatus] = useState(null);
  const previewSoundRef = useRef(new Audio.Sound());

  // 🚀 ESTADOS DE SUGESTÃO DE STICKER (Como no WhatsApp/Telegram)
  const [emojiSuggestions, setEmojiSuggestions] = useState([]);
  const [showEmojiSuggestions, setShowEmojiSuggestions] = useState(false);
  const emojiSuggestionTimeout = useRef(null);
  const emojiSuggestionOffsetRef = useRef(0);
  const emojiSuggestionSearchRef = useRef('');
  const emojiSuggestionLoadingRef = useRef(false);
  const emojiSuggestionHasMoreRef = useRef(true);
  const emojiSuggestionRequestRef = useRef(0);

  // 🚀 ESTADOS DO NOVO MODAL DE AÇÃO DE STICKER (Estilo WhatsApp)
  const [stickerActionModalVisible, setStickerActionModalVisible] = useState(false);
  const [selectedSticker, setSelectedSticker] = useState(null); // { url: string, isFavorite: boolean, message: object }

  const cleanFriendCode = friendCode.trim().toLowerCase();
  const isGroupChat = isGroupToken(cleanFriendCode);
  const groupId = isGroupChat ? cleanFriendCode.slice(GROUP_PREFIX.length) : null;
  const roomKey = isGroupChat ? cleanFriendCode : [userCode.trim().toLowerCase(), cleanFriendCode].sort().join('-');

  useEffect(() => {
    if (!mediaGalleryVisible) return;
    let cancelled = false;
    const loadGalleryMessages = async () => {
      setLoadingGalleryMessages(true);
      try {
        const clearedStr = await AsyncStorage.getItem(`@cleared_${userCode}_${friendCode}`);
        const clearedTime = clearedStr ? new Date(clearedStr).getTime() : 0;
        const myCode = userCode.trim().toLowerCase();
        const frCode = friendCode.trim().toLowerCase();
        const roomFilter = isGroupChat
          ? `receiver_code.eq.${frCode}`
          : `and(sender_code.eq.${myCode},receiver_code.eq.${frCode}),and(sender_code.eq.${frCode},receiver_code.eq.${myCode}),and(sender_code.eq.${AI_SENDER_CODE},receiver_code.eq.${roomKey})`;
        const allMessages = [];
        const pageSize = 500;
        for (let from = 0; ; from += pageSize) {
          const { data, error } = await supabase.from('mensagens').select('*').or(roomFilter).order('created_at', { ascending: false }).range(from, from + pageSize - 1);
          if (error) throw error;
          allMessages.push(...(data || []));
          if (!data || data.length < pageSize) break;
        }
        if (!cancelled) setGalleryMessages(allMessages.filter(m => new Date(m.created_at).getTime() > clearedTime));
      } catch (error) {
        console.warn('Erro ao carregar galeria completa:', error);
        if (!cancelled) setGalleryMessages(null);
      } finally {
        if (!cancelled) setLoadingGalleryMessages(false);
      }
    };
    loadGalleryMessages();
    return () => { cancelled = true; };
  }, [mediaGalleryVisible, userCode, friendCode, isGroupChat, roomKey]);
  const recordingRef = useRef(null);
  const recordingTimerRef = useRef(null);
  const audioPlayerRef = useRef(new Audio.Sound());
  const recordingDragX = useRef(new Animated.Value(0)).current;
  const [isRecordingCancelArmed, setIsRecordingCancelArmed] = useState(false);
  const recordingCancelThreshold = -95;
  const recordingPanResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, gestureState) => Math.abs(gestureState.dx) > 8 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
    onPanResponderMove: (_, gestureState) => {
      const dragX = Math.min(0, Math.max(gestureState.dx, -150));
      recordingDragX.setValue(dragX);
      setIsRecordingCancelArmed(dragX <= recordingCancelThreshold);
    },
    onPanResponderRelease: (_, gestureState) => {
      if (gestureState.dx <= recordingCancelThreshold) {
        Animated.timing(recordingDragX, { toValue: -180, duration: 140, useNativeDriver: true }).start(() => {
          recordingDragX.setValue(0);
          setIsRecordingCancelArmed(false);
          handleCancelRecording();
          toast('Gravação cancelada.');
        });
        return;
      }

      Animated.spring(recordingDragX, { toValue: 0, damping: 16, stiffness: 180, useNativeDriver: true }).start();
      setIsRecordingCancelArmed(false);
    },
    onPanResponderTerminate: () => {
      Animated.spring(recordingDragX, { toValue: 0, damping: 16, stiffness: 180, useNativeDriver: true }).start();
      setIsRecordingCancelArmed(false);
    },
  })).current;


  // 🚀 LÓGICA DE EXCEÇÃO DE PRIVACIDADE: Libera o print/gravação de tela APENAS ao ver mídias em tela cheia
  useEffect(() => {
    const toggleScreenCapture = async () => {
      if (Platform.OS === 'web') return; // Evita crash no navegador
      try {
        if (fullscreenImage || fullscreenVideo) {
          await ScreenCapture.allowScreenCaptureAsync(); // Desliga o escudo
        } else {
          await ScreenCapture.preventScreenCaptureAsync(); // Religa o escudo ao fechar a mídia
        }
      } catch (e) {
        console.warn('Erro ao alternar proteção de tela:', e);
      }
    };
    toggleScreenCapture();
  }, [fullscreenImage, fullscreenVideo]);

  // 🚀 LÓGICA DE BOTÃO VOLTAR: Fecha a mídia em tela cheia se estiver aberta ao invés de sair do chat
  useEffect(() => {
    const backAction = () => {
      if (fullscreenImage) {
        setFullscreenImage(null);
        return true;
      }
      if (fullscreenVideo) {
        setFullscreenVideo(null);
        return true;
      }
      return false; // Permite que o botão Voltar faça o comportamento padrão (sair do chat) se as mídias estiverem fechadas
    };
    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => backHandler.remove();
  }, [fullscreenImage, fullscreenVideo]);

  // 🚀 EFEITO: Descarrega o player de áudio e a gravação ao sair da tela para liberar memória
  useEffect(() => {
    return () => {
      audioPlayerRef.current.unloadAsync().catch(() => {});
      previewSoundRef.current.unloadAsync().catch(() => {}); // 🚀 Descarrega também o player de pré-visualização
      // 🚀 Garante que a gravação seja interrompida e liberada se o usuário sair da tela
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
      }
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setAiSettingsLoaded(false);
    const loadAiSettings = async () => {
      try {
        const saved = await AsyncStorage.getItem(`@gemini_ai_settings_${userCode}`);
        if (saved) {
          const parsed = JSON.parse(saved);
          setAiEnabled(!!parsed.enabled);
          setAiApiKey(parsed.apiKey || '');
          setAiModel(parsed.model || GEMINI_MODELS[0]);
          setAiName(parsed.name || DEFAULT_AI_NAME);
          setAiSystemPrompt(parsed.systemPrompt || 'Responda em português brasileiro, de forma útil e natural, participando da conversa como Gemini.');
          setAiTrigger(parsed.trigger || '@/');
          setAiTimeoutSeconds(String(parsed.timeoutSeconds || AI_DEFAULT_TIMEOUT_SECONDS));
          setAiMaxRetries(String(parsed.maxRetries ?? AI_DEFAULT_MAX_RETRIES));
        }
      } catch (err) {
        console.warn('Erro ao carregar configurações da IA:', err);
      } finally {
        setAiSettingsLoaded(true);
      }
    };

    loadAiSettings();
  }, [userCode]);

  useEffect(() => {
    if (!aiSettingsLoaded) return;
    AsyncStorage.setItem(`@gemini_ai_settings_${userCode}`, JSON.stringify({
      enabled: aiEnabled,
      apiKey: aiApiKey,
      model: aiModel,
      name: aiName,
      systemPrompt: aiSystemPrompt,
      trigger: aiTrigger,
      timeoutSeconds: Number(aiTimeoutSeconds) || AI_DEFAULT_TIMEOUT_SECONDS,
      maxRetries: Number(aiMaxRetries) || AI_DEFAULT_MAX_RETRIES,
    })).catch((err) => console.warn('Erro ao salvar configurações da IA:', err));
  }, [userCode, aiEnabled, aiApiKey, aiModel, aiName, aiSystemPrompt, aiTrigger, aiTimeoutSeconds, aiMaxRetries, aiSettingsLoaded]);


  const fetchPinnedMessage = async () => {
    try {
      // 🚀 Mudamos maybeSingle() para limit(1) que NUNCA trava, mesmo se houver pins duplicados no banco
      const { data: pinDataList, error: pinError } = await supabase
        .from('pins')
        .select('*')
        .eq('room_key', roomKey)
        .limit(1)

      if (pinError || !pinDataList || pinDataList.length === 0 || !pinDataList[0]?.message_id) {
        setPinnedMessage(null);
        return;
      }

      const { data: msgDataList, error: msgError } = await supabase
        .from('mensagens')
        .select('*')
        .eq('id', pinDataList[0].message_id)
        .limit(1);

      if (!msgError && msgDataList && msgDataList.length > 0) {
        setPinnedMessage(msgDataList[0]);
      } else {
        // 🚀 Removemos a autodeleção do pin para evitar que instabilidades na internet o apagassem acidentalmente
        setPinnedMessage(null);
      }
    } catch (e) {
      console.warn('Erro ao buscar pin:', e);
    }
  };

  const handlePinMessage = async (message) => {
    // 🚀 Previne o app de tentar fixar uma mensagem que ainda está na fila de envio ou sem ID oficial
    if (message.status === 'sending' || message.status === 'failed' || String(message.id).startsWith('pending') || String(message.id).startsWith('temp')) {
      toast('Aguarde a mensagem ser enviada e confirmada pelo servidor antes de fixá-la.');
      return;
    }

    if (pinnedMessage?.id === message.id) return handleUnpinMessage();
    try {
      // 🚀 Excluímos o pin antigo manualmente para garantir que não haja duplicidade sem precisar de restrições em SQL
      await supabase.from('pins').delete().eq('room_key', roomKey);

      const { error } = await supabase.from('pins').insert([
        { message_id: message.id, pinned_by: userCode, room_key: roomKey }
      ]);

      if (error) throw error;

      setPinnedMessage(message);
      setInfoModalMessage(null);
      setReactionTargetMessage(null);
    } catch (e) {
      console.warn('Erro ao fixar:', e);
      toast(`Falha do Servidor: ${e.message || 'A mensagem não pôde ser fixada.'}`, { tone: 'error' });
    }
  };

  const handleUnpinMessage = async () => {
    try {
      await supabase.from('pins').delete().eq('room_key', roomKey);
      setPinnedMessage(null);
      setInfoModalMessage(null);
      setReactionTargetMessage(null);
    } catch (e) { console.warn('Erro ao desafixar:', e); }
  };

  const getDateLabel = (isoString) => {
    if (!isoString) return '';
    const date = new Date(isoString);
    const today = new Date(getSyncedTime());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const isSameDay = (a, b) => a.getDate() === b.getDate() && a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
    if (isSameDay(date, today)) return 'Hoje';
    if (isSameDay(date, yesterday)) return 'Ontem';
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  };

  const setShowBlueTicksSynced = (val) => {
    showBlueTicksRef.current = val;
    setShowBlueTicks(val);
  };

  // 🚀 ESTADOS DE GIPHY (STICKERS)
  const [giphyModalVisible, setGiphyModalVisible] = useState(false);
  const [giphySearch, setGiphySearch] = useState('');
  const [giphyResults, setGiphyResults] = useState([]);
  const [isSearchingGiphy, setIsSearchingGiphy] = useState(false);
  const [isFetchingMoreGiphy, setIsFetchingMoreGiphy] = useState(false);
  const [giphyOffset, setGiphyOffset] = useState(0);
  const [giphyError, setGiphyError] = useState(null);
  const [recentGifs, setRecentGifs] = useState([]);
  const [favoriteGifs, setFavoriteGifs] = useState([]); // 🚀 Favoritos
  const [giphyTab, setGiphyTab] = useState('recent'); // 'search', 'recent' ou 'favorites'
  const GIPHY_API_KEY = process.env.EXPO_PUBLIC_GIPHY_API_KEY;
  const GIPHY_PAGE_LIMIT = 24;

  // 🚀 ESTADOS DE PERSONALIZAÇÃO (CORES RGB)
  const [chatBackground, setChatBackground] = useState(null);
  const [myBubbleColor, setMyBubbleColor] = useState('#1E293B');
  const [theirBubbleColor, setTheirBubbleColor] = useState('#0d0d0d');
  const [customizeModalVisible, setCustomizeModalVisible] = useState(false);

  const [pendingQueue, setPendingQueue] = useState([]);
  const pendingQueueRef = useRef([]);

  const setPendingQueueSynced = (updater) => {
    setPendingQueue(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      pendingQueueRef.current = next; // 🚀 Atualiza a referência em tempo real, furando a fila do ciclo de render
      return next;
    });
  };
  const lastMessageTimeRef = useRef(Date.now());

  const shortTimer = useRef(null);
  const longTimer = useRef(null);
  const hasTriggeredShort = useRef(false);
  const hasTriggeredLong = useRef(false);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const isScrolling = useRef(false);
  const marcarLidasDebounceRef = useRef(null);

  // 🚀 LÓGICA DE VISTO POR ÚLTIMO
  const formatLastSeen = (isoString) => {
    if (!isoString) return '';
    const date = new Date(isoString);
    const today = new Date(getSyncedTime());
    const isToday = date.getDate() === today.getDate() && date.getMonth() === today.getMonth() && date.getFullYear() === today.getFullYear();

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = date.getDate() === yesterday.getDate() && date.getMonth() === yesterday.getMonth() && date.getFullYear() === yesterday.getFullYear();

    const timeStr = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (isToday) return `visto por último hoje às ${timeStr}`;
    if (isYesterday) return `visto por último ontem às ${timeStr}`;
    return `visto por último em ${date.toLocaleDateString('pt-BR', {day: '2-digit', month: '2-digit'})} às ${timeStr}`;
  };

  const flatListRef = useRef();
  const scrollRequestRef = useRef(0);
  const scrollRetryRef = useRef(null);
  const scrollRetryCountRef = useRef(0);
  const channelRef = useRef(null);
  const messagesOffsetRef = useRef(0);
  const loadingOlderMessagesRef = useRef(false);
  const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions();
  // Mantém os controles nativos do vídeo acima dos botões virtuais do Android.
  const androidNavigationInset = Platform.OS === 'android'
    ? Math.max(48, Dimensions.get('screen').height - SCREEN_HEIGHT)
    : 0;
  const IMAGE_SIZE = Math.min(SCREEN_WIDTH * 0.65, 320);
  const AUDIO_BUBBLE_WIDTH = Math.min(SCREEN_WIDTH * 0.6, 280);
  const aiDisplayName = (aiName || DEFAULT_AI_NAME).trim() || DEFAULT_AI_NAME;

  useEffect(() => {
    // 🚀 Atualiza o SEU visto por último ao entrar no canal
    const updateMyLastSeen = () => {
      if (userCode) {
        supabase.from('perfis').update({ last_seen: new Date().toISOString() }).eq('connection_code', userCode.trim().toLowerCase()).then();
      }
    };
    updateMyLastSeen();

    syncTimeWithServer(); // Inicia a sincronização assim que abre a tela
    const initializeChatState = async () => {
      try {
        const savedDraft = await AsyncStorage.getItem(`@draft_${userCode}_${friendCode}`);
        if (savedDraft) {
          setInputText(savedDraft);
          inputTextRef.current = savedDraft; // 🚀 Sincroniza a referência
        }

        const storedQueue = await AsyncStorage.getItem(`@queue_${userCode}_${friendCode}`);
        if (storedQueue) {
          const parsed = JSON.parse(storedQueue);
          setPendingQueueSynced(parsed);
        }

        const devMode = await AsyncStorage.getItem('@dev_mode');
        setShowBlueTicks(devMode === 'true');
        setShowBlueTicksSynced(devMode === 'true');

        // Carrega as cores salvas deste chat específico
        const savedBg = await AsyncStorage.getItem(`@bg_${userCode}_${friendCode}`);
        const savedMy = await AsyncStorage.getItem(`@myBubble_${userCode}_${friendCode}`);
        const savedTheir = await AsyncStorage.getItem(`@theirBubble_${userCode}_${friendCode}`);
        if (savedBg && !savedBg.startsWith('#')) setChatBackground(savedBg);
        if (savedMy) setMyBubbleColor(savedMy);
        if (savedTheir) setTheirBubbleColor(savedTheir);

        const savedEmojis = await AsyncStorage.getItem('@recent_emojis');
        if (savedEmojis) setRecentEmojis(JSON.parse(savedEmojis));

        const savedGifs = await AsyncStorage.getItem('@recent_gifs');
        const savedFavs = await AsyncStorage.getItem('@favorite_gifs'); // 🚀 Carrega favoritos
        const localRecentGifs = savedGifs ? JSON.parse(savedGifs) : [];
        const localFavoriteGifs = savedFavs ? JSON.parse(savedFavs) : [];

        const [profileResult, stickerResult] = await Promise.all([
          supabase
            .from('perfis')
            .select('favorite_gifs')
            .eq('connection_code', userCode.trim().toLowerCase())
            .maybeSingle(),
          supabase
            .from('mensagens')
            .select('media_url')
            .eq('sender_code', userCode.trim().toLowerCase())
            .eq('media_type', 'sticker')
            .not('media_url', 'is', null)
            .order('created_at', { ascending: false })
            .limit(60),
        ]);

        const cloudFavoriteGifs = !profileResult.error && Array.isArray(profileResult.data?.favorite_gifs)
          ? profileResult.data.favorite_gifs.filter(Boolean)
          : [];
        const mergedFavoriteGifs = [...new Set([...cloudFavoriteGifs, ...localFavoriteGifs])];
        setFavoriteGifs(mergedFavoriteGifs);
        AsyncStorage.setItem('@favorite_gifs', JSON.stringify(mergedFavoriteGifs)).catch(() => {});
        if (!profileResult.error && mergedFavoriteGifs.length !== cloudFavoriteGifs.length) {
          supabase.from('perfis').update({ favorite_gifs: mergedFavoriteGifs })
            .eq('connection_code', userCode.trim().toLowerCase())
            .then(() => {});
        }

        const cloudRecentGifs = !stickerResult.error
          ? (stickerResult.data || []).map(message => message.media_url).filter(Boolean)
          : [];
        setRecentGifs([...new Set([...cloudRecentGifs, ...localRecentGifs])].slice(0, 60));
      } catch (e) { console.error(e); }
    };
    initializeChatState();

    // 🚀 Atualiza o SEU visto por último exato ao sair do canal (voltar pra lista)
    return () => {
      updateMyLastSeen();
    };
  }, [userCode, friendCode, roomKey]);

  // 🚀 Lógica de Busca de Stickers (Giphy)
  useEffect(() => {
    // Quando a busca muda, reseta os resultados e a paginação (Giphy)
    setGiphyResults([]);
    setGiphyOffset(0);
  }, [giphySearch]);

  useEffect(() => {
    const searchTerm = giphySearch.trim();

    const delayDebounce = setTimeout(() => {
      if (!giphyModalVisible || giphyTab !== 'search') return;

      // 🚀 OTIMIZAÇÃO: Só busca se o termo tiver 3+ caracteres ou se estiver vazio (para trending)
      if (searchTerm.length > 0 && searchTerm.length < 3) {
        setGiphyResults([]); // Limpa resultados para buscas curtas
        setGiphyError(null);
        return;
      }

      // 🚀 OTIMIZAÇÃO 2: Não busca "trending" de novo se já tiver resultados na tela.
      // Isso evita requisições desnecessárias ao reabrir o modal ou trocar de abas.
      if (searchTerm.length === 0 && giphyResults.length > 0) {
        return;
      }

      setIsSearchingGiphy(true);
      fetchGiphy(true); // `true` para indicar que é uma nova busca (reset)
    }, 800); // 🚀 Aumentado o debounce para 800ms para economizar requisições

    return () => clearTimeout(delayDebounce);
  }, [giphySearch, giphyModalVisible, giphyTab]);

  const fetchGiphy = (isNewSearch = false) => {
    if (isFetchingMoreGiphy) return;
    if (isNewSearch) {
      setIsSearchingGiphy(true);
    } else {
      setIsFetchingMoreGiphy(true);
    }
    setGiphyError(null);

    const currentOffset = isNewSearch ? 0 : giphyOffset;
    const endpoint = giphySearch.trim().length > 0
      ? `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(giphySearch)}&limit=${GIPHY_PAGE_LIMIT}&offset=${currentOffset}&rating=pg`
      : `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_API_KEY}&limit=${GIPHY_PAGE_LIMIT}&offset=${currentOffset}&rating=pg`;

    fetch(endpoint)
      .then(res => res.json())
      .then(data => {
        if (data.meta && data.meta.status !== 200) {
          setGiphyError(`API: ${data.meta.msg} (Status: ${data.meta.status})`);
        }
        const newResults = data.data || [];
        setGiphyResults(prev => isNewSearch ? newResults : [...prev, ...newResults]);
        setGiphyOffset(currentOffset + GIPHY_PAGE_LIMIT);
      })
      .catch(err => {
        setGiphyError(`Erro de Conexão: ${err.message}`);
        if (isNewSearch) setGiphyResults([]);
      })
      .finally(() => {
        setIsSearchingGiphy(false);
        setIsFetchingMoreGiphy(false);
      });
  };

  const handleSendSticker = async (stickerUrl) => {
    setGiphyModalVisible(false);

    // 🚀 Salva a figurinha nos Recentes (sem limite)
    setRecentGifs(prev => {
      const updated = [stickerUrl, ...prev.filter(g => g !== stickerUrl)];
      AsyncStorage.setItem('@recent_gifs', JSON.stringify(updated)).catch(() => {});
      return updated;
    });

    // 🚀 USA A FILA INTELIGENTE (Garante entrega instantânea e offline na sua tela)
    let newTime = getSyncedTime();
    if (newTime <= lastMessageTimeRef.current) newTime = lastMessageTimeRef.current + 1;
    lastMessageTimeRef.current = newTime;

    const newPendingMessage = {
      id: `pending-${newTime}-${Math.random()}`,
      content: '🎉 Sticker enviado',
      media_url: stickerUrl,
      media_type: 'sticker',
      sender_code: userCode,
      receiver_code: friendCode,
      reply_to_id: replyingTo?.id,
      created_at: new Date(newTime).toISOString(),
      status: 'sending'
    };

    setPendingQueueSynced(prev => [newPendingMessage, ...prev]);
    setReplyingTo(null);
  };

  // 🚀 Lógica para favoritar/desfavoritar GIFs com toque longo
  const handleToggleFavoriteGif = async (stickerUrl, showAlert = true) => {
    const isFavorited = favoriteGifs.includes(stickerUrl);
    let updated;
    if (isFavorited) {
      updated = favoriteGifs.filter(g => g !== stickerUrl);
      if (showAlert) toast('Removido dos Favoritos!');
    } else {
      updated = [stickerUrl, ...favoriteGifs];
      if (showAlert) toast('Adicionado aos Favoritos!');
    }
    setFavoriteGifs(updated);
    await AsyncStorage.setItem('@favorite_gifs', JSON.stringify(updated));
    const { error } = await supabase
      .from('perfis')
      .update({ favorite_gifs: updated })
      .eq('connection_code', userCode.trim().toLowerCase());
    if (error) console.warn('Nao foi possivel sincronizar favoritos:', error.message);
  };

  // 🚀 Abre o modal de ação ao clicar em um sticker
  const handleStickerPress = (stickerUrl, messageItem) => {
    const isFavorite = favoriteGifs.includes(stickerUrl);
    setSelectedSticker({ url: stickerUrl, isFavorite, message: messageItem });
    setStickerActionModalVisible(true);
  };

  const loadEmojiSuggestions = (searchTerm, reset = false) => {
    if (emojiSuggestionLoadingRef.current && !reset) return;
    if (!reset && !emojiSuggestionHasMoreRef.current) return;

    const requestId = reset ? emojiSuggestionRequestRef.current + 1 : emojiSuggestionRequestRef.current;
    const currentOffset = reset ? 0 : emojiSuggestionOffsetRef.current;
    if (reset) {
      emojiSuggestionRequestRef.current = requestId;
      emojiSuggestionSearchRef.current = searchTerm;
      emojiSuggestionOffsetRef.current = 0;
      emojiSuggestionHasMoreRef.current = true;
    }

    emojiSuggestionLoadingRef.current = true;
    fetch(`https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(searchTerm)}&limit=10&offset=${currentOffset}&rating=pg`)
      .then(res => res.json())
      .then(data => {
        if (requestId !== emojiSuggestionRequestRef.current || searchTerm !== emojiSuggestionSearchRef.current) return;
        const newResults = data.data || [];
        setEmojiSuggestions(prev => {
          if (reset) return newResults;
          const existingIds = new Set(prev.map(gif => gif.id));
          return [...prev, ...newResults.filter(gif => !existingIds.has(gif.id))];
        });
        emojiSuggestionOffsetRef.current = currentOffset + newResults.length;
        emojiSuggestionHasMoreRef.current = newResults.length === 10;
      })
      .catch(() => {
        if (requestId === emojiSuggestionRequestRef.current) emojiSuggestionHasMoreRef.current = false;
      })
      .finally(() => {
        emojiSuggestionLoadingRef.current = false;
      });
  };

  const fetchEmojiSuggestions = (text) => {
    const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D]/gu;
    const emojis = text.match(emojiRegex);

    if (!emojis || text.replace(emojiRegex, '').trim().length > 0) {
      setShowEmojiSuggestions(false);
      setEmojiSuggestions([]);
      emojiSuggestionRequestRef.current += 1;
      emojiSuggestionHasMoreRef.current = false;
      return;
    }

    setShowEmojiSuggestions(true);

    // Mapeamento simples de emoji para termo de busca
    const emojiMap = { '😂': 'laughing', '👍': 'thumbs up', '❤️': 'heart', '😢': 'crying', '🙏': 'praying', '🎉': 'party', '😊': 'smile', '🤔': 'thinking', '🤯': 'mind blown', '🔥': 'fire' };
    const lastEmoji = emojis[emojis.length - 1];
    const searchTerm = emojiMap[lastEmoji] || lastEmoji;
    emojiSuggestionSearchRef.current = searchTerm;
    emojiSuggestionRequestRef.current += 1;

    if (emojiSuggestionTimeout.current) clearTimeout(emojiSuggestionTimeout.current);
    emojiSuggestionTimeout.current = setTimeout(() => {
      loadEmojiSuggestions(searchTerm, true);
    }, 300);
  };

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
              setPendingQueueSynced(prev => prev.map(m => m.id === message.id ? { ...m, status: 'sending' } : m));
            }

            let finalMediaUrl = message.media_url;

            // 🚀 INTEGRAÇÃO: O UPLOAD AGORA É DEFERIDO PARA O QUEUEWORKER (FUNCIONA OFFLINE E COM RETRIES!)
            if (message.needs_upload) {
              let ext, mimeType, filename;
              const tempTime = new Date(message.created_at).getTime();
              const randomSuffix = Math.floor(Math.random() * 1000);

              if (message.media_type === 'document') {
                const originalFilename = (message.content || '|').split('|')[0];
                ext = originalFilename.split('.').pop() || 'bin';
                mimeType = '*/*'; // Deixa o Supabase inferir pelo nome do arquivo
                filename = `${message.sender_code}-${tempTime}-${randomSuffix}.${ext}`;
              } else { // Imagem ou Vídeo
                const sourceName = message.media_file_name || '';
                const sourceExt = sourceName.split('.').pop()?.toLowerCase();
                const isVideo = message.media_type?.startsWith('video');
                ext = sourceExt && /^[a-z0-9]{2,5}$/.test(sourceExt) ? sourceExt : (isVideo ? 'mp4' : 'jpg');
                mimeType = message.media_mime_type || (isVideo ? 'video/mp4' : 'image/jpeg');
                filename = `${message.sender_code}-${tempTime}-${randomSuffix}.${ext}`;
              }

              let fileBody;
              try {
                const base64 = await FileSystem.readAsStringAsync(message.media_url, { encoding: 'base64' });
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
                // O cliente do Supabase no React Native precisa receber o ArrayBuffer.
                // Enviar o Uint8Array pode gravar um objeto inválido, especialmente em vídeos.
                fileBody = bytes.buffer;
              } catch (fsErr) {
                fileBody = new FormData();
                fileBody.append('file', {
                  uri: Platform.OS === 'ios' ? message.media_url.replace('file://', '') : message.media_url,
                  name: filename,
                  type: mimeType,
                });
              }

              const uploadPromise = supabase.storage.from('chat-media').upload(filename, fileBody, {
                contentType: mimeType,
                upsert: false
              });

              // 🚀 FIX: Proteção de Timeout também no Upload para não travar toda a fila de mensagens
              let uploadTimeoutId;
              const uploadTimeoutPromise = new Promise((_, reject) => {
                uploadTimeoutId = setTimeout(() => reject(new Error('Timeout no upload da mídia')), 30000);
              });

              const { error: uploadError } = await Promise.race([uploadPromise, uploadTimeoutPromise]).catch(err => {
                clearTimeout(uploadTimeoutId);
                throw err;
              });
              clearTimeout(uploadTimeoutId);
              if (uploadError) throw uploadError;

              finalMediaUrl = `${SUPABASE_URL}/storage/v1/object/public/chat-media/${filename}`;

              // Remove a flag de upload para que, se a inserção no banco falhar, o app não upe a foto repetida vezes no storage
              setPendingQueueSynced(prev => prev.map(m => m.id === message.id ? { ...m, media_url: finalMediaUrl, needs_upload: false } : m));
            }

            const payload = {
              sender_code: message.sender_code,
              receiver_code: message.receiver_code,
              content: message.content,
              reply_to_id: message.reply_to_id
            };
            if (finalMediaUrl) payload.media_url = finalMediaUrl;
            if (message.media_type) payload.media_type = message.media_type;

            const insertPromise = supabase.from('mensagens').insert([payload]).select().single();

            // 🚀 CORREÇÃO DA BOMBA-RELÓGIO: Limpa o timeout para não causar crash silencioso no motor de Tempo Real
            let timeoutId;
            const timeoutPromise = new Promise((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error('Timeout de rede')), 30000); // 🚀 Aumentado para 30s (ajuda no 3G/4G ruim)
            });

            const res = await Promise.race([insertPromise, timeoutPromise]).catch(err => {
              clearTimeout(timeoutId);
              throw err;
            });
            clearTimeout(timeoutId);

            const { data, error } = res;
            if (error) throw error;

            requestAndSaveLinkPreview(data);

            // 🚀 SUCESSO ABSOLUTO! Remove da fila e transfere para a tela de chat na hora
            setPendingQueueSynced(prev => prev.filter(m => m.id !== message.id));
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
              setPendingQueueSynced(prev => prev.map(m => m.id === message.id ? { ...m, status: 'failed' } : m));
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
  }, [userCode, friendCode]); // 🚀 CORREÇÃO: Impede falha na fila ao trocar de chats

  useEffect(() => {
    // Busca o visto por último inicial do contato
    const fetchFriendStatus = async () => {
      try {
        if (isGroupChat) return;
        const cleanFriendCode = friendCode.trim().toLowerCase();
        const { data } = await supabase.from('perfis').select('last_seen').eq('connection_code', cleanFriendCode).maybeSingle();
        if (data && data.last_seen) setFriendLastSeen(data.last_seen);
      } catch(e) {}
    };
    fetchFriendStatus();

    const fetchMessages = async () => {
      // 🚀 CACHE: Carrega mensagens da memória para não deixar a tela vazia sem internet
      try {
        const cached = await AsyncStorage.getItem(`@cache_msgs_${userCode}_${friendCode}`);
        if (cached) setMessages(JSON.parse(cached));
      } catch (e) {}

      try {
        const clearedStr = await AsyncStorage.getItem(`@cleared_${userCode}_${friendCode}`);
        const clearedTime = clearedStr ? new Date(clearedStr).getTime() : 0;

        const myCode = userCode.trim().toLowerCase();
        const frCode = friendCode.trim().toLowerCase();

        const roomFilter = isGroupChat
          ? `receiver_code.eq.${frCode}`
          : `and(sender_code.eq.${myCode},receiver_code.eq.${frCode}),and(sender_code.eq.${frCode},receiver_code.eq.${myCode}),and(sender_code.eq.${AI_SENDER_CODE},receiver_code.eq.${roomKey})`;
        const allData = [];
        for (let from = 0; ; from += MESSAGE_PAGE_SIZE) {
          const { data, error } = await supabase
            .from('mensagens')
            .select('*')
            .or(roomFilter)
            .order('created_at', { ascending: false })
            .range(from, from + MESSAGE_PAGE_SIZE - 1);
          if (error) throw error;
          allData.push(...(data || []));
          if (!data || data.length < MESSAGE_PAGE_SIZE) break;
        }

        {
          const filteredData = allData.filter(m => new Date(m.created_at).getTime() > clearedTime);
          setMessages(filteredData);
          messagesOffsetRef.current = allData.length;
          setHasOlderMessages(false);
          AsyncStorage.setItem(`@cache_msgs_${userCode}_${friendCode}`, JSON.stringify(filteredData.slice(0, 60))).catch(() => {});
          filteredData
            .filter(message => !message.media_url && message.content && !(message.link_url || message.preview_title || message.preview_description || message.preview_image_url || message.preview_site_name))
            .forEach(message => requestAndSaveLinkPreview(message));
          marcarComoLidas();
        }
      } catch (err) { console.error(err); } finally { setLoading(false); }
    };

    fetchMessages();
    fetchPinnedMessage();

    const subscription = supabase
      .channel(`room-${roomKey}`, { config: { broadcast: { ack: true } } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mensagens' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const newMsg = payload.new;
          const isRoomMessage =
            (isGroupChat && newMsg.receiver_code === friendCode) ||
            (!isGroupChat && (
              (newMsg.sender_code === userCode && newMsg.receiver_code === friendCode) ||
              (newMsg.sender_code === friendCode && newMsg.receiver_code === userCode) ||
              (newMsg.sender_code === AI_SENDER_CODE && newMsg.receiver_code === roomKey)
            ));
          if (isRoomMessage) {
            setMessages((prev) => {
              if (prev.some(m => m.id === newMsg.id)) return prev; // Evita duplicatas
              const updated = [newMsg, ...prev]; // Prepend a nova mensagem para FlatList invertida
              AsyncStorage.setItem(`@cache_msgs_${userCode}_${friendCode}`, JSON.stringify(updated.slice(0, 60))).catch(() => {});
              return updated;
            });
            if (newMsg.sender_code === userCode) {
              setPendingQueueSynced(prev => {
                const matchIndex = prev.findIndex(m => new Date(m.created_at).getTime() === new Date(newMsg.created_at).getTime());
                if (matchIndex > -1) {
                  const newQueue = [...prev];
                  newQueue.splice(matchIndex, 1);
                  return newQueue;
                }
                return prev;
              });
            }
            if (!isGroupChat && newMsg.receiver_code === userCode) marcarComoLidas();
          }
        }
        if (payload.eventType === 'DELETE') {
          setMessages((prev) => prev.filter((msg) => msg.id !== payload.old.id));
        }
        if (payload.eventType === 'UPDATE') {
          setMessages((prev) => prev.map((msg) => (msg.id === payload.new.id ? payload.new : msg)));
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'perfis', filter: `connection_code=eq.${friendCode.trim().toLowerCase()}` }, (payload) => {
        if (payload.new && payload.new.last_seen) setFriendLastSeen(payload.new.last_seen);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pins', filter: `room_key=eq.${roomKey}` }, (payload) => {
        if (payload.eventType === 'DELETE') setPinnedMessage(null);
        if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') fetchPinnedMessage();
      })
      .subscribe((status) => {
        console.log('Canal status:', status);
      });

    const pollInterval = setInterval(async () => {
      try {
        const clearedStr = await AsyncStorage.getItem(`@cleared_${userCode}_${friendCode}`);
        const clearedTime = clearedStr ? new Date(clearedStr).getTime() : 0;

        const myCode = userCode.trim().toLowerCase();
        const frCode = friendCode.trim().toLowerCase();

        const roomFilter = isGroupChat
          ? `receiver_code.eq.${frCode}`
          : `and(sender_code.eq.${myCode},receiver_code.eq.${frCode}),and(sender_code.eq.${frCode},receiver_code.eq.${myCode}),and(sender_code.eq.${AI_SENDER_CODE},receiver_code.eq.${roomKey})`;
        const { data } = await supabase
          .from('mensagens')
          .select('*')
          .or(roomFilter)
          .order('created_at', { ascending: false })
          .limit(30);

        if (data) {
          const hasUnread = !isGroupChat && data.some(m =>
            m.sender_code === friendCode &&
            m.receiver_code === userCode &&
            !m.read_at
          );
          if (hasUnread) marcarComoLidas();

          const filteredData = data.filter(m => new Date(m.created_at).getTime() > clearedTime);
          setMessages(prev => {
            const pendingIds = new Set(pendingQueueRef.current.map(m => m.id));
            let changed = false;

            // Cria um mapa para busca rápida de mensagens do poll
            const pollDataMap = new Map(filteredData.map(m => [m.id, m]));

            // Coleta novas mensagens do poll que não estão em 'prev' e não estão em 'pendingQueue'
            const newMessagesFromPoll = filteredData.filter(m =>
              !prev.some(p => p.id === m.id) && !pendingIds.has(m.id)
            );

            // Se houver novas mensagens do poll, as prepend.
            // Isso garante que elas apareçam no topo da lista invertida.
            let currentMessages = [...newMessagesFromPoll, ...prev];
            if (newMessagesFromPoll.length > 0) changed = true;

            // Agora, atualiza as mensagens existentes em `currentMessages` com dados de `pollDataMap`
            currentMessages = currentMessages.map(msg => {
              const fresh = pollDataMap.get(msg.id);
              if (fresh && (fresh.read_at !== msg.read_at || JSON.stringify(fresh.reacoes) !== JSON.stringify(msg.reacoes) || fresh.content !== msg.content)) {
                changed = true;
                return fresh; // Usa a versão atualizada do poll
              }
              return msg; // Mantém o original se não houver atualização
            });

            if (!changed) return prev; // Sem mudanças reais, evita re-renderização

            // O array `currentMessages` agora deve estar ordenado corretamente (mais novo primeiro)
            // porque as novas mensagens foram prepended e as existentes atualizadas no lugar.
            // Nenhuma ordenação completa é necessária aqui, o que deve evitar os saltos.
            AsyncStorage.setItem(`@cache_msgs_${userCode}_${friendCode}`, JSON.stringify(currentMessages.slice(0, 60))).catch(() => {});
            return currentMessages;
          });
        }
      } catch (err) { console.warn('Erro no polling:', err); }
    }, MESSAGE_POLL_INTERVAL_MS);

    channelRef.current = subscription;
    return () => {
      clearInterval(pollInterval);
      supabase.removeChannel(subscription);
    };
  }, [userCode, friendCode, isGroupChat, roomKey]);

  const fetchGroupInfo = useCallback(async () => {
    if (!groupId) return;
    try {
      const [{ data, error }, { data: memberLinks, error: membersError }] = await Promise.all([
        supabase
        .from('grupos')
        .select('id, name, photo_url, description')
        .eq('id', groupId)
        .maybeSingle(),
        supabase.from('grupo_membros').select('member_code').eq('group_id', groupId)
      ]);
      if (error) throw error;
      if (membersError) throw membersError;
      const memberCodes = (memberLinks || []).map(member => member.member_code?.trim().toLowerCase()).filter(Boolean);
      if (memberCodes.length > 0) {
        const { data: profiles, error: profilesError } = await supabase
          .from('perfis')
          .select('connection_code, nickname')
          .in('connection_code', memberCodes);
        if (profilesError) console.warn('Não foi possível obter os nomes dos membros:', profilesError);
        const profileByCode = new Map((profiles || []).map(profile => [profile.connection_code?.trim().toLowerCase(), profile.nickname]));
        const myCode = userCode.trim().toLowerCase();
        setGroupMembers(memberCodes.map(code => ({
          code,
          name: code === myCode ? 'Você' : (profileByCode.get(code) || code)
        })));
      } else {
        setGroupMembers([]);
      }
      if (data) {
        setGroupInfo(data);
        if (!isEditingGroupInfoRef.current) {
          setGroupDescriptionDraft(data.description || '');
          setGroupNameDraft(data.name || '');
          setGroupPhotoDraft(data.photo_url || null);
        }
        setCurrentFriendName(data.name || friendName);
      }
    } catch (error) {
      console.warn('Erro ao buscar informações do grupo:', error);
    }
  }, [groupId, friendName, userCode]);

  useEffect(() => {
    if (!isGroupChat) return;
    fetchGroupInfo();

    const groupChannel = supabase
      .channel(`group-info-${groupId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'grupos', filter: `id=eq.${groupId}` }, (payload) => {
        setGroupInfo(payload.new);
        if (!isEditingGroupInfoRef.current) {
          setGroupDescriptionDraft(payload.new.description || '');
          setGroupNameDraft(payload.new.name || '');
          setGroupPhotoDraft(payload.new.photo_url || null);
        }
        setCurrentFriendName(payload.new.name || friendName);
      })
      .subscribe();

    const groupPoll = setInterval(fetchGroupInfo, GROUP_INFO_POLL_INTERVAL_MS);
    return () => {
      clearInterval(groupPoll);
      supabase.removeChannel(groupChannel);
    };
  }, [isGroupChat, groupId, friendName, fetchGroupInfo]);

  // Uma resposta pode apontar para uma mensagem de páginas antigas. Buscamos só os
  // alvos que faltam para manter o cartão de resposta clicável, sem carregar o chat inteiro.
  useEffect(() => {
    const missingIds = [...new Set(messages.map(message => message.reply_to_id).filter(id => id && !messages.some(message => message.id === id) && !replyTargets[id]))];
    if (!missingIds.length) return;
    let cancelled = false;
    supabase.from('mensagens').select('*').in('id', missingIds).then(({ data, error }) => {
      if (cancelled || error || !data?.length) return;
      setReplyTargets(previous => ({ ...previous, ...Object.fromEntries(data.map(message => [message.id, message])) }));
    });
    return () => { cancelled = true; };
  }, [messages, replyTargets]);

  useEffect(() => {
    if (!groupInfoVisible || !isGroupChat || !groupInfo) return;
    if (
      groupNameDraft !== (groupInfo.name || '') ||
      groupDescriptionDraft !== (groupInfo.description || '') ||
      groupPhotoDraft !== (groupInfo.photo_url || null)
    ) {
      isEditingGroupInfoRef.current = true;
    }
  }, [groupInfoVisible, isGroupChat, groupInfo, groupNameDraft, groupDescriptionDraft, groupPhotoDraft]);

  const openGroupInfo = () => {
    isEditingGroupInfoRef.current = false;
    setGroupInfoVisible(true);
    if (isGroupChat) fetchGroupInfo();
  };

  const pickGroupPhotoForEdit = async () => {
    try {
      setPickerActive?.(true);
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) return toast('Permissão necessária para acessar a galeria.', { tone: 'error' });
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1, 1], quality: 0.75 });
      if (!result.canceled && result.assets?.[0]?.uri) {
        isEditingGroupInfoRef.current = true;
        setGroupPhotoDraft(result.assets[0].uri);
      }
    } catch (error) {
      console.error('Erro ao escolher foto do grupo:', error);
      toast('Não foi possível escolher a foto.', { tone: 'error' });
    } finally {
      setPickerActive?.(false);
    }
  };

  const uploadEditedGroupPhoto = async (uri) => {
    if (!uri || uri === groupInfo?.photo_url) return uri;
    const filename = `groups/${userCode.trim().toLowerCase()}-${Date.now()}.jpg`;
    const base64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const lookup = new Uint8Array(256);
    for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
    lookup['='.charCodeAt(0)] = 64;
    let length = base64.length * 0.75;
    if (base64[base64.length - 1] === '=') length--;
    if (base64[base64.length - 2] === '=') length--;
    const bytes = new Uint8Array(length);
    let position = 0;
    for (let i = 0; i < base64.length; i += 4) {
      const a = lookup[base64.charCodeAt(i)], b = lookup[base64.charCodeAt(i + 1)], c = lookup[base64.charCodeAt(i + 2)], d = lookup[base64.charCodeAt(i + 3)];
      bytes[position++] = (a << 2) | (b >> 4);
      if (c !== 64) bytes[position++] = ((b & 15) << 4) | (c >> 2);
      if (d !== 64) bytes[position++] = ((c & 3) << 6) | d;
    }
    const { error } = await supabase.storage.from('chat-media').upload(filename, bytes.buffer, { contentType: 'image/jpeg', upsert: false });
    if (error) throw error;
    return `${SUPABASE_URL}/storage/v1/object/public/chat-media/${filename}`;
  };

  const handleSaveGroupDetails = async () => {
    const name = groupNameDraft.trim();
    if (!name) return toast('Informe um nome para o grupo.', { tone: 'error' });
    setSavingGroupDetails(true);
    try {
      const photoUrl = await uploadEditedGroupPhoto(groupPhotoDraft);
      const description = groupDescriptionDraft.trim();
      const { data, error } = await supabase.from('grupos').update({ name, photo_url: photoUrl, description }).eq('id', groupId).select('id, name, photo_url, description').single();
      if (error) throw error;
      setGroupInfo(data);
      setCurrentFriendName(data.name);
      setGroupNameDraft(data.name || '');
      setGroupPhotoDraft(data.photo_url || null);
      setGroupDescriptionDraft(data.description || '');
      isEditingGroupInfoRef.current = false;
      toast('Alterações do grupo salvas.');
    } catch (error) {
      console.error('Erro ao atualizar grupo:', error);
      toast('Não foi possível salvar os dados do grupo.', { tone: 'error' });
    } finally {
      setSavingGroupDetails(false);
    }
  };

  const handleSaveGroupDescription = async () => {
    const description = groupDescriptionDraft.trim();
    if (!groupId || savingGroupDescription) return;
    setSavingGroupDescription(true);
    try {
      const { data, error } = await supabase
        .from('grupos')
        .update({ description })
        .eq('id', groupId)
        .select('id, name, photo_url, description')
        .single();
      if (error) throw error;
      setGroupInfo(data);
      setGroupDescriptionDraft(data.description || '');
      toast('Descrição do grupo atualizada.');
    } catch (error) {
      console.error('Erro ao atualizar descrição do grupo:', error);
      toast('Não foi possível salvar a descrição. Confira a coluna description no Supabase.', { tone: 'error' });
    } finally {
      setSavingGroupDescription(false);
    }
  };

  const marcarComoLidas = async () => {
    if (marcarLidasDebounceRef.current) return; // já agendado
    marcarLidasDebounceRef.current = setTimeout(async () => {
      marcarLidasDebounceRef.current = null;
      await syncTimeWithServer();
      const readAt = new Date(getSyncedTime()).toISOString();
      if (isGroupChat) {
        await supabase.from('mensagens').update({ read_at: readAt }).eq('receiver_code', friendCode).neq('sender_code', userCode).is('read_at', null);
        return;
      }
      await supabase.from('mensagens').update({ read_at: readAt }).eq('sender_code', friendCode).eq('receiver_code', userCode).is('read_at', null);
      // Limpa a notificação da gaveta do celular assim que a pessoa entra no chat
      // await Notifications.dismissAllNotificationsAsync();
    }, 1000);
  };

  const handleTextChange = (text) => {
    onUserActivity?.();
    inputTextRef.current = text; // 🚀 Salva imediatamente na memória absoluta
    setInputText(text);

    // 🚀 Removemos o 'await' para não engasgar o teclado ao digitar rápido
    AsyncStorage.setItem(`@draft_${userCode}_${friendCode}`, text).catch(() => {});

    // 🚀 Chama a busca por sugestões de emoji
    fetchEmojiSuggestions(text);
  };

  const requestAndSaveLinkPreview = useCallback(async (message) => {
    if (!message?.id || message.media_url) return;

    const url = getFirstValidHttpUrl(message.content || message.link_url || '');
    if (!url) return;

    const alreadyHasPreview = !!(
      message.link_url ||
      message.preview_title ||
      message.preview_description ||
      message.preview_image_url ||
      message.preview_site_name
    );
    if (alreadyHasPreview && message.link_url) return;

    let preview = linkPreviewCache.get(url);
    if (preview === undefined) {
      let request = linkPreviewRequests.get(url);
      if (!request) {
        request = (async () => {
          try {
            const { data, error } = await supabase.functions.invoke('link-preview', { body: { url } });
            if (error) throw error;
            if (data?.preview) return data.preview;
          } catch (error) {
            console.warn('Prévia de link indisponível:', error?.message || error);
          }

          try {
            return await getPreviewFromHtmlFallback(url);
          } catch (error) {
            console.warn('Fallback local falhou:', error?.message || error);
            return null;
          }
        })().finally(() => linkPreviewRequests.delete(url));

        linkPreviewRequests.set(url, request);
      }
      preview = await request;
      linkPreviewCache.set(url, preview);
    }

    if (!preview) return;

    const previewFields = {
      link_url: preview.url || url,
      preview_title: preview.title || null,
      preview_description: preview.description || null,
      preview_image_url: preview.image_url || null,
      preview_site_name: preview.site_name || null,
    };

    const { error } = await supabase.from('mensagens').update(previewFields).eq('id', message.id);
    if (error) {
      console.warn('Não foi possível gravar prévia do link:', error.message);
      return;
    }

    setMessages(prev => prev.map(item => item.id === message.id ? { ...item, ...previewFields } : item));
  }, []);

  const getAiContextText = () => {
    const recentMessages = [...messages]
      .filter(m => !m.media_url && m.content)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .slice(-30);

    return recentMessages.map((message) => {
      if (message.sender_code === AI_SENDER_CODE || message.media_type === 'ai') return `${aiDisplayName}: ${message.content}`;
      if (message.sender_code === userCode) return `${userCode}: ${message.content}`;
      return `${currentFriendName || friendCode}: ${message.content}`;
    }).join('\n');
  };

  const insertAiMessage = async (content) => {
    const payload = {
      sender_code: userCode,
      receiver_code: friendCode,
      content,
      media_type: 'ai',
    };

    const { data, error } = await supabase.from('mensagens').insert([payload]).select().single();
    if (error) throw error;

    if (data) {
      setMessages(prev => {
        if (prev.some(m => m.id === data.id)) return prev;
        const updated = [data, ...prev].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        AsyncStorage.setItem(`@cache_msgs_${userCode}_${friendCode}`, JSON.stringify(updated.slice(0, 60))).catch(() => {});
        return updated;
      });
    }
  };

  const fetchGeminiWithRetry = async (url, body, timeoutMs, maxRetries) => {
    let lastError = null;
    const attempts = Math.max(1, maxRetries + 1);

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify(body),
        });

        const result = await response.json().catch(() => ({}));
        if (response.ok) return result;

        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        lastError = new Error(result?.error?.message || `${aiDisplayName} indisponÃ­vel (${response.status})`);
        if (!retryable || attempt === attempts) throw lastError;
      } catch (err) {
        lastError = err;
        if (attempt === attempts) throw err;
      } finally {
        clearTimeout(timeoutId);
      }

      await sleep(650 * attempt);
    }

    throw lastError || new Error('Falha desconhecida na IA.');
  };

  const handleAiCommandLegacy = async (messageContent) => {
    const trigger = aiTrigger.trim() || '@/';
    if (!messageContent.startsWith(trigger)) return false;

    const question = messageContent.slice(trigger.length).trim();
    if (!aiEnabled) {
      toast('IA desligada. Ative nos três pontinhos > IA.');
      return true;
    }
    if (!aiApiKey.trim()) {
      toast('Cole uma API key do Gemini nas configurações da IA.', { tone: 'error' });
      return true;
    }
    if (!question) {
      toast(`Digite uma pergunta depois de ${trigger}`);
      return true;
    }
    if (isAiResponding) {
      toast('O Gemini ainda está respondendo.');
      return true;
    }

    setIsAiResponding(true);
    toast('Gemini está pensando...');

    try {
      const timeoutMs = Math.min(120, Math.max(10, Number(aiTimeoutSeconds) || AI_DEFAULT_TIMEOUT_SECONDS)) * 1000;
      const retries = Math.min(5, Math.max(0, Number(aiMaxRetries) || 0));
      const contextText = getAiContextText();
      const prompt = [
        'Você está participando de uma conversa de chat como uma terceira pessoa chamada Gemini.',
        'Use o contexto recente apenas quando ele ajudar. Não invente fatos sobre mensagens ausentes.',
        contextText ? `Contexto recente:\n${contextText}` : 'Contexto recente: sem mensagens de texto disponíveis.',
        `Pedido atual: ${question}`,
      ].join('\n\n');

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(aiModel.trim() || GEMINI_MODELS[0])}:generateContent?key=${encodeURIComponent(aiApiKey.trim())}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: aiSystemPrompt.trim() || 'Responda em português brasileiro, de forma útil e natural.' }],
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }],
            },
          ],
        }),
      });
      clearTimeout(timeoutId);

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result?.error?.message || `Gemini indisponível (${response.status})`);
      }

      const answer = result?.candidates?.[0]?.content?.parts
        ?.map(part => part.text)
        .filter(Boolean)
        .join('\n')
        .trim();

      if (!answer) throw new Error('O Gemini não retornou texto.');

      await insertAiMessage(answer);
    } catch (err) {
      console.warn('Erro ao chamar Gemini:', err);
      const message = err?.name === 'AbortError'
        ? 'Gemini demorou demais para responder. Tente novamente.'
        : `Gemini indisponível: ${err.message || 'erro desconhecido'}`;
      toast(message, { tone: 'error', duration: 4200 });
    } finally {
      setIsAiResponding(false);
    }

    return true;
  };

  const handleAiCommand = async (messageContent) => {
    const trigger = aiTrigger.trim() || '@/';
    if (!messageContent.startsWith(trigger)) return false;

    const question = messageContent.slice(trigger.length).trim();
    if (!aiEnabled) {
      toast('IA desligada. Ative nos tres pontinhos > IA.');
      return true;
    }
    if (!aiApiKey.trim()) {
      toast(`Cole uma API key do ${aiDisplayName} nas configuracoes da IA.`, { tone: 'error' });
      return true;
    }
    if (!question) {
      toast(`Digite uma pergunta depois de ${trigger}`);
      return true;
    }
    if (isAiResponding) {
      toast(`${aiDisplayName} ainda esta respondendo.`);
      return true;
    }

    setIsAiResponding(true);
    toast(`${aiDisplayName} entrou na conversa...`);

    try {
      const timeoutMs = Math.min(120, Math.max(10, Number(aiTimeoutSeconds) || AI_DEFAULT_TIMEOUT_SECONDS)) * 1000;
      const retries = Math.min(5, Math.max(0, Number(aiMaxRetries) || 0));
      const contextText = getAiContextText();
      const prompt = [
        `Voce esta participando de uma conversa de chat como uma terceira pessoa chamada ${aiDisplayName}.`,
        'Use o contexto recente apenas quando ele ajudar. Nao invente fatos sobre mensagens ausentes.',
        contextText ? `Contexto recente:\n${contextText}` : 'Contexto recente: sem mensagens de texto disponiveis.',
        `Pedido atual: ${question}`,
      ].join('\n\n');

      const result = await fetchGeminiWithRetry(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(aiModel.trim() || GEMINI_MODELS[0])}:generateContent?key=${encodeURIComponent(aiApiKey.trim())}`,
        {
          systemInstruction: {
            parts: [{ text: aiSystemPrompt.trim() || `Responda em portugues brasileiro, de forma util e natural, como ${aiDisplayName}.` }],
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }],
            },
          ],
        },
        timeoutMs,
        retries
      );

      const answer = result?.candidates?.[0]?.content?.parts
        ?.map(part => part.text)
        .filter(Boolean)
        .join('\n')
        .trim();

      if (!answer) throw new Error(`${aiDisplayName} nao retornou texto.`);

      await insertAiMessage(answer);
    } catch (err) {
      console.warn('Erro ao chamar IA:', err);
      const message = err?.name === 'AbortError'
        ? `${aiDisplayName} demorou demais para responder. Tente novamente.`
        : `${aiDisplayName} indisponivel: ${err.message || 'erro desconhecido'}`;
      toast(message, { tone: 'error', duration: 4200 });
    } finally {
      setIsAiResponding(false);
    }

    return true;
  };

  const handleSendMessage = async () => {
    // 🚀 FIX: Força o teclado a confirmar a palavra pendente antes de enviar (bug corretor Android)
    textInputRef.current?.blur();
    await new Promise(resolve => setTimeout(resolve, 50)); // dá tempo do onChangeText final chegar

    const currentText = inputTextRef.current; // Lê da referência agora atualizada com a palavra final
    if (currentText.trim() === '') {
      textInputRef.current?.focus(); // Devolve o foco se tentou enviar vazio
      return;
    }

    const messageContent = currentText.trim();
    const currentReplyId = replyingTo ? replyingTo.id : null;

    inputTextRef.current = '';
    setShowEmojiSuggestions(false); // Esconde sugestões ao enviar
    setInputText('');
    setReplyingTo(null);

    try {
      await AsyncStorage.removeItem(`@draft_${userCode}_${friendCode}`);
    } catch (e) { console.error(e); }


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

    setPendingQueueSynced(prev => [newPendingMessage, ...prev]);

    textInputRef.current?.focus(); // Mantém o teclado aberto para continuar conversando
    await handleAiCommand(messageContent);
  };

  const forceManualRetry = (msgId) => {
    setPendingQueueSynced(prev => prev.map(m => m.id === msgId ? { ...m, status: 'sending' } : m));
  };

  const handleDeleteMessage = async (messageId) => {
    try {
      if (infoModalMessage?.media_url && !infoModalMessage.media_url.includes('giphy.com')) {
        const path = extractStoragePath(infoModalMessage.media_url);
        if (path) {
          const { error: storageError } = await supabase.storage.from('chat-media').remove([path]);
          if (storageError) console.error('Erro ao deletar mídia:', storageError);
        }
      }

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

      setRecentEmojis(prev => {
        const updated = [emoji, ...prev.filter(e => e !== emoji)].slice(0, 6);
        AsyncStorage.setItem('@recent_emojis', JSON.stringify(updated)).catch(() => {});
        setRenderKey(k => k + 1);
        return updated;
      });
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

  const handleUploadAndSendMedia = async (uri, mediaType, fileSize, fileName = null, mimeType = null) => {
    // 🚀 Formata o tamanho do arquivo para MB ou KB
    let sizeStr = '';
    if (fileSize) {
      const mb = fileSize / (1024 * 1024);
      sizeStr = mb < 1 ? (fileSize / 1024).toFixed(0) + ' KB' : mb.toFixed(1) + ' MB';
    }

    let finalContent;
    if (mediaType === 'document') {
      // 🚀 Formato especial para guardar nome e tamanho no mesmo campo, evitando mexer no banco
      finalContent = `${fileName || 'Documento'}|${sizeStr}`;
    } else if (mediaType === 'audio') {
      // Para áudio, o fileName é a duração (ex: "0:45")
      finalContent = fileName;
    } else if (mediaType.includes('_spoiler')) {
      // 🚀 Mensagem para mídias com spoiler
      finalContent = '🤫 Mídia com Spoiler';
    } else {
      finalContent = sizeStr || (mediaType === 'video' ? '📹 Vídeo' : '📷 Foto');
    }

    // 🚀 Enfileira a mídia na hora (permitindo envio offline fluido e retries eternos do Upload)
    let newTime = getSyncedTime();
    if (newTime <= lastMessageTimeRef.current) newTime = lastMessageTimeRef.current + 1;
    lastMessageTimeRef.current = newTime;

    const newPendingMessage = {
      id: `pending-${newTime}-${Math.random()}`,
      content: finalContent,
      media_url: uri, // URI Local temporária para visualização imediata na lista
      media_type: mediaType,
      sender_code: userCode,
      receiver_code: friendCode,
      reply_to_id: replyingTo?.id,
      created_at: new Date(newTime).toISOString(),
      status: 'sending',
      media_file_name: fileName,
      media_mime_type: mimeType,
      needs_upload: true // 🚀 Informa ao QueueWorker que essa mensagem tem um anexo local e PRECISA de upload
    };

    setPendingQueueSynced(prev => [newPendingMessage, ...prev]);
    setReplyingTo(null);
  };

  const handleSendComposer = async () => {
    handleSendMessage();
  };

  const handleDownloadAndShareFile = async (url, content) => {
    try {
      const [filename, filesize] = (content || '|').split('|');
      if (!filename) {
        toast("Informações do arquivo ausentes. Não é possível baixar.");
        return;
      }
      const localUri = `${FileSystem.cacheDirectory}${filename.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;

      const fileInfo = await FileSystem.getInfoAsync(localUri);
      if (fileInfo.exists) {
        if (setPickerActive) setPickerActive(true);
        await Sharing.shareAsync(localUri);
        return;
      }

      toast(`Baixando "${filename}" (${filesize})...`);
      const { uri } = await FileSystem.downloadAsync(url, localUri);
      if (setPickerActive) setPickerActive(true);
      await Sharing.shareAsync(uri);
    } catch (error) {
      console.error("Error downloading or sharing file:", error);
      toast("Não foi possível abrir o arquivo.", { tone: 'error' });
    } finally {
      if (setPickerActive) setPickerActive(false);
    }
  };

  const handleDownloadMedia = async (url, mediaType = 'image') => {
    try {
      // 🚀 Proteção Web para Download de Mídia
      if (Platform.OS === 'web') {
        toast('No navegador (Web), clique com o botão direito ou segure a imagem/vídeo para salvar.');
        return;
      }

      if (setPickerActive) setPickerActive(true); // Previne o lock da tela ao abrir o modal de permissão nativo
      const { status, canAskAgain } = await MediaLibrary.requestPermissionsAsync(true); // 🚀 writeOnly: Pede apenas Escrita (ignora Áudio e Leitura da Galeria)
      if (status !== 'granted') {
        if (setPickerActive) setPickerActive(false);
        Alert.alert(
          'Permissão necessária',
          canAskAgain
            ? 'Permita o acesso para salvar mídias.'
            : 'Vá em Configurações > Aplicativos > [seu app] > Permissões e habilite Fotos/Mídia.',
          [{ text: 'OK' }]
        );
        return;
      }

      let uriToSave = url;

      // 🚀 Se a URL for da internet (Supabase), nós baixamos o arquivo primeiro
      if (url.startsWith('http')) {
        // Remove query params e garante que exista uma extensão de arquivo válida
        const rawFilename = url.split('/').pop().split('?')[0];
        const fallbackExt = mediaType === 'video' ? 'mp4' : 'jpg';
        const filename = rawFilename.includes('.') ? rawFilename : `${rawFilename}.${fallbackExt}`;

        // Usa documentDirectory (permanente). O Android aborta a cópia de vídeos se estiverem no cache!
        const fileUri = `${FileSystem.documentDirectory}${Date.now()}-${filename}`;
        const downloadRes = await FileSystem.downloadAsync(url, fileUri);

        const fileInfo = await FileSystem.getInfoAsync(downloadRes.uri);
        if (!fileInfo.exists || (typeof fileInfo.size === 'number' && fileInfo.size === 0)) {
          throw new Error('Arquivo baixado está vazio ou corrompido');
        }
        uriToSave = downloadRes.uri;
      }

      // 🚀 Salva direto na pasta oficial Pictures (O Google Fotos identifica na hora!)
      await MediaLibrary.createAssetAsync(uriToSave);

      if (setPickerActive) setPickerActive(false);
      toast('Mídia salva na galeria com sucesso.');
    } catch (err) {
      if (setPickerActive) setPickerActive(false);
      console.error('Download error:', err);
      toast(`Erro ao salvar: ${err.message ?? JSON.stringify(err)}`, { tone: 'error' });
    }
  };

  // 🚀 CORREÇÃO: Abre a mídia em tela cheia e fecha a galeria ao mesmo tempo,
  // resolvendo o bug onde a mídia só aparecia depois de fechar a galeria manualmente.
  const handleOpenMediaFromGallery = (item) => {
    // 1. Filtra todas as mídias válidas para a galeria
    const mediaItems = (galleryMessages || messages).filter(m => m.media_url && (m.media_type?.startsWith('image') || m.media_type?.startsWith('video')));
    // 2. Encontra o índice do item clicado
    const initialIndex = mediaItems.findIndex(m => m.id === item.id);

    // 3. Define a lista e o índice para o modal de tela cheia
    setFullscreenMediaList(mediaItems);
    setFullscreenMediaIndex(initialIndex);

    // 4. Fecha a galeria
    setMediaGalleryVisible(false);

    // Adiciona um pequeno delay para garantir que o modal da galeria fechou antes de abrir o da mídia
    setTimeout(() => {
      // 5. Abre a mídia em tela cheia
      if (item.media_type?.startsWith('video')) {
        setFullscreenVideo(item.media_url);
      } else {
        setFullscreenImage(item.media_url);
      }
    }, 50); // 50ms é suficiente para a transição e imperceptível ao usuário
  };

  const handleSelectMedia = async (type) => {
    setAttachMenuVisible(false);
    try {
      if (setPickerActive) setPickerActive(true); // Ativa ANTES de pedir as permissões!

      const resPhoto = await ImagePicker.requestMediaLibraryPermissionsAsync();
      const resCam = await ImagePicker.requestCameraPermissionsAsync();
      if (!resPhoto.granted || !resCam.granted) {
        if (setPickerActive) setPickerActive(false);
        return toast('Permissões necessárias.');
      }

      let result = null;
      let isSpoiler = false;
      if (type === 'camera_photo') {
        result = await ImagePicker.launchCameraAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          allowsEditing: true, // 🚀 Permite cortar e editar se tirar foto na hora
          quality: 0.5 // 🚀 Ajustado para 0.5 (Bom equilíbrio entre qualidade e tamanho)
        });
      } else if (type === 'camera_video') {
        result = await ImagePicker.launchCameraAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Videos,
          allowsEditing: true, // 🚀 Permite aparar o vídeo se gravado na hora
          videoQuality: 0 // 🚀 Grava o vídeo em menor resolução para economizar banco de dados
          , allowsEditing: false,
        });
      } else if (type === 'gallery' || type === 'gallery_spoiler') {
        if (type === 'gallery_spoiler') {
          isSpoiler = true;
        }
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.All,
          allowsMultipleSelection: true, // 🚀 Habilita a seleção múltipla de fotos/vídeos!
          selectionLimit: 10, // 🚀 Limite seguro para não travar a memória do aparelho
          quality: 0.5, // 🚀 Ajustado para 0.5 (Bom equilíbrio entre qualidade e tamanho)
          orderedSelection: true // 🚀 Respeita a ordem exata em que o usuário clicou
        });
      }

      if (setPickerActive) setPickerActive(false);

      if (result && !result.canceled && result.assets && result.assets.length > 0) {
        for (const asset of result.assets) {
          let finalFileSize = asset.fileSize;
          if (!finalFileSize) {
            try {
              const fileInfo = await FileSystem.getInfoAsync(asset.uri);
              finalFileSize = fileInfo.size;
            } catch (e) {}
          }
          const mediaType = asset.type || (asset.uri.toLowerCase().endsWith('.mp4') ? 'video' : 'image');
          const finalMediaType = isSpoiler ? `${mediaType}_spoiler` : mediaType;
          await handleUploadAndSendMedia(asset.uri, finalMediaType, finalFileSize, asset.fileName, asset.mimeType);
        }
      }
    } catch (err) {
      if (setPickerActive) setPickerActive(false);
      console.error(err);
    }
  };

  // 🚀 FUNÇÕES DE GRAVAÇÃO DE ÁUDIO
  // 🚀 BLINDADAS CONTRA CRASH: qualquer falha aqui é capturada e tratada, nunca propagada
  // como uma exceção não tratada (essa era a causa provável do app reiniciar sozinho ao gravar).
  const startRecording = async () => {
    // 🚀 GUARDA: Impede o início de uma nova gravação se uma já estiver em andamento.
    if (isRecording || recordingRef.current) {
      console.warn('Tentativa de iniciar gravação duplicada foi ignorada.');
      return;
    }

    try {
      // 🚀 Libera a sessão de áudio: para/descarrega qualquer áudio em reprodução (mensagens
      // já enviadas ou a pré-visualização) antes de pedir o microfone. Tentar gravar com um
      // player de áudio ainda ativo é uma causa comum de crash nativo em alguns Androids.
      await audioPlayerRef.current.stopAsync().catch(() => {});
      await audioPlayerRef.current.unloadAsync().catch(() => {});
      setCurrentlyPlaying(null);
      setPlaybackStatus(null);

      await previewSoundRef.current.stopAsync().catch(() => {});
      await previewSoundRef.current.unloadAsync().catch(() => {});
      setIsPreviewPlaying(false);
      setPreviewStatus(null);

      // 🚀 Verifica a permissão antes de pedir; nunca deixa a checagem escapar sem tratamento
      let permissions = await Audio.getPermissionsAsync().catch((err) => {
        console.warn('Falha ao checar permissão de áudio', err);
        return { granted: false, status: 'undetermined' };
      });

      if (!permissions?.granted) {
        if (setPickerActive) setPickerActive(true);
        permissions = await Audio.requestPermissionsAsync().catch((err) => {
          console.error('Falha ao pedir permissão de áudio', err);
          return { granted: false, status: 'denied' };
        });
        if (setPickerActive) setPickerActive(false);
      }

      if (!permissions?.granted) {
        toast('Permissão para acessar o microfone é necessária!');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        shouldDuckAndroid: true,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        playThroughEarpieceAndroid: false,
        staysActiveInBackground: false,
      });

      const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      recordingRef.current = recording;
      setIsRecording(true);
      setIsPaused(false); // 🚀 Garante que uma gravação nova sempre comece "tocando", nunca pausada

      setRecordingDuration(0);
      recordingTimerRef.current = setInterval(() => setRecordingDuration(prev => prev + 1), 1000);

    } catch (err) {
      console.error('Falha ao iniciar gravação', err);
      // 🚀 Limpeza de emergência em caso de falha na inicialização — nunca deixa o app em estado inconsistente
      try {
        if (recordingRef.current) {
          await recordingRef.current.stopAndUnloadAsync().catch(() => {});
        }
      } catch (e) {
        // Ignora: já estamos tratando um erro, não queremos lançar outro por cima
      }
      recordingRef.current = null;
      setIsRecording(false);
      setIsPaused(false);
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      setRecordingDuration(0);
      if (setPickerActive) setPickerActive(false);
      toast('Não foi possível iniciar a gravação. Tente novamente.', { tone: 'error' });
    }
  };

  // 🚀 PAUSA a gravação em andamento, permitindo ao usuário lembrar o que ia dizer sem perder o áudio já gravado
  const handlePauseRecording = async () => {
    onUserActivity?.();
    if (!recordingRef.current || isPaused) return;
    try {
      clearInterval(recordingTimerRef.current);
      await recordingRef.current.pauseAsync();
      setIsPaused(true);
    } catch (err) {
      console.error('Falha ao pausar gravação', err);
      // 🚀 Se o aparelho não suportar pausar (ex: Android antigo), reinicia o timer para não travar a contagem
      recordingTimerRef.current = setInterval(() => setRecordingDuration(prev => prev + 1), 1000);
      toast('Não foi possível pausar a gravação neste aparelho.');
    }
  };

  // 🚀 RETOMA a gravação pausada, continuando exatamente de onde parou (mesmo arquivo de áudio)
  const handleResumeRecording = async () => {
    onUserActivity?.();
    if (!recordingRef.current || !isPaused) return;
    try {
      await recordingRef.current.startAsync();
      setIsPaused(false);
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration(prev => prev + 1);
      }, 1000);
    } catch (err) {
      console.error('Falha ao retomar gravação', err);
      toast('Não foi possível retomar a gravação.', { tone: 'error' });
    }
  };

  // 🚀 CANCELA a gravação atual (pausada ou em andamento), descartando o áudio sem enviar
  const handleCancelRecording = async () => {
    onUserActivity?.();
    recordingDragX.setValue(0);
    setIsRecordingCancelArmed(false);
    clearInterval(recordingTimerRef.current);
    setIsRecording(false);
    setIsPaused(false);
    setRecordingDuration(0);
    try {
      if (recordingRef.current) {
        await recordingRef.current.stopAndUnloadAsync().catch(() => {});
        const uri = recordingRef.current.getURI();
        if (uri) await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      }
      // 🚀 Libera o microfone/volta o modo de áudio ao normal para não travar reproduções futuras
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true }).catch(() => {});
    } catch (err) {
      console.error('Falha ao cancelar gravação', err);
    } finally {
      recordingRef.current = null;
    }
  };

  const stopRecording = async () => {
    onUserActivity?.();
    if (!recordingRef.current) return;

    setIsRecording(false);
    clearInterval(recordingTimerRef.current);

    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      const status = await recordingRef.current.getStatusAsync().catch(() => null);
      const durationMillis = status?.durationMillis || 0;

      const minutes = Math.floor(durationMillis / 60000);
      const seconds = Math.floor((durationMillis % 60000) / 1000);
      const durationStr = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

      // 🚀 Devolve o modo de áudio para reprodução normal, liberando o microfone —
      // sem isso, reproduções e futuras gravações podem falhar ou travar em alguns aparelhos
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true }).catch(() => {});

      if (uri) {
        // 🚀 Em vez de enviar direto, mostra a pré-visualização (estilo WhatsApp)
        setRecordedPreview({ uri, duration: durationStr, size: status?.size });
      }

    } catch (error) {
      console.error('Falha ao parar gravação', error);
      toast('Ocorreu um problema ao finalizar a gravação.', { tone: 'error' });
    } finally {
      recordingRef.current = null;
      setRecordingDuration(0);
      setIsPaused(false);
    }
  };

  // 🚀 REPRODUÇÃO DE ÁUDIOS JÁ ENVIADOS NO CHAT (usado pelo AudioBubble)
  const togglePlayback = async (item) => {
    try {
      if (isRecording) return; // 🚀 Nunca reproduz áudio enquanto uma gravação está em andamento

      if (currentlyPlaying === item.id) {
        // Já está carregado neste item: só alterna play/pause
        if (playbackStatus?.isPlaying) {
          await audioPlayerRef.current.pauseAsync();
        } else {
          await audioPlayerRef.current.playAsync();
        }
      } else {
        // Troca de áudio: descarrega o anterior e carrega o novo
        await audioPlayerRef.current.unloadAsync().catch(() => {});
        setCurrentlyPlaying(item.id); // 🚀 Define antes de carregar para a interface já preparar o player
        setPlaybackStatus(null); // 🚀 Zera o status anterior para não mostrar a barra de progresso do áudio antigo
        // 🚀 Registra o callback ANTES do loadAsync para não perder a primeira atualização de status (posição/duração)
        audioPlayerRef.current.setOnPlaybackStatusUpdate((status) => {
          setPlaybackStatus(status);
          if (status.didJustFinish) {
            setCurrentlyPlaying(null);
          }
        });
        await audioPlayerRef.current.loadAsync({ uri: item.media_url }, { shouldPlay: true });
      }
    } catch (e) {
      console.warn('Erro ao reproduzir áudio:', e);
      setCurrentlyPlaying(null);
      setPlaybackStatus(null);
    }
  };

  const seekAudio = async (value) => {
    if (!playbackStatus?.durationMillis) return;
    try {
      await audioPlayerRef.current.setPositionAsync(value * playbackStatus.durationMillis);
    } catch (e) {
      console.warn('Erro ao buscar posição do áudio:', e);
    }
  };

  // 🚀 REPRODUÇÃO DA PRÉ-VISUALIZAÇÃO DO ÁUDIO RECÉM-GRAVADO (antes de enviar)
  const togglePreviewPlayback = async () => {
    if (!recordedPreview || isRecording) return;
    try {
      if (isPreviewPlaying) {
        await previewSoundRef.current.pauseAsync();
        setIsPreviewPlaying(false);
        return;
      }

      // 🚀 Garante que nenhum outro áudio do chat esteja tocando ao mesmo tempo
      await audioPlayerRef.current.pauseAsync().catch(() => {});

      const status = await previewSoundRef.current.getStatusAsync().catch(() => ({ isLoaded: false }));
      if (!status.isLoaded) {
        await previewSoundRef.current.loadAsync({ uri: recordedPreview.uri }, { shouldPlay: true });
        previewSoundRef.current.setOnPlaybackStatusUpdate((s) => {
          setPreviewStatus(s);
          if (s.didJustFinish) {
            setIsPreviewPlaying(false);
            previewSoundRef.current.setPositionAsync(0).catch(() => {});
          }
        });
      } else {
        await previewSoundRef.current.playAsync();
      }
      setIsPreviewPlaying(true);
    } catch (e) {
      console.warn('Erro ao tocar preview:', e);
      setIsPreviewPlaying(false);
    }
  };

  const seekPreviewAudio = async (value) => {
    if (!previewStatus?.durationMillis) return;
    try {
      await previewSoundRef.current.setPositionAsync(value * previewStatus.durationMillis);
    } catch (e) {
      console.warn('Erro ao buscar posição do preview:', e);
    }
  };

  const handleDeleteRecordedPreview = async () => {
    try {
      await previewSoundRef.current.stopAsync().catch(() => {});
      await previewSoundRef.current.unloadAsync().catch(() => {});
      if (recordedPreview?.uri) {
        await FileSystem.deleteAsync(recordedPreview.uri, { idempotent: true }).catch(() => {});
      }
    } finally {
      setRecordedPreview(null);
      setIsPreviewPlaying(false);
      setPreviewStatus(null);
    }
  };

  const handleSendRecordedPreview = async () => {
    if (!recordedPreview) return;
    const { uri, duration, size } = recordedPreview;

    await previewSoundRef.current.stopAsync().catch(() => {});
    await previewSoundRef.current.unloadAsync().catch(() => {});

    setRecordedPreview(null);
    setIsPreviewPlaying(false);
    setPreviewStatus(null);

    await handleUploadAndSendMedia(uri, 'audio', size, duration);
  };

  const handleSelectDocument = async () => {
    setAttachMenuVisible(false);
    try {
      if (setPickerActive) setPickerActive(true);
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*', // Permite todos os tipos de arquivo
        copyToCacheDirectory: true,
      });
      if (setPickerActive) setPickerActive(false);

      if (result.canceled === false) {
        // A API mais nova retorna um array `assets`
        const asset = result.assets[0];
        await handleUploadAndSendMedia(asset.uri, 'document', asset.size, asset.name);
      }
    } catch (err) {
      if (setPickerActive) setPickerActive(false);
      console.error('Error picking document:', err);
      toast('Ocorreu um erro ao selecionar o documento.', { tone: 'error' });
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

  const handleClearChat = () => {
    setTopMenuVisible(false);
    setTimeout(() => {
      Alert.alert(
        "Limpar Mensagens",
        "Deseja apagar todas as mensagens permanentemente para você e para o contato?",
        [
          { text: "Cancelar", style: "cancel" },
          {
            text: "Limpar",
            style: "destructive",
            onPress: async () => {
              try {
                const myCode = userCode.trim().toLowerCase();
                const frCode = friendCode.trim().toLowerCase();

                if (isGroupChat) {
                  const { data: groupMsgs } = await supabase.from('mensagens')
                    .select('media_url')
                    .eq('receiver_code', frCode);

                  const filesToDelete = (groupMsgs || [])
                    .filter(m => m.media_url && !m.media_url.includes('giphy.com'))
                    .map(m => extractStoragePath(m.media_url))
                    .filter(Boolean);

                  if (filesToDelete.length > 0) {
                    const { error: storageError } = await supabase.storage.from('chat-media').remove(filesToDelete);
                    if (storageError) console.error('Erro ao limpar midias do grupo:', storageError);
                  }

                  await supabase.from('mensagens').delete().eq('receiver_code', frCode);
                  await supabase.from('pins').delete().eq('room_key', frCode);
                  setMessages([]);
                  setPinnedMessage(null);
                  AsyncStorage.removeItem(`@cache_msgs_${userCode}_${friendCode}`).catch(() => {});
                  toast('Mensagens do grupo apagadas com sucesso.');
                  return;
                }
                // 🚀 Garante que o canal esteja salvo para os dois lados antes de apagar as mensagens.
                // Isso evita que o chat suma da lista do outro aparelho por falta de mensagens.
                const { data: existingConns } = await supabase.from('conexoes')
                  .select('user_code, friend_code')
                  .or(`and(user_code.eq.${myCode},friend_code.eq.${frCode}),and(user_code.eq.${frCode},friend_code.eq.${myCode})`);

                const hasMyConn = existingConns?.some(c => c.user_code === myCode && c.friend_code === frCode);
                const hasFrConn = existingConns?.some(c => c.user_code === frCode && c.friend_code === myCode);

                const newConns = [];
                if (!hasMyConn || !hasFrConn) {
                  const { data: profiles } = await supabase.from('perfis')
                    .select('connection_code, nickname')
                    .in('connection_code', [myCode, frCode]);

                  const myProfile = profiles?.find(p => p.connection_code === myCode);
                  const frProfile = profiles?.find(p => p.connection_code === frCode);

                  if (!hasMyConn) newConns.push({ user_code: myCode, friend_code: frCode, friend_name: frProfile?.nickname || frCode });
                  if (!hasFrConn) newConns.push({ user_code: frCode, friend_code: myCode, friend_name: myProfile?.nickname || myCode });
                }

                if (newConns.length > 0) {
                  await supabase.from('conexoes').insert(newConns);
                }

                // 🚀 Busca todas as mídias deste canal direto no servidor antes de apagar
                const { data: msgs } = await supabase.from('mensagens')
                  .select('media_url, media_type')
                  .or(`and(sender_code.eq.${myCode},receiver_code.eq.${frCode}),and(sender_code.eq.${frCode},receiver_code.eq.${myCode})`);

                if (msgs && msgs.length > 0) {
                  const filesToDelete = msgs
                    .filter(m => m.media_url && !m.media_url.includes('giphy.com'))
                    .map(m => extractStoragePath(m.media_url))
                    .filter(Boolean);

                  if (filesToDelete.length > 0) {
                    const { error: storageError } = await supabase.storage.from('chat-media').remove(filesToDelete);
                    if (storageError) console.error('Erro ao limpar mídias:', storageError);
                  }
                }

                // Deleta definitivamente as mensagens do banco de dados (para os dois usuários)
                await supabase.from('mensagens').delete().match({ sender_code: myCode, receiver_code: frCode });
                await supabase.from('mensagens').delete().match({ sender_code: frCode, receiver_code: myCode });
                await supabase.from('mensagens').delete().match({ sender_code: AI_SENDER_CODE, receiver_code: roomKey });
                setMessages([]);
                AsyncStorage.removeItem(`@cache_msgs_${userCode}_${friendCode}`).catch(() => {});
                toast('Mensagens e mídias apagadas com sucesso.');
              } catch (err) { console.error(err); }
            }
          }
        ]
      );
    }, 300);
  };

  const saveColor = async (type, color) => {
    if (type === 'my') { setMyBubbleColor(color); await AsyncStorage.setItem(`@myBubble_${userCode}_${friendCode}`, color); }
    if (type === 'their') { setTheirBubbleColor(color); await AsyncStorage.setItem(`@theirBubble_${userCode}_${friendCode}`, color); }
  };

  // 🚀 LÓGICA DO PLANO DE FUNDO
  const handlePickBackground = async () => {
    setTopMenuVisible(false);
    try {
      if (setPickerActive) setPickerActive(true);
      const res = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!res.granted) {
        if (setPickerActive) setPickerActive(false);
        return toast('Permissão necessária para acessar a galeria.');
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [9, 16],
        quality: 0.7,
      });
      if (setPickerActive) setPickerActive(false);
      if (!result.canceled && result.assets[0].uri) {
        const uri = result.assets[0].uri;
        setChatBackground(uri);
        await AsyncStorage.setItem(`@bg_${userCode}_${friendCode}`, uri);
      }
    } catch (e) {
      if (setPickerActive) setPickerActive(false);
      console.error(e);
    }
  };

  const handleRemoveBackground = async () => {
    setChatBackground(null);
    await AsyncStorage.removeItem(`@bg_${userCode}_${friendCode}`);
    setTopMenuVisible(false);
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
              <Text key={index} style={{ color: '#00bfff', textDecorationLine: 'underline' }} onPress={() => Linking.openURL(part).catch(() => toast('Não foi possível abrir o link.', { tone: 'error' }))}>
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

    // Fallback para Android: em listas invertidas, onEndReached pode nao disparar
    // novamente depois da primeira pagina. Ao chegar no extremo das mensagens antigas,
    // carregamos a proxima pagina manualmente.
    const { contentSize, layoutMeasurement } = event.nativeEvent;
    if (yOffset + layoutMeasurement.height >= contentSize.height - 140) {
      loadOlderMessages();
    }
  };

  // Com FlatList invertida, chegar ao "fim" significa ter chegado às mensagens antigas.
  // Carregamos em páginas para o histórico não ficar limitado pelo cache ou pela resposta inicial.
  const loadOlderMessages = async () => {
    if (!hasOlderMessages || loadingOlderMessagesRef.current) return;
    loadingOlderMessagesRef.current = true;
    setLoadingOlderMessages(true);
    try {
      const clearedStr = await AsyncStorage.getItem(`@cleared_${userCode}_${friendCode}`);
      const clearedTime = clearedStr ? new Date(clearedStr).getTime() : 0;
      const myCode = userCode.trim().toLowerCase();
      const frCode = friendCode.trim().toLowerCase();
      const roomFilter = isGroupChat
        ? `receiver_code.eq.${frCode}`
        : `and(sender_code.eq.${myCode},receiver_code.eq.${frCode}),and(sender_code.eq.${frCode},receiver_code.eq.${myCode}),and(sender_code.eq.${AI_SENDER_CODE},receiver_code.eq.${roomKey})`;
      const from = messagesOffsetRef.current;
      const { data, error } = await supabase
        .from('mensagens')
        .select('*')
        .or(roomFilter)
        .order('created_at', { ascending: false })
        .range(from, from + MESSAGE_PAGE_SIZE - 1);
      if (error) throw error;

      const page = (data || []).filter(m => new Date(m.created_at).getTime() > clearedTime);
      messagesOffsetRef.current += data?.length || 0;
      setHasOlderMessages((data?.length || 0) === MESSAGE_PAGE_SIZE);
      if (page.length > 0) {
        setMessages(prev => {
          const existingIds = new Set(prev.map(m => m.id));
          return [...prev, ...page.filter(m => !existingIds.has(m.id))];
        });
      }
    } catch (error) {
      console.warn('Erro ao carregar mensagens antigas:', error);
    } finally {
      loadingOlderMessagesRef.current = false;
      setLoadingOlderMessages(false);
    }
  };

  // Carrega uma janela em torno de uma mensagem antiga antes de navegar até ela.
  // Assim a busca e as respostas nunca deixam uma mensagem solta entre as recentes.
  const loadMessageContext = async (messageId) => {
    const myCode = userCode.trim().toLowerCase();
    const frCode = friendCode.trim().toLowerCase();
    const roomFilter = isGroupChat
      ? `receiver_code.eq.${frCode}`
      : `and(sender_code.eq.${myCode},receiver_code.eq.${frCode}),and(sender_code.eq.${frCode},receiver_code.eq.${myCode}),and(sender_code.eq.${AI_SENDER_CODE},receiver_code.eq.${roomKey})`;
    const { data: target, error: targetError } = await supabase
      .from('mensagens')
      .select('*')
      .eq('id', messageId)
      .or(roomFilter)
      .maybeSingle();
    if (targetError) throw targetError;
    if (!target) return null;

    const [newer, older] = await Promise.all([
      supabase.from('mensagens').select('*').or(roomFilter).gt('created_at', target.created_at).order('created_at', { ascending: true }).limit(25),
      supabase.from('mensagens').select('*').or(roomFilter).lt('created_at', target.created_at).order('created_at', { ascending: false }).limit(25)
    ]);
    if (newer.error) throw newer.error;
    if (older.error) throw older.error;
    const context = [target, ...(newer.data || []), ...(older.data || [])];
    setMessages(prev => {
      const byId = new Map(prev.map(message => [message.id, message]));
      context.forEach(message => byId.set(message.id, message));
      return Array.from(byId.values()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    });
    return context;
  };

  // Pede o salto e espera a FlatList renderizar a lista atual antes de calcular o índice.
  // Isso evita que mensagens antigas recebam um índice de uma lista ainda desatualizada.
  useEffect(() => {
    if (!scrollTarget) return;
    const dataList = [...pendingQueue, ...messages];
    const index = dataList.findIndex(message => message.id === scrollTarget.id);
    if (index === -1) return;

    const requestId = scrollTarget.requestId;
    scrollRetryCountRef.current = 0;
    const scrollToTarget = () => {
      if (scrollRequestRef.current !== requestId) return;
      try {
        flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
      } catch (error) {
        console.warn('Erro ao rolar para a mensagem:', error);
      }
      setHighlightedMessageId(scrollTarget.id);
      setTimeout(() => setHighlightedMessageId(current => current === scrollTarget.id ? null : current), 1500);
      setScrollTarget(current => current?.requestId === requestId ? null : current);
    };
    const interaction = InteractionManager.runAfterInteractions(() => {
      scrollRetryRef.current = setTimeout(scrollToTarget, 120);
    });
    return () => {
      interaction.cancel();
      if (scrollRetryRef.current) clearTimeout(scrollRetryRef.current);
    };
  }, [scrollTarget, messages, pendingQueue]);

  // 🚀 LÓGICA DE ROLAR ATÉ A MENSAGEM ORIGINAL (Como no WhatsApp)
  const handleScrollToMessage = async (messageId, ensureContext = false) => {
    const requestId = ++scrollRequestRef.current;
    try {
      const isLoaded = [...pendingQueueRef.current, ...messages].some(message => message.id === messageId);
      // Não recarrega uma mensagem que já está na tela. Para uma mensagem antiga,
      // busca o alvo e a janela ao redor dele antes de solicitar o salto.
      if (ensureContext || !isLoaded) await loadMessageContext(messageId);
    } catch (error) {
      console.warn('Erro ao carregar contexto da mensagem:', error);
    }
    // Se o usuário tocou em outra resposta enquanto esta consulta terminava, ignoramos a antiga.
    if (scrollRequestRef.current !== requestId) return;
    setScrollTarget({ id: messageId, requestId, ensureContext });
  };

  const searchResults = settledMessageSearchQuery.trim().length > 0
    ? Array.from(new Map([
        ...[...pendingQueue, ...messages].filter(m => {
        const searchableText = `${m.content || ''} ${m.link_url || ''} ${m.preview_title || ''} ${m.preview_description || ''} ${m.preview_site_name || ''} ${m.media_type || ''}`.toLowerCase();
        return searchableText.includes(settledMessageSearchQuery.trim().toLowerCase());
        }),
        ...serverSearchResults
      ].map(message => [message.id, message])).values()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    : [];

  const openMessageSearch = () => {
    setIsSearchMode(true);
    setTopMenuVisible(false);
    setTimeout(() => messageSearchInputRef.current?.focus(), 100);
  };

  const closeMessageSearch = () => {
    setIsSearchMode(false);
    setMessageSearchQuery('');
    setSettledMessageSearchQuery('');
    setServerSearchResults([]);
    setSearchResultIndex(0);
    setHighlightedMessageId(null);
  };

  const jumpToSearchResult = (direction = 0) => {
    if (searchResults.length === 0) return;
    const nextIndex = (searchResultIndex + direction + searchResults.length) % searchResults.length;
    setSearchResultIndex(nextIndex);
    handleScrollToMessage(searchResults[nextIndex].id, true);
  };

  useEffect(() => {
    const timer = setTimeout(() => setSettledMessageSearchQuery(messageSearchQuery), MESSAGE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [messageSearchQuery]);

  // A busca não fica limitada à página que já está na tela: depois da pausa na
  // digitação ela consulta também o histórico do servidor e inclui os achados.
  useEffect(() => {
    const query = settledMessageSearchQuery.trim();
    const requestId = ++messageSearchRequestRef.current;
    // Nunca misturamos os resultados da busca anterior com a nova enquanto ela carrega.
    setServerSearchResults([]);
    if (query.length < MIN_MESSAGE_SEARCH_LENGTH) return;
    let cancelled = false;
    const findInHistory = async () => {
      const myCode = userCode.trim().toLowerCase();
      const frCode = friendCode.trim().toLowerCase();
      const roomFilter = isGroupChat
        ? `receiver_code.eq.${frCode}`
        : `and(sender_code.eq.${myCode},receiver_code.eq.${frCode}),and(sender_code.eq.${frCode},receiver_code.eq.${myCode}),and(sender_code.eq.${AI_SENDER_CODE},receiver_code.eq.${roomKey})`;
      // A busca anterior usava limit(100), então as setas só conheciam os 100
      // achados mais recentes. Buscamos todas as páginas para incluir o histórico.
      const allResults = [];
      let from = 0;
      while (!cancelled && requestId === messageSearchRequestRef.current) {
        const { data, error } = await supabase
          .from('mensagens')
          .select('*')
          .or(roomFilter)
          .ilike('content', `%${query}%`)
          .order('created_at', { ascending: false })
          .range(from, from + SEARCH_PAGE_SIZE - 1);

        if (error) {
          console.warn('Erro ao buscar mensagens no servidor:', error.message);
          return;
        }
        const page = data || [];
        allResults.push(...page);
        if (page.length < SEARCH_PAGE_SIZE) break;
        from += page.length;
      }
      if (cancelled || requestId !== messageSearchRequestRef.current) return;
      setServerSearchResults(allResults);
    };
    findInHistory().catch(error => console.warn('Erro ao pesquisar mensagens:', error));
    return () => { cancelled = true; };
  }, [settledMessageSearchQuery, userCode, friendCode, isGroupChat, roomKey]);

  useEffect(() => {
    setSearchResultIndex(0);
    if (searchResults.length > 0) {
      const target = searchResults[0];
      const timer = setTimeout(() => handleScrollToMessage(target.id, true), 80);
      return () => clearTimeout(timer);
    }
  }, [settledMessageSearchQuery, searchResults.length, searchResults[0]?.id]);

  const renderItem = useCallback(({ item, index }) => {
    const allData = [...pendingQueue, ...messages];
    const nextItem = allData[index + 1];
    const showDateSeparator = !nextItem || getDateLabel(item.created_at) !== getDateLabel(nextItem.created_at);

    const isAiMessage = item.sender_code === AI_SENDER_CODE || item.media_type === 'ai';
    const isMyMessage = !isAiMessage && item.sender_code === userCode;
    const timeString = new Date(item.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const quotedMsg = item.reply_to_id ? (messages.find(m => m.id === item.reply_to_id) || replyTargets[item.reply_to_id]) : null;
    const quotedHasThumbnail = hasReplyThumbnail(quotedMsg);
    const rList = item.reacoes ? Object.values(item.reacoes).filter(Boolean) : [];

    // 🚀 LÓGICA DE SPOILER
    const isSpoiler = item.media_type?.includes('_spoiler');
    const isRevealed = revealedSpoilers.has(item.id);

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

    const bubbleBaseColor = isMyMessage ? myBubbleColor : theirBubbleColor;

    // 🚀 LÓGICA DE TRANSLUCIDEZ ABSOLUTA (Converte a cor sólida para RGBA dinâmico a 65%)
    const getTranslucentBg = (hex) => {
      let c = hex.replace('#', '');
      if (c.length === 3) c = c.split('').map(x=>x+x).join('');
      if (c.length !== 6) return hex;
      return `rgba(${parseInt(c.slice(0,2),16)}, ${parseInt(c.slice(2,4),16)}, ${parseInt(c.slice(4,6),16)}, 0.65)`;
    };

    // 🚀 MAPA DE CORES COORDENADAS (Relógio e Ticks combinam perfeitamente com a cor do balão)
    const getTimeColor = (hex) => {
      const map = {
        '#1e293b': '#94a3b8', '#2563eb': '#bfdbfe', '#16a34a': '#bbf7d0', '#d97706': '#fde68a',
        '#dc2626': '#fecaca', '#9333ea': '#e9d5ff', '#475569': '#cbd5e1', '#0284c7': '#bae6fd',
        '#0d0d0d': '#71717a', '#3f3f46': '#a1a1aa', '#064e3b': '#a7f3d0', '#1e3a8a': '#bfdbfe',
        '#4c1d95': '#ddd6fe', '#881337': '#fecdd3', '#262626': '#a3a3a3'
      };
      return map[hex.toLowerCase()] || 'rgba(255,255,255,0.6)';
    };

    const bubbleBg = getTranslucentBg(bubbleBaseColor);
    const timeColor = getTimeColor(bubbleBaseColor);
    const bubbleBorder = isMyMessage ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.08)';

    let statusIcon = <Ionicons name="checkmark-done" size={15} color={item.read_at && showBlueTicks ? '#38bdf8' : timeColor} style={{ marginLeft: 4 }} />;
    if (item.status === 'sending') {
      statusIcon = <Ionicons name="time-outline" size={15} color={timeColor} style={{ marginLeft: 4 }} />;
    } else if (item.status === 'failed') {
      statusIcon = <Ionicons name="alert-circle" size={15} color="#ef4444" style={{ marginLeft: 4 }} />;
    }

    const isHighlighted = item.id === highlightedMessageId;

    return (
      <View style={{ width: '100%' }}>
        {showDateSeparator && (
          <View style={styles.dateSeparator}>
            <View style={styles.dateSeparatorLine} />
            <Text style={styles.dateSeparatorText}>{getDateLabel(item.created_at)}</Text>
            <View style={styles.dateSeparatorLine} />
          </View>
        )}
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

            if (isSpoiler && !isRevealed) {
              setRevealedSpoilers(prev => new Set(prev).add(item.id));
              return;
            }

            if (!hasTriggeredShort.current && !hasTriggeredLong.current) {
              if (item.status === 'failed') {
                forceManualRetry(item.id);
              } else if (item.media_url) { // 🚀 Lógica de clique em Mídia
                if (item.media_type === 'sticker') {
                  handleStickerPress(item.media_url, item); // Abre o modal de ações para a figurinha
                } else if (item.media_type === 'video' || item.media_type === 'video_spoiler') {
                  setFullscreenVideo(item.media_url);
                } else if (item.media_type === 'image' || item.media_type === 'image_spoiler') {
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
        isAiMessage && styles.aiBubble,
        { backgroundColor: bubbleBg, borderWidth: 1, borderColor: bubbleBorder, maxWidth: SCREEN_WIDTH * 0.78 },
        isEmojiOnly && { backgroundColor: 'transparent', borderWidth: 0, elevation: 0, paddingBottom: 4 },
        item.media_type === 'sticker' && { backgroundColor: 'transparent', borderWidth: 0, elevation: 0, paddingBottom: 4 },
        isHighlighted && { borderColor: DEFAULT_APP_THEME_COLOR, borderWidth: 2, shadowColor: DEFAULT_APP_THEME_COLOR, shadowOpacity: 0.8, shadowRadius: 10, elevation: 10 }
      ]}
        >
          {quotedMsg && (
            <TouchableOpacity activeOpacity={0.8} onPress={() => handleScrollToMessage(quotedMsg.id, true)}>
              <View style={styles.quoteInsideBubble}>
                <View style={styles.replyPreviewContent}>
                  <View style={styles.replyPreviewText}>
                    {quotedMsg.link_url && !quotedMsg.media_url && (
                      <Text style={styles.quoteInsideLabel} numberOfLines={1}>{getLinkDomain(quotedMsg.link_url)}</Text>
                    )}
                    <Text style={styles.quoteInsideText} numberOfLines={1}>{getReplyPreviewText(quotedMsg)}</Text>
                  </View>
                  {quotedHasThumbnail && <ReplyPreviewThumbnail message={quotedMsg} />}
                </View>
              </View>
            </TouchableOpacity>
          )}

          {item.media_url ? (
            <View>
              {isSpoiler && !isRevealed ? ( // 🚀 Bloco cinza sólido para spoiler
                <View style={[styles.imageBubble, { width: IMAGE_SIZE, height: IMAGE_SIZE, backgroundColor: '#334155', justifyContent: 'center', alignItems: 'center' }]}>
                  <Ionicons name="eye-outline" size={32} color="#94a3b8" />
                  <Text style={{ color: '#94a3b8', fontWeight: 'bold', marginTop: 8 }}>Toque para ver</Text>
                </View>
              ) : (item.media_type === 'video' || item.media_type === 'video_spoiler') ? (
                <TouchableOpacity activeOpacity={0.85} onPress={() => setFullscreenVideo(item.media_url)} style={[styles.imageBubble, { width: IMAGE_SIZE, height: IMAGE_SIZE, backgroundColor: '#1E293B', overflow: 'hidden', justifyContent: 'center', alignItems: 'center' }]}>
                  <Video source={{ uri: item.media_url }} style={StyleSheet.absoluteFill} resizeMode={ResizeMode.COVER} shouldPlay={false} isMuted={true} />
                  <View style={{ position: 'absolute', backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 24 }}><Ionicons name="play-circle" size={48} color="#fff" /></View>
                  <TouchableOpacity style={styles.downloadBtn} onPress={() => handleDownloadMedia(item.media_url, item.media_type)}><Ionicons name="download" size={18} color="#fff" /></TouchableOpacity>
                </TouchableOpacity>
              ) : item.media_type === 'document' ? (
                <TouchableOpacity activeOpacity={0.8} onPress={() => handleDownloadAndShareFile(item.media_url, item.content)} style={[styles.documentBubble, { width: IMAGE_SIZE }]}>
                  <Ionicons name={getDocumentIcon(item.content)} size={40} color="#cbd5e1" />
                  <View style={styles.documentInfo}>
                    <Text style={styles.documentName} numberOfLines={3}>{(item.content || '|').split('|')[0] || 'Documento'}</Text>
                    <Text style={styles.documentSize}>{(item.content || '|').split('|')[1]}</Text>
                  </View>
                </TouchableOpacity>
              ) : item.media_type === 'audio' ? (
                <AudioBubble
                  item={item}
                  width={AUDIO_BUBBLE_WIDTH}
                  isThisAudioLoaded={currentlyPlaying === item.id}
                  isPlaying={currentlyPlaying === item.id && !!playbackStatus?.isPlaying}
                  positionMillis={currentlyPlaying === item.id ? (playbackStatus?.positionMillis || 0) : 0}
                  durationMillis={currentlyPlaying === item.id ? (playbackStatus?.durationMillis || 1) : 1}
                  onToggle={togglePlayback}
                  onSeek={seekAudio}
                  timeString={timeString}
                  timeColor={timeColor}
                  statusIcon={statusIcon}
                  isMyMessage={isMyMessage}
                  accentColor={DEFAULT_APP_THEME_COLOR}
                  accentTextColor="#0d0d0d"
                />
              ) : item.media_type === 'sticker' ? (
                <View style={{ position: 'relative' }}>
                  <Image source={{ uri: item.media_url }} style={{ width: 160, height: 160 }} resizeMode="contain" />
                </View>
              ) : (
                <View style={{ position: 'relative' }}>
                  <Image source={{ uri: item.media_url }} style={[styles.imageBubble, { width: IMAGE_SIZE, height: IMAGE_SIZE }]} resizeMode="cover" />
                  <TouchableOpacity style={styles.downloadBtn} onPress={() => handleDownloadMedia(item.media_url, item.media_type)}><Ionicons name="download" size={18} color="#fff" /></TouchableOpacity>
                </View>
              )}
              {item.media_type !== 'audio' && (
                <View style={[styles.bubbleFooter, item.media_type === 'sticker' ? { backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, alignSelf: 'flex-end', marginTop: -5 } : { paddingHorizontal: 8, paddingBottom: 6, paddingTop: 4, justifyContent: 'space-between', width: '100%' }]}>
                  {item.media_type !== 'sticker' && item.media_type !== 'document' && item.content && (item.content.includes('MB') || item.content.includes('KB')) ? (
                    <Text style={[styles.messageTime, { color: timeColor, fontWeight: 'bold' }]}>{(item.content || '').split('|')[0]}</Text>
                  ) : <View />}
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text style={[styles.messageTime, { color: item.media_type === 'sticker' ? '#fff' : timeColor }]}>{timeString}</Text>
                    {isMyMessage && statusIcon}
                  </View>
                </View>
              )}
            </View>
          ) : (
            <>
              {isAiMessage && (
                <View style={styles.aiMessageHeader}>
                  <Text style={styles.aiMessageLabel}>{aiDisplayName}</Text>
                </View>
              )}
              {renderMessageText(item.content, item.status === 'failed', isEmojiOnly)}
              {!!item.link_url && (item.preview_title || item.preview_description || item.preview_image_url) && (
                <TouchableOpacity style={styles.linkPreviewCard} activeOpacity={0.85} onPress={() => Linking.openURL(item.link_url).catch(() => toast('Não foi possível abrir o link.', { tone: 'error' }))}>
                  {!!item.preview_image_url && <Image source={{ uri: item.preview_image_url }} style={styles.linkPreviewImage} />}
                  <View style={styles.linkPreviewTextContainer}>
                    {!!item.preview_site_name && <Text style={styles.linkPreviewSite} numberOfLines={1}>{item.preview_site_name}</Text>}
                    {!!item.preview_title && <Text style={styles.linkPreviewTitle} numberOfLines={1}>{item.preview_title}</Text>}
                    {!!item.preview_description && <Text style={styles.linkPreviewDesc} numberOfLines={1}>{item.preview_description}</Text>}
                    <Text style={styles.linkPreviewUrl} numberOfLines={1}>{item.link_url}</Text>
                  </View>
                </TouchableOpacity>
              )}
              <View style={[styles.bubbleFooter, isEmojiOnly && { backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, alignSelf: 'flex-end', marginTop: -5 }]}>
                <Text style={[styles.messageTime, { color: isEmojiOnly ? '#fff' : timeColor }]}>{timeString}</Text>
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
      </View>
    );
  }, [userCode, myBubbleColor, theirBubbleColor, aiDisplayName, highlightedMessageId, showBlueTicks, messages, revealedSpoilers, pendingQueue, replyingTo, SCREEN_WIDTH, IMAGE_SIZE, favoriteGifs, currentlyPlaying, playbackStatus]);


  const extraDataKey = renderKey + '|' + showBlueTicks + '|' + highlightedMessageId + '|' + currentlyPlaying + '|' + (playbackStatus?.positionMillis || 0) + '|' + (playbackStatus?.isPlaying ? '1' : '0') + '|' + messages.map(m => `${m.id}-${m.read_at}-${JSON.stringify(m.reacoes)}`).join('|');

  // 🚀 LÓGICA DE NAVEGAÇÃO DE MÍDIA EM TELA CHEIA
  const navigateFullscreenMedia = (direction) => {
    const newIndex = fullscreenMediaIndex + direction;
    if (newIndex >= 0 && newIndex < fullscreenMediaList.length) {
      setFullscreenMediaIndex(newIndex);
      const newItem = fullscreenMediaList[newIndex];
      if (newItem.media_type?.startsWith('video')) {
        setFullscreenVideo(newItem.media_url);
        setFullscreenImage(null); // Garante que apenas um esteja ativo
      } else {
        setFullscreenImage(newItem.media_url);
        setFullscreenVideo(null); // Garante que apenas um esteja ativo
      }
    }
  };

  // 🚀 EFEITO PARA RESETAR O PLAYER DE VÍDEO AO MUDAR DE MÍDIA
  const fullscreenVideoPlayerRef = useRef(null);
  useEffect(() => {
    // Se o player de vídeo estiver ativo e o índice da mídia mudar, descarrega o vídeo anterior
    if (fullscreenVideoPlayerRef.current && !fullscreenVideo) {
      fullscreenVideoPlayerRef.current.unloadAsync().catch(() => {});
    }
  }, [fullscreenMediaIndex, fullscreenVideo]); // Reset player when index or video URL changes

  // Determine current media URL and type for fullscreen view
  const currentFullscreenMedia = fullscreenMediaList[fullscreenMediaIndex];
  const currentFullscreenMediaUrl = currentFullscreenMedia?.media_url;
  const currentFullscreenMediaType = currentFullscreenMedia?.media_type;

  const showPrevButton = fullscreenMediaIndex > 0;
  const showNextButton = fullscreenMediaIndex < fullscreenMediaList.length - 1;
  const gallerySourceMessages = galleryMessages || messages;
  const sharedMedia = gallerySourceMessages.filter(m => m.media_url && (m.media_type?.startsWith('image') || m.media_type?.startsWith('video')));
  const sharedDocuments = gallerySourceMessages.filter(m => m.media_type === 'document');
  const sharedLinks = gallerySourceMessages.filter(m => !m.media_url && (m.link_url || /https?:\/\/[^\s]+/i.test(m.content || '')));
  const galleryItems = mediaGalleryTab === 'media' ? sharedMedia : (mediaGalleryTab === 'docs' ? sharedDocuments : sharedLinks);

  return (
    <SafeAreaView style={styles.mainContainer}>
      <StatusBar barStyle="light-content" backgroundColor="#0d0d0d" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
        keyboardVerticalOffset={Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) + 10 : 0}
      >

        <View style={styles.chatHeader}>
          <TouchableOpacity onPress={isSearchMode ? closeMessageSearch : onBack} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="chevron-back" size={24} color={DEFAULT_APP_THEME_COLOR} />
          </TouchableOpacity>
          <View style={styles.headerInfo} onTouchEnd={openGroupInfo}>
            <Text style={styles.friendName} numberOfLines={1}>{currentFriendName}</Text>
            <Text style={styles.friendStatus}>
              {showBlueTicks && friendLastSeen ? `${friendCode} • ${formatLastSeen(friendLastSeen)}` : friendCode}
            </Text>
          </View>

          <TouchableOpacity
            onPress={onTogglePrivacyBypass}
            style={[styles.menuBtn, privacyBypassEnabled && styles.privacyBypassActive]}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel={privacyBypassEnabled ? 'Ativar privacidade' : 'Desativar privacidade temporariamente'}
          >
            <Ionicons name={privacyBypassEnabled ? 'eye-off-outline' : 'eye-outline'} size={20} color={privacyBypassEnabled ? '#22c55e' : DEFAULT_APP_THEME_COLOR} />
          </TouchableOpacity>

          <TouchableOpacity onPress={openMessageSearch} style={styles.menuBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="search-outline" size={20} color={DEFAULT_APP_THEME_COLOR} />
          </TouchableOpacity>

          <TouchableOpacity onPress={() => setTopMenuVisible(true)} style={styles.menuBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="ellipsis-vertical" size={20} color={DEFAULT_APP_THEME_COLOR} />
          </TouchableOpacity>
        </View>

        {isSearchMode && (
          <View style={styles.messageSearchBar}>
            <Ionicons name="search-outline" size={18} color="#64748B" />
            <TextInput
              ref={messageSearchInputRef}
              style={styles.messageSearchInput}
              placeholder="Pesquisar mensagens"
              placeholderTextColor="#64748B"
              value={messageSearchQuery}
              onChangeText={setMessageSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={() => jumpToSearchResult(0)}
            />
            <Text style={styles.searchCounter}>
              {messageSearchQuery.trim() ? `${searchResults.length ? searchResultIndex + 1 : 0}/${searchResults.length}` : ''}
            </Text>
            <TouchableOpacity onPress={() => jumpToSearchResult(1)} disabled={searchResults.length === 0} style={styles.searchNavBtn} hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}>
              <Ionicons name="chevron-up" size={20} color={searchResults.length ? DEFAULT_APP_THEME_COLOR : "#334155"} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => jumpToSearchResult(-1)} disabled={searchResults.length === 0} style={styles.searchNavBtn} hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}>
              <Ionicons name="chevron-down" size={20} color={searchResults.length ? DEFAULT_APP_THEME_COLOR : "#334155"} />
            </TouchableOpacity>
            <TouchableOpacity onPress={closeMessageSearch} style={styles.searchNavBtn} hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}>
              <Ionicons name="close" size={20} color="#64748B" />
            </TouchableOpacity>
          </View>
        )}

        {pinnedMessage && (
          <TouchableOpacity onPress={() => handleScrollToMessage(pinnedMessage.id)} style={styles.pinnedBar}>
            <View style={styles.pinnedBarLeft}>
              <Ionicons name="pin" size={14} color={DEFAULT_APP_THEME_COLOR} style={{ marginRight: 8 }} />
              <View>
                <Text style={styles.pinnedLabel}>Mensagem fixada</Text>
                <Text style={styles.pinnedText} numberOfLines={1}>
                  {getPinnedMessagePreview(pinnedMessage)}
                </Text>
              </View>
            </View>
            <TouchableOpacity onPress={handleUnpinMessage} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
              <Ionicons name="close" size={16} color="#64748B" />
            </TouchableOpacity>
          </TouchableOpacity>
        )}

        <ImageBackground
          source={chatBackground ? { uri: chatBackground } : null}
          style={{ flex: 1, backgroundColor: '#050505', position: 'relative' }}
          imageStyle={{ opacity: 0.35 }}
        >
          {loading ? (
            <ActivityIndicator size="large" color={DEFAULT_APP_THEME_COLOR} style={{ flex: 1 }} />
          ) : (
            <FlatList
              ref={flatListRef}
              data={[...pendingQueue, ...messages]}
              keyExtractor={(item) => String(item.id)}
              renderItem={renderItem}
              extraData={extraDataKey}
              inverted
              contentContainerStyle={[styles.messagesList, { paddingHorizontal: SCREEN_WIDTH < 360 ? 8 : 12 }]}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              onScroll={handleScroll}
              scrollEventThrottle={16}
              onEndReached={loadOlderMessages}
              onEndReachedThreshold={0.35}
              ListFooterComponent={loadingOlderMessages ? <ActivityIndicator size="small" color={DEFAULT_APP_THEME_COLOR} style={{ marginVertical: 14 }} /> : null}
              onScrollToIndexFailed={info => {
                if (scrollRetryRef.current) clearTimeout(scrollRetryRef.current);
                if (scrollRetryCountRef.current >= 6) return;
                scrollRetryCountRef.current += 1;
                // Primeiro aproxima a janela virtualizada; só depois tenta o índice exato.
                const estimatedOffset = Math.max(0, (info.averageItemLength || 72) * info.index);
                flatListRef.current?.scrollToOffset({ offset: estimatedOffset, animated: false });
                scrollRetryRef.current = setTimeout(() => {
                  flatListRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.5 });
                }, 180);
              }}
            />
          )}
          {showScrollToBottom && (
            <TouchableOpacity
              style={styles.scrollToBottomBtn}
              onPress={() => {
                try {
                  flatListRef.current?.scrollToIndex({ index: 0, animated: true });
                } catch (e) {}
              }}
            >
              <Ionicons name="chevron-down" size={22} color="#64748B" />
            </TouchableOpacity>
          )}
        </ImageBackground>

        {/* 🚀 Janela de Sugestão de Stickers por Emoji */}
        {showEmojiSuggestions && (
          <View style={styles.suggestionContainer}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 10 }}
              scrollEventThrottle={16}
              onScroll={({ nativeEvent }) => {
                const distanceFromEnd = nativeEvent.contentSize.width - (nativeEvent.contentOffset.x + nativeEvent.layoutMeasurement.width);
                if (distanceFromEnd < 180) loadEmojiSuggestions(emojiSuggestionSearchRef.current);
              }}
            >
              {emojiSuggestions.map(gif => (
                <TouchableOpacity
                  key={gif.id}
                  style={styles.suggestionItem}
                  onPress={() => {
                    handleSendSticker(`https://media2.giphy.com/media/${gif.id}/200.gif`);
                    setShowEmojiSuggestions(false);
                    setInputText('');
                    inputTextRef.current = '';
                  }}
                >
                  <Image source={{ uri: gif.images.fixed_width.url }} style={styles.suggestionImage} />
                </TouchableOpacity>
              ))}
              {emojiSuggestionLoadingRef.current && <ActivityIndicator size="small" color={DEFAULT_APP_THEME_COLOR} style={{ marginHorizontal: 12 }} />}
            </ScrollView>
          </View>
        )}

        {replyingTo && (
          <View style={styles.replyBarContainer}>
            <View style={styles.replyBarLeft}>
              <View style={styles.replyPreviewContent}>
                <View style={styles.replyPreviewText}>
                  <Text style={styles.replyUserTarget}>{replyingTo.link_url && !replyingTo.media_url ? getLinkDomain(replyingTo.link_url) : 'Respondendo'}</Text>
                  <Text style={styles.replyTextTarget} numberOfLines={1}>{getReplyPreviewText(replyingTo)}</Text>
                </View>
                {hasReplyThumbnail(replyingTo) && <ReplyPreviewThumbnail message={replyingTo} />}
              </View>
            </View>
            <TouchableOpacity onPress={() => setReplyingTo(null)}><Ionicons name="close-circle" size={20} color="#ef4444" /></TouchableOpacity>
          </View>
        )}

        <View style={[styles.inputWrapper, { backgroundColor: '#0d0d0d' }]}>
          <View style={styles.inputContainer}>
            {!recordedPreview && (
              <TouchableOpacity onPress={() => setAttachMenuVisible(true)} style={styles.attachBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="attach-outline" size={24} color="#64748B" />
              </TouchableOpacity>
            )}
            {recordedPreview ? (
              <View style={styles.audioPreviewBar}>
                <TouchableOpacity onPress={handleDeleteRecordedPreview} style={styles.previewDeleteBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="trash-outline" size={22} color="#ef4444" />
                </TouchableOpacity>

                <TouchableOpacity onPress={togglePreviewPlayback} style={styles.previewPlayBtn}>
                  <Ionicons name={isPreviewPlaying ? 'pause' : 'play'} size={18} color="#0d0d0d" />
                </TouchableOpacity>

                <View style={styles.previewSliderContainer}>
                  <Slider
                    style={{ flex: 1 }}
                    minimumValue={0}
                    maximumValue={1}
                    value={previewStatus?.durationMillis ? previewStatus.positionMillis / previewStatus.durationMillis : 0}
                    minimumTrackTintColor={DEFAULT_APP_THEME_COLOR}
                    maximumTrackTintColor="#64748B"
                    thumbTintColor="#fff"
                    onSlidingComplete={seekPreviewAudio}
                  />
                  <Text style={styles.previewDurationText}>
                    {previewStatus?.positionMillis
                      ? `${Math.floor(previewStatus.positionMillis / 60000)}:${String(Math.floor((previewStatus.positionMillis % 60000) / 1000)).padStart(2, '0')}`
                      : recordedPreview.duration}
                  </Text>
                </View>
              </View>
            ) : isRecording ? (
              <View style={styles.recordingGestureArea}>
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.recordingCancelBackdrop,
                    {
                      opacity: recordingDragX.interpolate({
                        inputRange: [-130, -45],
                        outputRange: [1, 0],
                        extrapolate: 'clamp',
                      }),
                    },
                  ]}
                >
                  <Ionicons name="trash-outline" size={18} color="#ef4444" />
                  <Text style={[styles.recordingCancelText, isRecordingCancelArmed && styles.recordingCancelTextArmed]}>
                    {isRecordingCancelArmed ? 'Solte para cancelar' : 'Arraste para cancelar'}
                  </Text>
                </Animated.View>

                <Animated.View
                  style={[styles.recordingIndicator, { transform: [{ translateX: recordingDragX }] }]}
                  {...recordingPanResponder.panHandlers}
                >
                  <TouchableOpacity onPress={handleCancelRecording} style={styles.previewDeleteBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="trash-outline" size={22} color="#ef4444" />
                  </TouchableOpacity>

                  <TouchableOpacity onPress={isPaused ? handleResumeRecording : handlePauseRecording} style={styles.previewPlayBtn}>
                    <Ionicons name={isPaused ? 'mic' : 'pause'} size={16} color="#0d0d0d" />
                  </TouchableOpacity>

                  <View style={styles.recordingInfoContainer}>
                    {!isPaused && <View style={styles.recordingDot} />}
                    <Text style={styles.recordingTimer}>{Math.floor(recordingDuration / 60)}:{(recordingDuration % 60).toString().padStart(2, '0')}</Text>
                    <Text style={[styles.recordingSlideText, isRecordingCancelArmed && styles.recordingSlideTextArmed]}>
                      {isPaused ? 'Pausado' : 'Gravando...'}
                    </Text>
                  </View>
                </Animated.View>
              </View>
            ) : (
              <View style={styles.textInputContainer}>
                <TextInput ref={textInputRef} style={styles.textInput} placeholder="Digite sua mensagem..." placeholderTextColor="#475569" value={inputText} onChangeText={handleTextChange} onFocus={() => onUserActivity?.()} multiline maxLength={2000} />
                <TouchableOpacity onPress={() => { setGiphySearch(''); setGiphyTab('recent'); setGiphyModalVisible(true); }} style={styles.giphyBtnInside} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="happy-outline" size={26} color="#64748B" />
                </TouchableOpacity>
              </View>
            )}
            {recordedPreview ? (
              <TouchableOpacity style={styles.sendBtn} onPress={handleSendRecordedPreview}><Ionicons name="send" size={18} color="#000" /></TouchableOpacity>
            ) : (inputText.trim().length > 0) ? (
              <TouchableOpacity style={styles.sendBtn} onPress={handleSendComposer}><Ionicons name="send" size={18} color="#000" /></TouchableOpacity>
            ) : isRecording ? (
              <TouchableOpacity style={styles.sendBtn} onPress={stopRecording}><Ionicons name="checkmark" size={22} color="#000" /></TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.sendBtn} onPress={startRecording}><Ionicons name="mic" size={22} color="#000" /></TouchableOpacity>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* MODAL 1.1: Menu de Anexos (Clipe) */}
      <Modal animationType="fade" transparent visible={attachMenuVisible} onRequestClose={() => setAttachMenuVisible(false)}>
        <TouchableOpacity style={styles.attachMenuOverlay} activeOpacity={1} onPress={() => setAttachMenuVisible(false)}>
          <View style={styles.attachMenuContent}>
            <TouchableOpacity style={styles.attachMenuItem} onPress={() => handleSelectMedia('camera_photo')}><Ionicons name="camera-outline" size={22} color={DEFAULT_APP_THEME_COLOR} style={{ marginRight: 15 }} /><Text style={styles.menuItemText}>Foto</Text></TouchableOpacity>
            <TouchableOpacity style={styles.attachMenuItem} onPress={() => handleSelectMedia('camera_video')}><Ionicons name="videocam-outline" size={22} color="#ef4444" style={{ marginRight: 15 }} /><Text style={styles.menuItemText}>Vídeo</Text></TouchableOpacity>
            <TouchableOpacity style={styles.attachMenuItem} onPress={() => handleSelectMedia('gallery')}><Ionicons name="images-outline" size={22} color="#3b82f6" style={{ marginRight: 15 }} /><Text style={styles.menuItemText}>Galeria</Text></TouchableOpacity>
            <TouchableOpacity style={styles.attachMenuItem} onPress={handleSelectDocument}><Ionicons name="document-text-outline" size={22} color="#8b5cf6" style={{ marginRight: 15 }} /><Text style={styles.menuItemText}>Documento</Text></TouchableOpacity>
            <TouchableOpacity style={styles.attachMenuItem} onPress={() => handleSelectMedia('gallery_spoiler')}><Ionicons name="eye-off-outline" size={22} color="#f472b6" style={{ marginRight: 15 }} /><Text style={styles.menuItemText}>Spoiler</Text></TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* MODAL 1.2: Menu do Topo (Geral) */}
      <Modal animationType="fade" transparent visible={topMenuVisible} onRequestClose={() => setTopMenuVisible(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setTopMenuVisible(false)}>
          <View style={[styles.menuContent, { width: Math.min(SCREEN_WIDTH * 0.85, 320) }]}>
            <Text style={styles.menuSectionTitle}>Ações do Chat</Text>
            <TouchableOpacity style={styles.menuItem} onPress={() => { setTopMenuVisible(false); setAiMenuVisible(true); }}><Ionicons name="sparkles-outline" size={18} color={DEFAULT_APP_THEME_COLOR} style={{ marginRight: 10 }} /><Text style={styles.menuItemText}>IA</Text></TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={() => { setTopMenuVisible(false); setMediaGalleryVisible(true); }}><Ionicons name="images-outline" size={18} color="#fff" style={{ marginRight: 10 }} /><Text style={styles.menuItemText}>Mídias do Chat</Text></TouchableOpacity>
            {!isGroupChat && (
              <TouchableOpacity style={styles.menuItem} onPress={() => { setTopMenuVisible(false); setEditNameVisible(true); }}><Ionicons name="create-outline" size={18} color="#fff" style={{ marginRight: 10 }} /><Text style={styles.menuItemText}>Editar Nome</Text></TouchableOpacity>
            )}
            <TouchableOpacity style={styles.menuItem} onPress={handlePickBackground}><Ionicons name="image-outline" size={18} color="#fff" style={{ marginRight: 10 }} /><Text style={styles.menuItemText}>Plano de Fundo</Text></TouchableOpacity>
            {chatBackground && (
              <TouchableOpacity style={styles.menuItem} onPress={handleRemoveBackground}><Ionicons name="close-circle-outline" size={18} color="#ef4444" style={{ marginRight: 10 }} /><Text style={[styles.menuItemText, { color: '#ef4444' }]}>Remover Fundo</Text></TouchableOpacity>
            )}
            <TouchableOpacity style={styles.menuItem} onPress={() => { setTopMenuVisible(false); setCustomizeModalVisible(true); }}><Ionicons name="color-palette-outline" size={18} color={DEFAULT_APP_THEME_COLOR} style={{ marginRight: 10 }} /><Text style={styles.menuItemText}>Personalizar Balões</Text></TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={handleClearChat}><Ionicons name="trash-outline" size={18} color="#ef4444" style={{ marginRight: 10 }} /><Text style={[styles.menuItemText, { color: '#ef4444' }]}>Limpar Mensagens</Text></TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal animationType="slide" visible={groupInfoVisible} onRequestClose={() => setGroupInfoVisible(false)}>
        <SafeAreaView style={styles.groupInfoScreen}>
          <View style={styles.groupInfoHeader}>
            <TouchableOpacity onPress={() => setGroupInfoVisible(false)} style={styles.groupInfoBackBtn}>
              <Ionicons name="arrow-back" size={24} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.groupInfoHeaderTitle}>Dados do grupo</Text>
          </View>
          <ScrollView contentContainerStyle={styles.groupInfoContent} keyboardShouldPersistTaps="handled">
            {isGroupChat && groupPhotoDraft ? (
              <Image source={{ uri: groupPhotoDraft }} style={styles.groupInfoPhoto} />
            ) : (
              <View style={[styles.groupInfoPhoto, styles.groupInfoPhotoFallback]}><Ionicons name={isGroupChat ? "people" : "person"} size={58} color={DEFAULT_APP_THEME_COLOR} /></View>
            )}
            {isGroupChat ? (
              <>
                <TouchableOpacity style={styles.changeGroupPhotoButton} onPress={pickGroupPhotoForEdit}><Text style={styles.changeGroupPhotoText}>Alterar foto</Text></TouchableOpacity>
                <TextInput style={styles.groupNameInput} value={groupNameDraft} onChangeText={(value) => { isEditingGroupInfoRef.current = true; setGroupNameDraft(value); }} maxLength={60} placeholder="Nome do grupo" placeholderTextColor="#64748B" />
              </>
            ) : (
              <>
                <Text style={styles.groupInfoName}>{currentFriendName}</Text>
                <TouchableOpacity style={styles.contactEditButton} onPress={() => { setGroupInfoVisible(false); setNewNameInput(currentFriendName); setEditNameVisible(true); }}><Ionicons name="create-outline" size={18} color={DEFAULT_APP_THEME_COLOR} /><Text style={styles.contactEditText}>Editar nome</Text></TouchableOpacity>
              </>
            )}
            <Text style={styles.groupInfoCode}>{friendCode}</Text>
            {!isGroupChat && (
              <View style={styles.groupInfoSection}>
                <Text style={styles.groupInfoSectionTitle}>Mídia, links e documentos</Text>
                {[
                  ['media', 'images-outline', 'Mídia', sharedMedia.length],
                  ['links', 'link-outline', 'Links', sharedLinks.length],
                  ['docs', 'document-text-outline', 'Docs', sharedDocuments.length],
                ].map(([tab, icon, label, count]) => (
                  <TouchableOpacity key={tab} style={styles.contactInfoRow} onPress={() => { setMediaGalleryTab(tab); setGroupInfoVisible(false); setMediaGalleryVisible(true); }}>
                    <Ionicons name={icon} size={22} color={DEFAULT_APP_THEME_COLOR} />
                    <Text style={styles.contactInfoRowText}>{label}</Text><Text style={styles.contactInfoCount}>{count}</Text><Ionicons name="chevron-forward" size={19} color="#64748B" />
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <View style={[styles.groupInfoSection, !isGroupChat && { display: 'none' }]}>
              <View style={styles.groupInfoSectionTitleRow}>
                <Ionicons name="information-circle-outline" size={21} color={DEFAULT_APP_THEME_COLOR} />
                <Text style={styles.groupInfoSectionTitle}>Descrição</Text>
              </View>
              <Text style={styles.groupInfoHint}>Qualquer participante pode alterar a descrição.</Text>
              <TextInput style={styles.groupDescriptionInput} value={groupDescriptionDraft} onChangeText={setGroupDescriptionDraft} placeholder="Adicione uma descrição do grupo" placeholderTextColor="#64748B" multiline maxLength={500} textAlignVertical="top" />
              <Text style={styles.groupDescriptionCounter}>{groupDescriptionDraft.length}/500</Text>
              <TouchableOpacity style={[styles.groupDescriptionSave, savingGroupDetails && { opacity: 0.65 }]} onPress={handleSaveGroupDetails} disabled={savingGroupDetails}>
                {savingGroupDetails ? <ActivityIndicator color="#03150a" /> : <Text style={styles.groupDescriptionSaveText}>Salvar alterações</Text>}
              </TouchableOpacity>
            </View>
            {isGroupChat && (
              <View style={styles.groupInfoSection}>
                <View style={styles.groupInfoSectionTitleRow}>
                  <Ionicons name="people-outline" size={21} color={DEFAULT_APP_THEME_COLOR} />
                  <Text style={styles.groupInfoSectionTitle}>Membros ({groupMembers.length})</Text>
                </View>
                {groupMembers.length > 0 ? groupMembers.map(member => (
                  <View key={member.code} style={styles.groupMemberRow}>
                    <View style={styles.groupMemberAvatar}><Text style={styles.groupMemberInitial}>{member.name.charAt(0).toUpperCase()}</Text></View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.groupMemberName}>{member.name}</Text>
                      <Text style={styles.groupMemberCode}>{member.code}</Text>
                    </View>
                  </View>
                )) : <Text style={styles.groupInfoHint}>Não foi possível carregar os membros.</Text>}
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal animationType="fade" transparent visible={aiMenuVisible} onRequestClose={() => setAiMenuVisible(false)}>
        <View style={styles.modalOverlayDark}>
          <View style={styles.aiConfigCard}>
            <View style={styles.aiConfigHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={styles.modalTitleNoMargin}>IA {aiDisplayName}</Text>
              </View>
              <TouchableOpacity onPress={() => setAiMenuVisible(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={22} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ maxHeight: Math.min(SCREEN_WIDTH * 1.25, 560) }} keyboardShouldPersistTaps="handled">
              <View style={styles.aiToggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.aiFieldLabel}>Modo IA</Text>
                  <Text style={styles.aiFieldHint}>{aiEnabled ? 'Ativo para comandos no chat' : 'Desligado'}</Text>
                </View>
                <TouchableOpacity
                  onPress={() => setAiEnabled(prev => !prev)}
                  style={[styles.aiToggle, aiEnabled && styles.aiToggleOn]}
                  activeOpacity={0.8}
                >
                  <View style={[styles.aiToggleKnob, aiEnabled && styles.aiToggleKnobOn]} />
                </TouchableOpacity>
              </View>

              <Text style={styles.aiFieldLabel}>Nome da IA</Text>
              <TextInput
                style={styles.modalInput}
                value={aiName}
                onChangeText={setAiName}
                placeholder="Ex: Luna, Atlas, Assistente"
                placeholderTextColor="#64748B"
                maxLength={24}
              />

              <Text style={styles.aiFieldLabel}>Prompt geral</Text>
              <TextInput
                style={[styles.modalInput, styles.aiMultilineInput]}
                value={aiSystemPrompt}
                onChangeText={setAiSystemPrompt}
                placeholder="Como a IA deve se comportar?"
                placeholderTextColor="#64748B"
                multiline
                textAlignVertical="top"
              />

              <Text style={styles.aiFieldLabel}>API key Gemini</Text>
              <TextInput
                style={styles.modalInput}
                value={aiApiKey}
                onChangeText={setAiApiKey}
                placeholder="Cole ou troque sua API key"
                placeholderTextColor="#64748B"
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />

              <Text style={styles.aiFieldLabel}>Modelo</Text>
              <View style={styles.aiModelGrid}>
                {GEMINI_MODELS.map(model => (
                  <TouchableOpacity
                    key={model}
                    onPress={() => setAiModel(model)}
                    style={[styles.aiModelChip, aiModel === model && styles.aiModelChipActive]}
                  >
                    <Text style={[styles.aiModelChipText, aiModel === model && styles.aiModelChipTextActive]}>{model}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TextInput
                style={styles.modalInput}
                value={aiModel}
                onChangeText={setAiModel}
                placeholder="Ou digite outro modelo"
                placeholderTextColor="#64748B"
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={styles.aiFieldLabel}>Chamada</Text>
              <TextInput
                style={styles.modalInput}
                value={aiTrigger}
                onChangeText={setAiTrigger}
                placeholder="@/"
                placeholderTextColor="#64748B"
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={12}
              />
              <Text style={styles.aiFieldHint}>Use no chat assim: {aiTrigger.trim() || '@/'} sua pergunta</Text>

              <View style={styles.aiNumbersRow}>
                <View style={styles.aiNumberField}>
                  <Text style={styles.aiFieldLabel}>Timeout</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={aiTimeoutSeconds}
                    onChangeText={(value) => setAiTimeoutSeconds(value.replace(/\D/g, '').slice(0, 3))}
                    placeholder="35"
                    placeholderTextColor="#64748B"
                    keyboardType="number-pad"
                  />
                  <Text style={styles.aiFieldHint}>10 a 120 segundos</Text>
                </View>
                <View style={styles.aiNumberField}>
                  <Text style={styles.aiFieldLabel}>Retries</Text>
                  <TextInput
                    style={styles.modalInput}
                    value={aiMaxRetries}
                    onChangeText={(value) => setAiMaxRetries(value.replace(/\D/g, '').slice(0, 1))}
                    placeholder="2"
                    placeholderTextColor="#64748B"
                    keyboardType="number-pad"
                  />
                  <Text style={styles.aiFieldHint}>0 a 5 tentativas extras</Text>
                </View>
              </View>
            </ScrollView>

            <TouchableOpacity style={styles.aiSaveBtn} onPress={() => { setAiMenuVisible(false); toast('Configurações da IA salvas.'); }}>
              <Text style={styles.aiSaveText}>Salvar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* MODAL 2: Editar Nome */}
      <Modal animationType="fade" transparent visible={editNameVisible} onRequestClose={() => { setEditNameVisible(false); setNewNameInput(currentFriendName); }}>
        <View style={styles.modalOverlayDark}>
          <View style={styles.editNameCard}>
            <Text style={styles.modalTitle}>Alterar Nome</Text>
            <TextInput style={styles.modalInput} value={newNameInput} onChangeText={setNewNameInput} maxLength={20} autoFocus />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#152233' }]} onPress={() => { setEditNameVisible(false); setNewNameInput(currentFriendName); }}><Text style={{ color: '#fff' }}>Cancelar</Text></TouchableOpacity>
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
              {reactionTargetMessage && (
                <TouchableOpacity onPress={() => handlePinMessage(reactionTargetMessage)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={!reactionTargetMessage.media_url ? { marginRight: 20 } : {}}>
                  <Ionicons name={pinnedMessage?.id === reactionTargetMessage?.id ? "pin" : "pin-outline"} size={24} color="#fff" />
                </TouchableOpacity>
              )}
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
                  {recentEmojis.map((emoji) => (
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
      {!!fullscreenImage && (
        <View style={[styles.fullscreenOverlay, { position: 'absolute', top: 0, bottom: androidNavigationInset, left: 0, right: 0, zIndex: 9999, elevation: 9999 }]}>
          <TouchableOpacity style={styles.closeFullscreenBtn} onPress={() => setFullscreenImage(null)}><Ionicons name="close" size={28} color="#fff" /></TouchableOpacity>
          {showPrevButton && (
            <TouchableOpacity style={[styles.fullscreenNavBtn, styles.fullscreenNavBtnLeft]} onPress={() => navigateFullscreenMedia(-1)}>
              <Ionicons name="chevron-back" size={32} color="#fff" />
            </TouchableOpacity>
          )}
          <Image
            source={{ uri: currentFullscreenMediaUrl || fullscreenImage }}
            style={styles.fullscreenImage}
            resizeMode="contain"
          />
          <TouchableOpacity style={styles.downloadFullscreenBtn} onPress={() => handleDownloadMedia(currentFullscreenMediaUrl || fullscreenImage, 'image')}>
            <Ionicons name="download" size={22} color="#fff" />
          </TouchableOpacity>
          {showNextButton && (
            <TouchableOpacity style={[styles.fullscreenNavBtn, styles.fullscreenNavBtnRight]} onPress={() => navigateFullscreenMedia(1)}>
              <Ionicons name="chevron-forward" size={32} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* MODAL 7: Video em Tela Cheia */}
      {!!fullscreenVideo && (
        <View style={[styles.fullscreenOverlay, { position: 'absolute', top: 0, bottom: androidNavigationInset, left: 0, right: 0, zIndex: 9999, elevation: 9999 }]}>
          <TouchableOpacity style={styles.closeFullscreenBtn} onPress={() => setFullscreenVideo(null)}><Ionicons name="close" size={28} color="#fff" /></TouchableOpacity>
          {showPrevButton && (
            <TouchableOpacity style={[styles.fullscreenNavBtn, styles.fullscreenNavBtnLeft]} onPress={() => navigateFullscreenMedia(-1)}>
              <Ionicons name="chevron-back" size={32} color="#fff" />
            </TouchableOpacity>
          )}
          <Video
            ref={fullscreenVideoPlayerRef}
            style={styles.fullscreenImage}
            source={{ uri: fullscreenVideo }}
            useNativeControls
            resizeMode={ResizeMode.CONTAIN}
            shouldPlay
            onError={(error) => {
              console.error('Erro ao reproduzir vídeo:', error);
              toast('Este vídeo não pôde ser reproduzido. Tente reenviá-lo.', { tone: 'error' });
            }}
          />
          {showNextButton && (
            <TouchableOpacity style={[styles.fullscreenNavBtn, styles.fullscreenNavBtnRight]} onPress={() => navigateFullscreenMedia(1)}>
              <Ionicons name="chevron-forward" size={32} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* MODAL 6: Mídias do Chat (estilo WhatsApp) */}
      <Modal animationType="slide" transparent visible={mediaGalleryVisible} onRequestClose={() => setMediaGalleryVisible(false)}>
        <SafeAreaView style={[styles.mainContainer, { paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 }]}>
          <View style={[styles.chatHeader, { borderBottomWidth: 1, borderColor: '#111' }]}>
            <TouchableOpacity onPress={() => setMediaGalleryVisible(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={26} color="#00ff66" />
            </TouchableOpacity>
            <View style={{ marginLeft: 12 }}>
              <Text style={styles.friendName}>Mídias Compartilhadas</Text>
              <Text style={styles.friendStatus}>
                {sharedMedia.length} arquivos
              </Text>
            </View>
          </View>
          <View style={styles.galleryTabs}>
            {[['media', 'Mídia'], ['links', 'Links'], ['docs', 'Docs']].map(([tab, label]) => (
              <TouchableOpacity key={tab} style={[styles.galleryTab, mediaGalleryTab === tab && styles.galleryTabActive]} onPress={() => setMediaGalleryTab(tab)}><Text style={[styles.galleryTabText, mediaGalleryTab === tab && styles.galleryTabTextActive]}>{label}</Text></TouchableOpacity>
            ))}
          </View>
          <FlatList
            data={galleryItems}
            keyExtractor={(item) => String(item.id)}
            numColumns={mediaGalleryTab === 'media' ? 3 : 1}
            key={mediaGalleryTab}
            contentContainerStyle={mediaGalleryTab === 'media' ? { padding: 4 } : { padding: 14 }}
            renderItem={({ item }) => (
              mediaGalleryTab === 'media' ? <TouchableOpacity activeOpacity={0.8} style={{ flex: 1/3, aspectRatio: 1, padding: 2 }} onPress={() => handleOpenMediaFromGallery(item)}>
                {item.media_type?.startsWith('video') ? (
                  <View style={{ width: '100%', height: '100%', borderRadius: 4, backgroundColor: '#1E293B', overflow: 'hidden', justifyContent: 'center', alignItems: 'center' }}>
                    <Video source={{ uri: item.media_url }} style={StyleSheet.absoluteFill} resizeMode={ResizeMode.COVER} shouldPlay={false} isMuted={true} />
                    <View style={{ position: 'absolute', backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 14 }}><Ionicons name="play" size={28} color="#fff" /></View>
                  </View>
                ) : (
                  <Image source={{ uri: item.media_url }} style={{ width: '100%', height: '100%', borderRadius: 4 }} />
                )}
              </TouchableOpacity> : <TouchableOpacity style={styles.galleryListItem} onPress={() => mediaGalleryTab === 'links' ? Linking.openURL((item.content.match(/https?:\/\/[^\s]+/i) || [])[0]) : handleDownloadAndShareFile(item.media_url, item.content)}>
                <Ionicons name={mediaGalleryTab === 'links' ? 'link-outline' : 'document-text-outline'} size={24} color={DEFAULT_APP_THEME_COLOR} />
                <Text style={styles.galleryListText} numberOfLines={2}>{mediaGalleryTab === 'links' ? (item.content.match(/https?:\/\/[^\s]+/i) || [item.content])[0] : (item.content || 'Documento').split('|')[0]}</Text>
                <Ionicons name="chevron-forward" size={19} color="#64748B" />
              </TouchableOpacity>
            )}
            ListEmptyComponent={() => (
              <View style={{ flex: 1, alignItems: 'center', marginTop: 50 }}>
                {loadingGalleryMessages ? <ActivityIndicator color={DEFAULT_APP_THEME_COLOR} /> : <Text style={{ color: '#475569' }}>Nenhuma mídia trocada.</Text>}
              </View>
            )}
          />
        </SafeAreaView>
      </Modal>

      {/* MODAL 8: Personalizar Cores */}
      <Modal animationType="fade" transparent visible={customizeModalVisible} onRequestClose={() => setCustomizeModalVisible(false)}>
        <View style={styles.modalOverlayDark}>
          <View style={[styles.editNameCard, { maxWidth: 360 }]}>
            <Text style={styles.modalTitle}>Paleta de Cores</Text>

            <Text style={styles.colorSectionTitle}>Meus Balões</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.colorRow}>
              {['#1E293B', '#2563eb', '#16a34a', '#d97706', '#dc2626', '#9333ea', '#475569', '#0284c7', '#0f766e', '#be185d', '#6d28d9', '#ca8a04', '#047857', '#1d4ed8'].map(c => (
                <TouchableOpacity key={c} style={[styles.colorCircle, { backgroundColor: c }, myBubbleColor === c && styles.colorCircleSelected]} onPress={() => saveColor('my', c)} />
              ))}
            </ScrollView>

            <Text style={styles.colorSectionTitle}>Balões do Contato</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.colorRow}>
              {['#0d0d0d', '#1e293b', '#3f3f46', '#064e3b', '#1e3a8a', '#4c1d95', '#881337', '#262626', '#1f2937', '#374151', '#4b5563', '#6b7280', '#9ca3af', '#d1d5db'].map(c => (
                <TouchableOpacity key={c} style={[styles.colorCircle, { backgroundColor: c }, theirBubbleColor === c && styles.colorCircleSelected]} onPress={() => saveColor('their', c)} />
              ))}
            </ScrollView>

            <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#00ff66', marginTop: 20 }]} onPress={() => setCustomizeModalVisible(false)}><Text style={{ color: '#000', fontWeight: 'bold' }}>Concluir</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* MODAL 9: Giphy Stickers */}
      <Modal animationType="slide" transparent visible={giphyModalVisible} onRequestClose={() => setGiphyModalVisible(false)}>
        <SafeAreaView style={[styles.mainContainer, { paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 }]}>
          <View style={[styles.chatHeader, { borderBottomWidth: 1, borderColor: '#111' }]}>
            <TouchableOpacity onPress={() => setGiphyModalVisible(false)}><Ionicons name="close" size={26} color="#ef4444" /></TouchableOpacity>
            <TextInput
              style={{ flex: 1, marginLeft: 15, marginRight: 10, color: '#fff', fontSize: 16, backgroundColor: '#111827', paddingHorizontal: 15, paddingVertical: 8, borderRadius: 20 }}
              placeholder="Pesquisar stickers..."
              placeholderTextColor="#64748B"
              value={giphySearch}
              onChangeText={(t) => { setGiphySearch(t); if (giphyTab !== 'search') setGiphyTab('search'); }}
              onFocus={() => setGiphyTab('search')}
            />
            <View style={styles.giphyTabContainer}>
              <TouchableOpacity onPress={() => setGiphyTab('recent')} style={[styles.giphyTab, giphyTab === 'recent' && styles.giphyTabActive]}>
                <Ionicons name="time-outline" size={20} color={giphyTab === 'recent' ? '#00ff66' : '#64748B'} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setGiphyTab('favorites')} style={[styles.giphyTab, giphyTab === 'favorites' && styles.giphyTabActive]}>
                <Ionicons name="star-outline" size={20} color={giphyTab === 'favorites' ? '#00ff66' : '#64748B'} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setGiphyTab('search')} style={[styles.giphyTab, giphyTab === 'search' && styles.giphyTabActive]}>
                <Ionicons name="search-outline" size={20} color={giphyTab === 'search' ? '#00ff66' : '#64748B'} />
              </TouchableOpacity>
            </View>
          </View>

          {giphyTab === 'recent' ? (
            <FlatList
              data={recentGifs}
              keyExtractor={(item, index) => `recent-${item}-${index}`}
              numColumns={3}
              contentContainerStyle={{ padding: 4 }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={{ flex: 1/3, aspectRatio: 1, padding: 4 }}
                  onPress={() => handleSendSticker(item)}
                  onLongPress={() => handleToggleFavoriteGif(item)}
                  delayLongPress={800}
                >
                  <Image source={{ uri: item }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
                </TouchableOpacity>
              )}
              ListEmptyComponent={() => (
                <View style={{ flex: 1, alignItems: 'center', marginTop: 50, paddingHorizontal: 20 }}><Text style={{ color: '#475569', textAlign: 'center' }}>Nenhuma figurinha recente.</Text></View>
              )}
            />
          ) : giphyTab === 'favorites' ? (
            <FlatList
              data={favoriteGifs}
              keyExtractor={(item, index) => `favorite-${item}-${index}`}
              numColumns={3}
              contentContainerStyle={{ padding: 4 }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={{ flex: 1/3, aspectRatio: 1, padding: 4 }}
                  onPress={() => handleSendSticker(item)}
                  onLongPress={() => handleToggleFavoriteGif(item)}
                  delayLongPress={800}
                >
                  <Image source={{ uri: item }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
                  <View style={{ position: 'absolute', top: 8, right: 8, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 10, padding: 2 }}>
                    <Ionicons name="star" size={12} color="#facc15" />
                  </View>
                </TouchableOpacity>
              )}
              ListEmptyComponent={() => (
                <View style={{ flex: 1, alignItems: 'center', marginTop: 50, paddingHorizontal: 20 }}><Text style={{ color: '#475569', textAlign: 'center' }}>Nenhuma figurinha favorita.{'\n'}Segure uma figurinha para favoritar.</Text></View>
              )}
            />
          ) : isSearchingGiphy ? (
              <ActivityIndicator size="large" color="#00ff66" style={{ flex: 1, marginTop: 50 }} />
            ) : (
              <FlatList
                data={giphyResults}
                keyExtractor={(item, index) => `${item.id}-${index}`}
                numColumns={3}
                contentContainerStyle={{ padding: 4 }}
                onEndReached={() => fetchGiphy(false)}
                onEndReachedThreshold={0.5}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={{ flex: 1/3, aspectRatio: 1, padding: 4 }}
                    onPress={() => handleSendSticker(`https://media2.giphy.com/media/${item.id}/200.gif`)}
                    onLongPress={() => handleToggleFavoriteGif(`https://media2.giphy.com/media/${item.id}/200.gif`)}
                    delayLongPress={800}
                  >
                    <Image source={{ uri: item.images.fixed_height.url }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
                  </TouchableOpacity>
                )}
                ListFooterComponent={isFetchingMoreGiphy && <ActivityIndicator size="small" color="#00ff66" style={{ marginVertical: 20 }} />}
                ListEmptyComponent={() => (
                  (() => {
                    const searchTerm = giphySearch.trim();
                    if (giphyError) {
                      return (
                        <View style={styles.giphyEmptyState}>
                          <Ionicons name="cloud-offline-outline" size={48} color="#ef4444" />
                          <Text style={styles.giphyEmptyTitle}>Falha na Conexão</Text>
                          <Text style={styles.giphyEmptySubtitleError}>Não foi possível conectar ao Giphy. Verifique sua internet e tente novamente.</Text>
                          <Text style={styles.giphyEmptyDetails}>{`Detalhes: ${giphyError}`}</Text>
                        </View>
                      );
                    }
                    if (searchTerm.length > 0 && searchTerm.length < 3) {
                      return (
                        <View style={styles.giphyEmptyState}>
                          <Ionicons name="text-outline" size={48} color="#475569" />
                          <Text style={styles.giphyEmptyTitle}>Continue digitando...</Text>
                          <Text style={styles.giphyEmptySubtitle}>Digite pelo menos 3 caracteres para buscar no Giphy.</Text>
                        </View>
                      );
                    }
                    if (searchTerm.length >= 3) {
                      return (
                        <View style={styles.giphyEmptyState}>
                          <Ionicons name="search-outline" size={48} color="#475569" />
                          <Text style={styles.giphyEmptyTitle}>Nenhum resultado</Text>
                          <Text style={styles.giphyEmptySubtitle}>Não encontramos figurinhas para "{searchTerm}".</Text>
                        </View>
                      );
                    }
                    // Estado inicial ou de trending sem resultados
                    return null;
                  })()
                )}
              />
            )
          }
        </SafeAreaView>
      </Modal>

      {/* MODAL 10: Ações do Sticker (Estilo WhatsApp) */}
      <Modal animationType="fade" transparent visible={stickerActionModalVisible} onRequestClose={() => setStickerActionModalVisible(false)}>
        <TouchableOpacity style={styles.modalOverlayDark} activeOpacity={1} onPress={() => setStickerActionModalVisible(false)}>
          <TouchableOpacity activeOpacity={1} style={styles.stickerActionCard}>
            {selectedSticker?.url && (
              <Image source={{ uri: selectedSticker.url }} style={styles.stickerPreview} resizeMode="contain" />
            )}
            <View style={styles.stickerActionButtons}>
              <TouchableOpacity style={styles.stickerActionBtn} onPress={() => {
                handleToggleFavoriteGif(selectedSticker.url, false);
                // Atualiza o estado local para refletir a mudança sem fechar o modal
                setSelectedSticker(prev => ({ ...prev, isFavorite: !prev.isFavorite }));
              }}>
                <Text style={styles.stickerActionText}>{selectedSticker?.isFavorite ? 'Remover dos Favoritos' : 'Adicionar aos Favoritos'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.stickerActionBtn, { borderBottomWidth: 0 }]} onPress={() => setStickerActionModalVisible(false)}>
                <Text style={[styles.stickerActionText, { color: '#ef4444', fontWeight: 'bold' }]}>Cancelar</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  mainContainer: { flex: 1, backgroundColor: '#050505' },
  chatHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15, paddingVertical: 10, backgroundColor: '#0d0d0d', borderBottomWidth: 1, borderBottomColor: '#111', minHeight: 65 },
  backBtn: { paddingRight: 12 },
  menuBtn: { padding: 5 },
  privacyBypassActive: { backgroundColor: 'rgba(34, 197, 94, 0.14)', borderRadius: 14 },
  headerInfo: { flex: 1, minWidth: 0, justifyContent: 'center' },
  friendName: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  friendStatus: { color: '#64748B', fontSize: 11, marginTop: 2 },
  groupInfoScreen: { flex: 1, backgroundColor: '#050505' },
  groupInfoHeader: { height: 64, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, backgroundColor: '#0d0d0d', borderBottomWidth: 1, borderBottomColor: '#1F2937' },
  groupInfoBackBtn: { padding: 7, marginRight: 12 },
  groupInfoHeaderTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  groupInfoContent: { alignItems: 'center', padding: 28, paddingBottom: 52 },
  groupInfoPhoto: { width: 148, height: 148, borderRadius: 74, backgroundColor: '#111827' },
  groupInfoPhotoFallback: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#1F2937' },
  changeGroupPhotoButton: { marginTop: 10, paddingVertical: 7 },
  changeGroupPhotoText: { color: '#00ff66', fontWeight: '700', fontSize: 13 },
  groupNameInput: { width: '100%', color: '#fff', fontSize: 19, fontWeight: '800', textAlign: 'center', borderBottomWidth: 1, borderBottomColor: '#334155', paddingVertical: 9, marginTop: 6 },
  groupInfoName: { color: '#fff', fontSize: 22, fontWeight: '800', marginTop: 16, textAlign: 'center' },
  groupInfoCode: { color: '#64748B', fontSize: 12, marginTop: 6 },
  contactEditButton: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 12, paddingVertical: 7 },
  contactEditText: { color: '#00ff66', fontSize: 14, fontWeight: '700' },
  contactInfoRow: { minHeight: 55, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#1F2937', gap: 12 },
  contactInfoRowText: { flex: 1, color: '#fff', fontSize: 15 },
  contactInfoCount: { color: '#64748B', fontSize: 13 },
  groupInfoSection: { width: '100%', marginTop: 34, padding: 17, backgroundColor: '#0d0d0d', borderRadius: 16, borderWidth: 1, borderColor: '#1F2937' },
  groupInfoSectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  groupInfoSectionTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  groupMemberRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 11, borderBottomWidth: 1, borderBottomColor: '#1F2937' },
  groupMemberAvatar: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,255,102,0.15)' },
  groupMemberInitial: { color: '#00ff66', fontSize: 14, fontWeight: '800' },
  groupMemberName: { color: '#fff', fontSize: 14, fontWeight: '700' },
  groupMemberCode: { color: '#64748B', fontSize: 11, marginTop: 2 },
  groupInfoHint: { color: '#94a3b8', fontSize: 12, marginTop: 10, lineHeight: 17 },
  groupDescriptionInput: { minHeight: 112, maxHeight: 180, color: '#fff', backgroundColor: '#111827', borderRadius: 10, borderWidth: 1, borderColor: '#1F2937', padding: 12, fontSize: 15, marginTop: 14 },
  groupDescriptionCounter: { color: '#64748B', fontSize: 11, textAlign: 'right', marginTop: 5 },
  groupDescriptionSave: { height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#00ff66', marginTop: 13 },
  groupDescriptionSaveText: { color: '#03150a', fontSize: 14, fontWeight: '800' },
  messageSearchBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0d0d0d', borderBottomWidth: 1, borderBottomColor: '#111', paddingHorizontal: 15, paddingVertical: 9 },
  galleryTabs: { flexDirection: 'row', backgroundColor: '#0d0d0d', paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#1F2937' },
  galleryTab: { flex: 1, alignItems: 'center', paddingVertical: 13, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  galleryTabActive: { borderBottomColor: '#00ff66' },
  galleryTabText: { color: '#64748B', fontWeight: '700', fontSize: 13 },
  galleryTabTextActive: { color: '#00ff66' },
  galleryListItem: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#111827', borderRadius: 10, padding: 14, marginBottom: 8 },
  galleryListText: { flex: 1, color: '#e2e8f0', fontSize: 14 },
  messageSearchInput: { flex: 1, color: '#fff', fontSize: 15, paddingVertical: 6, paddingHorizontal: 10 },
  searchCounter: { color: '#64748B', fontSize: 12, minWidth: 42, textAlign: 'right', marginRight: 4 },
  searchNavBtn: { padding: 5 },
  messagesList: { paddingVertical: 18 },
  swipeContainer: { flexDirection: 'row', alignItems: 'center', width: '100%', position: 'relative' },
  replyIconLeft: { position: 'absolute', left: -38, justifyContent: 'center', height: '100%' },
  messageBubble: { paddingHorizontal: 13, paddingVertical: 9, borderRadius: 16, marginBottom: 16, position: 'relative', minWidth: 60 },
  myBubble: { backgroundColor: '#1E293B', alignSelf: 'flex-end', borderBottomRightRadius: 4 },
  theirBubble: { backgroundColor: '#0d0d0d', alignSelf: 'flex-start', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: '#111' },
  aiBubble: { alignSelf: 'center', borderColor: 'rgba(0,255,102,0.28)' },
  aiMessageHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 6, gap: 5 },
  aiMessageLabel: { color: '#00ff66', fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  imageBubble: { borderRadius: 14 },
  messageText: { color: '#fff', fontSize: 15, lineHeight: 21 },
  bubbleFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 4 },
  messageTime: { color: '#475569', fontSize: 10, fontFamily: 'monospace' },
  quoteInsideBubble: { minWidth: 180, backgroundColor: 'rgba(0,0,0,0.3)', borderLeftWidth: 2, borderLeftColor: '#00ff66', padding: 6, borderRadius: 4, marginBottom: 6 },
  replyPreviewContent: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  replyPreviewText: { flex: 1, minWidth: 0 },
  replyThumbnail: { width: 42, height: 42, borderRadius: 6, backgroundColor: '#1e293b', overflow: 'hidden' },
  replyThumbnailFallback: { alignItems: 'center', justifyContent: 'center' },
  replyPlayIcon: { position: 'absolute', width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', paddingLeft: 1 },
  quoteInsideLabel: { color: '#00ff66', fontSize: 11, fontWeight: '700', marginBottom: 1 },
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
  replyBarLeft: { borderLeftWidth: 3, borderLeftColor: '#00ff66', paddingLeft: 10, flex: 1, marginRight: 10 },
  replyUserTarget: { color: '#00ff66', fontSize: 12, fontWeight: 'bold' },
  replyTextTarget: { color: '#64748B', fontSize: 13, marginTop: 2 },
  inputWrapper: { borderTopWidth: 1, borderTopColor: '#111', paddingBottom: Platform.OS === 'ios' ? 10 : 48, paddingTop: 10 },
  inputContainer: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12 },
  attachBtn: { padding: 8, marginRight: 4, marginBottom: 2 },
  textInputContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    minHeight: 42,
    backgroundColor: '#111827',
    borderRadius: 22,
    paddingHorizontal: 16,
    marginRight: 10,
  },
  textInput: { flex: 1, width: 0, color: '#fff', paddingTop: 10, paddingBottom: 10, fontSize: 15, maxHeight: 120, textAlignVertical: 'center' },
  giphyBtnInside: { paddingLeft: 8, paddingBottom: 8 },
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
  modalTitleNoMargin: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  aiConfigCard: { backgroundColor: '#0d0d0d', borderRadius: 20, padding: 18, borderWidth: 1, borderColor: '#1F2937', width: '92%', maxWidth: 440 },
  aiConfigHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  aiToggleRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#111827', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#1F2937', marginBottom: 16 },
  aiToggle: { width: 48, height: 28, borderRadius: 14, backgroundColor: '#334155', padding: 3, justifyContent: 'center' },
  aiToggleOn: { backgroundColor: '#00ff66' },
  aiToggleKnob: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#cbd5e1' },
  aiToggleKnobOn: { backgroundColor: '#03150a', marginLeft: 20 },
  aiFieldLabel: { color: '#cbd5e1', fontSize: 13, fontWeight: '700', marginBottom: 8 },
  aiFieldHint: { color: '#64748B', fontSize: 12, marginTop: -2, marginBottom: 14 },
  aiMultilineInput: { minHeight: 104, maxHeight: 160 },
  aiModelGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  aiModelChip: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: '#111827', borderWidth: 1, borderColor: '#1F2937' },
  aiModelChipActive: { borderColor: '#00ff66', backgroundColor: '#12332a' },
  aiModelChipText: { color: '#94a3b8', fontSize: 12, fontWeight: '600' },
  aiModelChipTextActive: { color: '#d1fae5' },
  aiSaveBtn: { height: 46, borderRadius: 12, backgroundColor: '#00ff66', alignItems: 'center', justifyContent: 'center', marginTop: 14 },
  aiSaveText: { color: '#03150a', fontWeight: '800', fontSize: 15 },
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
  fullscreenNavBtn: {
    position: 'absolute',
    top: '50%',
    marginTop: -25, // Metade da altura para centralizar verticalmente
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100, // Acima da imagem/vídeo
  },
  fullscreenNavBtnLeft: { left: 10 },
  fullscreenNavBtnRight: { right: 10 },
  downloadBtn: { position: 'absolute', top: 8, right: 8, backgroundColor: 'rgba(0,0,0,0.5)', padding: 6, borderRadius: 16, zIndex: 10, elevation: 10 },
  colorSectionTitle: { color: '#64748B', fontSize: 13, fontWeight: 'bold', marginTop: 15, marginBottom: 10, textTransform: 'uppercase' },
  colorRow: { flexDirection: 'row', marginBottom: 5 },
  colorCircle: { width: 40, height: 40, borderRadius: 20, marginRight: 12, borderWidth: 2, borderColor: '#1F2937', justifyContent: 'center', alignItems: 'center' },
  colorCircleSelected: { borderColor: '#00ff66' },
  linkPreviewContainer: { backgroundColor: '#111827', borderRadius: 8, marginTop: 8, overflow: 'hidden', borderWidth: 1, borderColor: '#1F2937' },
  linkPreviewCard: { backgroundColor: 'rgba(0,0,0,0.22)', borderRadius: 10, marginTop: 9, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' },
  linkPreviewImage: { width: '100%', height: 220, backgroundColor: '#1e293b' },
  linkPreviewTextContainer: { padding: 10 },
  linkPreviewSite: { color: '#94a3b8', fontSize: 11, marginBottom: 4 },
  linkPreviewTitle: { color: '#fff', fontSize: 13, fontWeight: '700', marginBottom: 3 },
  linkPreviewDesc: { color: '#94A3B8', fontSize: 11 },
  linkPreviewUrl: { color: '#7dd3fc', fontSize: 11, marginTop: 8 },
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
  },
  pinnedBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#0d1117', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1F2937', borderLeftWidth: 3, borderLeftColor: '#00ff66' },
  pinnedBarLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  pinnedLabel: { color: '#00ff66', fontSize: 11, fontWeight: 'bold' },
  pinnedText: { color: '#94a3b8', fontSize: 13, marginTop: 1, maxWidth: 260 },
  dateSeparator: { flexDirection: 'row', alignItems: 'center', marginVertical: 16, paddingHorizontal: 12 },
  dateSeparatorLine: { flex: 1, height: 1, backgroundColor: '#1F2937' },
  dateSeparatorText: { color: '#475569', fontSize: 11, fontWeight: '600', marginHorizontal: 12, textTransform: 'uppercase', backgroundColor: '#050505', paddingHorizontal: 8, letterSpacing: 0.5 },
  giphyTabContainer: { flexDirection: 'row', backgroundColor: '#111827', borderRadius: 20, padding: 2, marginLeft: 8 },
  giphyTab: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 18 },
  giphyTabActive: { backgroundColor: '#1F2937' },
  suggestionContainer: { height: 90, backgroundColor: '#0d0d0d', borderTopWidth: 1, borderTopColor: '#1F2937' },
  suggestionItem: { width: 70, height: 70, margin: 5, borderRadius: 8, overflow: 'hidden', backgroundColor: '#1e293b' },
  suggestionImage: { width: '100%', height: '100%' },
  stickerActionCard: { backgroundColor: '#0d0d0d', borderRadius: 20, padding: 15, borderWidth: 1, borderColor: '#1F2937', width: '90%', maxWidth: 320, alignItems: 'center' },
  stickerPreview: { width: 200, height: 200, marginBottom: 15 },
  stickerActionButtons: { width: '100%' },
  stickerActionBtn: { paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#1F2937' },
  stickerActionText: { color: '#fff', fontSize: 16, textAlign: 'center' },
  giphyEmptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', marginTop: 80, paddingHorizontal: 20 },
  giphyEmptyTitle: { color: '#cbd5e1', fontSize: 18, fontWeight: 'bold', marginTop: 15, textAlign: 'center' },
  giphyEmptySubtitle: { color: '#64748B', marginTop: 5, textAlign: 'center', fontSize: 14 },
  giphyEmptySubtitleError: { color: '#9ca3af', marginTop: 5, textAlign: 'center', fontSize: 14 },
  giphyEmptyDetails: { color: '#ef4444', marginTop: 10, textAlign: 'center', fontSize: 11, fontFamily: 'monospace' },
  documentBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(30, 41, 59, 0.5)',
    padding: 12,
    borderRadius: 14,
  },
  documentInfo: {
    flex: 1,
    marginLeft: 12,
  },
  documentName: {
    color: '#f1f5f9',
    fontSize: 14,
    fontWeight: 'bold',
  },
  documentSize: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 4,
  },
  // 🚀 BALÃO DE ÁUDIO — visual estilo WhatsApp (botão circular verde + "forma de onda")
  audioBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  audioPlayCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#00ff66',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  audioContentContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  waveformContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 24,
    gap: 3,
  },
  waveformBar: {
    width: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  audioFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  audioDurationText: {
    color: '#94a3b8',
    fontSize: 11,
    fontFamily: 'monospace',
  },
  audioPreviewBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    height: 42,
    backgroundColor: '#111827',
    borderRadius: 22,
    paddingHorizontal: 10,
    marginRight: 10,
  },
  previewDeleteBtn: { padding: 6, marginRight: 4 },
  previewPlayBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#00ff66',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  previewSliderContainer: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  previewDurationText: { color: '#94a3b8', fontSize: 11, fontFamily: 'monospace', marginLeft: 6, minWidth: 34 },
  recordingIndicator: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    height: 42,
    backgroundColor: '#111827',
    borderRadius: 22,
    paddingHorizontal: 10,
  },
  recordingGestureArea: {
    flex: 1,
    height: 42,
    marginRight: 10,
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: 22,
  },
  recordingCancelBackdrop: {
    position: 'absolute',
    left: 12,
    right: 12,
    height: 42,
    borderRadius: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
  },
  recordingCancelText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
  },
  recordingCancelTextArmed: { color: '#ef4444' },
  recordingInfoContainer: { flexDirection: 'row', alignItems: 'center', flex: 1, marginLeft: 4 },
  recordingDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#ef4444', marginRight: 8 },
  recordingTimer: { color: '#f1f5f9', fontFamily: 'monospace', fontSize: 15 },
  recordingSlideText: { color: '#64748B', marginLeft: 'auto', fontSize: 13 },
  recordingSlideTextArmed: { color: '#ef4444' },
});


