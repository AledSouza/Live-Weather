import React, { useState, useEffect, useRef } from 'react';
// 🚀 CORREÇÃO: Adicionados Text e TouchableOpacity que estavam faltando aqui
import { View, StyleSheet, ActivityIndicator, Keyboard, Platform, StatusBar, Text, TouchableOpacity, TextInput, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

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

  // Função que renova o tempo sempre que a tela é tocada
  const resetInactivityTimer = () => {
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    inactivityTimer.current = setTimeout(() => {
      setIsChatMode(false);
    }, 120000); // Bloqueia após 2 minutos sem tocar na tela
  };

  useEffect(() => {

    const subscription = AppState.addEventListener('change', nextAppState => {
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        if (!isPickerActiveRef.current) {
          setIsChatMode(false);
        }
      }
    });

    const checkIdentity = async () => {
      try {
        const savedName = await AsyncStorage.getItem('@user_nickname');
        const savedCode = await AsyncStorage.getItem('@connection_code');
        
        if (savedName && savedCode) {
          setNickname(savedName);
          setConnectionCode(savedCode.trim().toLowerCase());
          setCurrentScreen('list'); 
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

  const handleUnlockTrigger = () => {
    setIsChatMode(true);
  };

  const handleSaveIdentity = async () => {
    if (nickname.trim() === '') return;
    setSyncing(true);
    try {
      const part1 = Math.random().toString(36).substr(2, 4);
      const part2 = Math.random().toString(36).substr(2, 4);
      const generatedCode = `${part1}-${part2}`.toLowerCase();

      const { error } = await supabase
        .from('perfis')
        .insert([{ nickname: nickname.trim(), connection_code: generatedCode }]);

      if (error) {
        alert('Erro ao registrar terminal no servidor.');
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
  startBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 16 }
});