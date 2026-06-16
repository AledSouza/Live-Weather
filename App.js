import React, { useState, useEffect, useRef } from 'react';
// 🚀 CORREÇÃO: Adicionados Text e TouchableOpacity que estavam faltando aqui
import { View, StyleSheet, ActivityIndicator, Keyboard, Platform, StatusBar, Text, TouchableOpacity, TextInput, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ScreenCapture from 'expo-screen-capture';
import { supabase } from './supabase';
import { Ionicons } from '@expo/vector-icons';
// import { registerForPushNotificationsAsync } from './screens/notificationService';

// Telas do ecossistema
import WeatherScreen from './screens/WeatherScreen';
import ChatListScreen from './screens/ChatListScreen';
import ChatRoomScreen from './screens/ChatRoomScreen';

export default function App() {
  const inactivityTimer = useRef(null);
  const isPickerActiveRef = useRef(false);
  const [isChatMode, setIsChatMode] = useState(false);
  const [currentScreen, setCurrentScreen] = useState('gateway'); // 'gateway', 'list', 'room'
  const [nickname, setNickname] = useState('');
  const [connectionCode, setConnectionCode] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  // Parâmetros da sala ativa
  const [activeFriendCode, setActiveFriendCode] = useState(null);
  const [activeFriendName, setActiveFriendName] = useState(null);

  // 🚀 ESTADOS DO SISTEMA PIN DE SEGURANÇA
  const [showPinPad, setShowPinPad] = useState(false);
  const [pinMode, setPinMode] = useState('verify'); // 'verify', 'setup', 'redefine'
  const [pinValue, setPinValue] = useState('');
  const [savedPin, setSavedPin] = useState(null);
  const [failedAttempts, setFailedAttempts] = useState(0);

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

  // Função que renova o tempo sempre que a tela é tocada
  const resetInactivityTimer = () => {
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    inactivityTimer.current = setTimeout(() => {
      setIsChatMode(false);
    }, 120000); // Bloqueia após 2 minutos sem tocar na tela
  };

  useEffect(() => {

    // Previne capturas de tela e oculta o conteúdo do app no multitarefas (Recentes)
    const secureScreen = async () => {
      if (Platform.OS === 'web') return; // Evita crash no navegador de PC
      try {
        await ScreenCapture.preventScreenCaptureAsync();
      } catch (e) {
        console.warn('Erro ao proteger a tela:', e);
      }
    };
    secureScreen();

    const subscription = AppState.addEventListener('change', async nextAppState => {
      try {
        const savedCode = await AsyncStorage.getItem('@connection_code');
        if (nextAppState === 'background' || nextAppState === 'inactive') {
          if (!isPickerActiveRef.current) {
            setIsChatMode(false);
          }
          // 🚀 Salva o "Visto por último" ao minimizar/fechar o app
          if (savedCode) {
            await supabase.from('perfis').update({ last_seen: new Date().toISOString() }).eq('connection_code', savedCode.trim().toLowerCase());
          }
        } else if (nextAppState === 'active') {
          // 🚀 Atualiza o "Visto por último" ao reabrir o app
          if (savedCode) {
            await supabase.from('perfis').update({ last_seen: new Date().toISOString() }).eq('connection_code', savedCode.trim().toLowerCase());
          }
        }
      } catch (e) { console.warn('Erro ao atualizar last_seen', e); }
    });

    const checkIdentity = async () => {
      try {
        const savedName = await AsyncStorage.getItem('@user_nickname');
        const savedCode = await AsyncStorage.getItem('@connection_code');
        
        if (savedName && savedCode) {
          setNickname(savedName);
          const cleanCode = savedCode.trim().toLowerCase();
          setConnectionCode(cleanCode);
          setCurrentScreen('list'); 

          // 🚀 ATUALIZA O TOKEN DE NOTIFICAÇÃO NO SUPABASE AO ABRIR O APP
          try {
            const isEnabled = await AsyncStorage.getItem('@notifications_enabled');
            if (isEnabled !== 'false') {
              // const token = await registerForPushNotificationsAsync();
              // if (token) {
              //   // Mantém o nome onesignal_id no banco para não quebrar o app em produção
              //   await supabase.from('perfis').update({ onesignal_id: token }).eq('connection_code', cleanCode);
              // }
            }
          } catch (e) { console.warn('Erro ao atualizar Token na inicialização', e); }
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    checkIdentity();

    return () => {
      subscription.remove();
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    };
  }, []);

  // 🚀 LÓGICA DE ATIVAÇÃO DO PÂNICO GERAL
  const executePanicProtocol = async () => {
    try {
      if (!connectionCode) return;
      const myCleanCode = connectionCode.trim().toLowerCase();
      
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

      // Limpa os caches locais da memória do dispositivo
      const keys = await AsyncStorage.getAllKeys();
      const cacheKeys = keys.filter(k => k.startsWith('@cache_msgs_') || k.startsWith('@queue_') || k.startsWith('@cache_chats_'));
      if (cacheKeys.length > 0) await AsyncStorage.multiRemove(cacheKeys);

    } catch (e) {
      console.error(e);
    } finally {
      setFailedAttempts(0);
      setPinValue('');
      setShowPinPad(false);
      setIsChatMode(false);
    }
  };

  const handlePinKeyPress = (num) => {
    if (pinValue.length < 3) {
      const newVal = pinValue + num;
      setPinValue(newVal);
      if (newVal.length === 3) {
        setTimeout(() => processPinComplete(newVal), 100);
      }
    }
  };

  const processPinComplete = async (val) => {
    if (pinMode === 'setup' || pinMode === 'redefine') {
      await AsyncStorage.setItem('@saved_pin', val);
      setSavedPin(val);
      alert(pinMode === 'setup' ? 'PIN configurado com sucesso!' : 'PIN redefinido com sucesso!');
      setShowPinPad(false);
      setPinValue('');
      if (pinMode === 'setup') setIsChatMode(true);
    } else {
      if (val === savedPin) {
        setFailedAttempts(0);
        setPinValue('');
        setShowPinPad(false);
        setIsChatMode(true);
      } else {
        const errors = failedAttempts + 1;
        if (errors >= 3) executePanicProtocol();
        else { setFailedAttempts(errors); setPinValue(''); }
      }
    }
  };

  const handleUnlockTrigger = async () => {
    const isPinOn = await AsyncStorage.getItem('@pin_enabled');
    if (isPinOn === 'true') {
      const currentPin = await AsyncStorage.getItem('@saved_pin');
      setSavedPin(currentPin);
      setPinMode(currentPin ? 'verify' : 'setup');
      setPinValue(''); setFailedAttempts(0); setShowPinPad(true);
    } else setIsChatMode(true);
  };

  const handleSaveIdentity = async () => {
    if (nickname.trim() === '') return;
    setSyncing(true);
    try {
      const part1 = Math.random().toString(36).substr(2, 4);
      const part2 = Math.random().toString(36).substr(2, 4);
      const generatedCode = `${part1}-${part2}`.toLowerCase();

      // let token = null;
      // try {
      //   token = await registerForPushNotificationsAsync();
      // } catch (err) {
      //   console.warn('Erro ao obter Token de Push:', err);
      // }

      // Mantém o nome onesignal_id no banco para não quebrar o app em produção
      const novoPerfil = { nickname: nickname.trim(), connection_code: generatedCode };
      // if (token) novoPerfil.onesignal_id = token;

      const { error } = await supabase
        .from('perfis')
        .insert([novoPerfil]);

      if (error) {
        alert('Falha no Supabase: ' + error.message);
        console.error('Erro detalhado:', error);
        setSyncing(false);
        return;
      }

      await AsyncStorage.setItem('@user_nickname', nickname.trim());
      await AsyncStorage.setItem('@connection_code', generatedCode);
      
      setConnectionCode(generatedCode);
      setCurrentScreen('list'); 
      Keyboard.dismiss();
    } catch (e) {
      console.error(e);
    } finally {
      setSyncing(false);
    }
  };

  // Renderizador dinâmico de telas interna
  const renderScreen = () => {
    if (isChatMode) {
      if (currentScreen === 'room') {
        return (
          <ChatRoomScreen 
            userCode={connectionCode}
            friendCode={activeFriendCode}
            friendName={activeFriendName}
            setPickerActive={(val) => { isPickerActiveRef.current = val; }}
            onBack={() => setCurrentScreen('list')}
          />
        );
      }

      if (currentScreen === 'list') {
        return (
          <ChatListScreen 
            onBack={() => setIsChatMode(false)} 
            userCode={connectionCode} 
            userNickname={nickname}
            onOpenChat={(code, name) => {
              setActiveFriendCode(code);
              setActiveFriendName(name);
              setCurrentScreen('room');
            }}
          />
        );
      }

      // Tela Gateway de Configuração do Terminal
      return (
        <View style={styles.chatGateway}>
          <View style={styles.chatHeader}>
            <Text style={styles.ghostStatus}>Configuração de Terminal</Text>
            <TouchableOpacity onPress={() => setIsChatMode(false)}>
              <Text style={styles.exitBtn}>Fechar Chat</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.chatCenter}>
            <Text style={styles.secretTitle}>CANAL ANÔNIMO</Text>
            <View style={styles.inputCard}>
              <Text style={styles.cardLabel}>Como deseja ser chamado no chat?</Text>
              <TextInput style={styles.textInput} placeholder="Digite seu apelido" placeholderTextColor="#475569" value={nickname} onChangeText={setNickname} maxLength={20} editable={!syncing} />
            </View>
            <TouchableOpacity style={[styles.startBtn, (nickname.trim() === '' || syncing) && { opacity: 0.5 }]} onPress={handleSaveIdentity} disabled={nickname.trim() === '' || syncing}>
              {syncing ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.startBtnText}>Criar Terminal</Text>}
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    return <WeatherScreen onUnlock={handleUnlockTrigger} />;
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#00ff66" />
      </View>
    );
  }

  return (
    <View style={styles.globalRoot} onTouchStart={resetInactivityTimer}>
      <StatusBar barStyle="light-content" backgroundColor="#0d0d0d" translucent />
      {renderScreen()}

      {/* 🚀 PAINEL DO PIN DE SEGURANÇA */}
      {showPinPad && (
        <View style={styles.pinOverlay}>
          <View style={styles.pinCard}>
            <Text style={styles.pinTitle}>
              {pinMode === 'setup' ? 'Crie um PIN (3 dígitos)' :
               pinMode === 'redefine' ? 'Novo PIN (3 dígitos)' : 'Digite seu PIN'}
            </Text>
            {pinMode === 'redefine' && <Text style={styles.redefineText}>redefina seu pin</Text>}

            <View style={styles.pinDots}>
              {[0, 1, 2].map(i => (
                <View key={i} style={[styles.pinDot, pinValue.length > i && styles.pinDotFilled]} />
              ))}
            </View>

            <View style={styles.pinPadRow}>
              <TouchableOpacity style={styles.pinKey} onPress={() => handlePinKeyPress('1')} onLongPress={() => { if (pinMode === 'verify') { setPinMode('redefine'); setPinValue(''); } }} delayLongPress={20000}><Text style={styles.pinKeyText}>1</Text></TouchableOpacity>
              <TouchableOpacity style={styles.pinKey} onPress={() => handlePinKeyPress('2')}><Text style={styles.pinKeyText}>2</Text></TouchableOpacity>
              <TouchableOpacity style={styles.pinKey} onPress={() => handlePinKeyPress('3')}><Text style={styles.pinKeyText}>3</Text></TouchableOpacity>
            </View>
            <View style={styles.pinPadRow}>
              <TouchableOpacity style={styles.pinKey} onPress={() => handlePinKeyPress('4')}><Text style={styles.pinKeyText}>4</Text></TouchableOpacity>
              <TouchableOpacity style={styles.pinKey} onPress={() => handlePinKeyPress('5')}><Text style={styles.pinKeyText}>5</Text></TouchableOpacity>
              <TouchableOpacity style={styles.pinKey} onPress={() => handlePinKeyPress('6')}><Text style={styles.pinKeyText}>6</Text></TouchableOpacity>
            </View>
            <View style={styles.pinPadRow}>
              <TouchableOpacity style={styles.pinKey} onPress={() => handlePinKeyPress('7')}><Text style={styles.pinKeyText}>7</Text></TouchableOpacity>
              <TouchableOpacity style={styles.pinKey} onPress={() => handlePinKeyPress('8')}><Text style={styles.pinKeyText}>8</Text></TouchableOpacity>
              <TouchableOpacity style={styles.pinKey} onPress={() => handlePinKeyPress('9')}><Text style={styles.pinKeyText}>9</Text></TouchableOpacity>
            </View>
            <View style={styles.pinPadRow}>
              <TouchableOpacity style={[styles.pinKey, { backgroundColor: 'transparent', borderWidth: 0 }]} onPress={() => { setShowPinPad(false); setPinValue(''); setFailedAttempts(0); }}><Ionicons name="close" size={32} color="#ef4444" /></TouchableOpacity>
              <TouchableOpacity style={styles.pinKey} onPress={() => handlePinKeyPress('0')}><Text style={styles.pinKeyText}>0</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.pinKey, { backgroundColor: 'transparent', borderWidth: 0 }]} onPress={() => setPinValue(pinValue.slice(0, -1))}><Ionicons name="backspace-outline" size={28} color="#fff" /></TouchableOpacity>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  globalRoot: { 
    flex: 1, 
    backgroundColor: '#050505',
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 
  },
  loadingContainer: { flex: 1, backgroundColor: '#050505', justifyContent: 'center', alignItems: 'center' },
  chatGateway: { flex: 1, padding: 20 },
  chatHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  ghostStatus: { color: '#475569', fontSize: 13, fontFamily: 'monospace' },
  exitBtn: { color: '#ef4444', fontWeight: 'bold', fontSize: 15 },
  chatCenter: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  secretTitle: { color: '#fff', fontSize: 24, fontWeight: 'bold', letterSpacing: 3, marginBottom: 35 },
  inputCard: { backgroundColor: '#0d0d0d', padding: 25, borderRadius: 16, width: '100%', marginBottom: 20, borderWidth: 1, borderColor: '#111' },
  cardLabel: { color: '#64748B', fontSize: 13, marginBottom: 12 },
  textInput: { backgroundColor: '#111827', color: '#fff', padding: 15, borderRadius: 12, fontSize: 16, borderWidth: 1, borderColor: '#1F2937', width: '100%' },
  startBtn: { backgroundColor: '#111', borderRadius: 12, width: '100%', height: 55, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#222' },
  startBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  pinOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.95)', zIndex: 999, justifyContent: 'center', alignItems: 'center' },
  pinCard: { width: '90%', maxWidth: 320, backgroundColor: '#0d0d0d', borderRadius: 24, paddingVertical: 30, alignItems: 'center', borderWidth: 1, borderColor: '#1F2937' },
  pinTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 30 },
  redefineText: { color: '#00ff66', fontSize: 12, marginTop: -22, marginBottom: 20, fontWeight: 'bold' },
  pinDots: { flexDirection: 'row', gap: 15, marginBottom: 35 },
  pinDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1, borderColor: '#64748B', backgroundColor: 'transparent' },
  pinDotFilled: { backgroundColor: '#00ff66', borderColor: '#00ff66' },
  pinPadRow: { flexDirection: 'row', gap: 20, marginBottom: 15 },
  pinKey: { width: 66, height: 66, borderRadius: 33, backgroundColor: '#111827', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#1F2937' },
  pinKeyText: { color: '#fff', fontSize: 26, fontWeight: 'bold' }
});