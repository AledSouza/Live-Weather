import React, { useEffect, useRef, useState } from 'react';
import { SafeAreaView, View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, FlatList, Keyboard, Platform, ScrollView, RefreshControl, ImageBackground, Animated, useWindowDimensions } from 'react-native';
import { Ionicons, Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { supabase } from '../supabase';

const WEATHER_ART = {
  clear: require('../assets_gatinho/DIA.png'),
  clouds: require('../assets_gatinho/nublado.png'),
  rain: require('../assets_gatinho/chuva.png'),
  storm: require('../assets_gatinho/tempestade.png'),
  night: require('../assets_gatinho/Noite.png'),
};

const getWeatherArt = (icon = '') => {
  if (icon.startsWith('11')) return WEATHER_ART.storm;
  if (icon.startsWith('09') || icon.startsWith('10')) return WEATHER_ART.rain;
  if (icon.startsWith('03') || icon.startsWith('04')) return WEATHER_ART.clouds;
  if (icon.endsWith('n')) return WEATHER_ART.night;
  if (icon.startsWith('01') || icon.startsWith('02')) return WEATHER_ART.clear;
  return WEATHER_ART.clouds;
};

const getWeatherIcon = (icon = '') => {
  if (icon.startsWith('11')) return 'thunderstorm-outline';
  if (icon.startsWith('09') || icon.startsWith('10')) return 'rainy-outline';
  if (icon.startsWith('13')) return 'snow-outline';
  if (icon.startsWith('01')) return icon.endsWith('n') ? 'moon-outline' : 'sunny-outline';
  if (icon.startsWith('02')) return 'partly-sunny-outline';
  return 'cloud-outline';
};

export default function WeatherScreen({ onUnlock, userCode }) {
  const [city, setCity] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [weatherData, setWeatherData] = useState(null);
  const [forecastData, setForecastData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [apiError, setApiError] = useState(null);
  const reveal = useRef(new Animated.Value(0)).current;
  const { height: screenHeight } = useWindowDimensions();
  const API_KEY = 'cb4d2d940cde8d6eb30c2531b3392c41';

  useEffect(() => {
    const loadSavedCity = async () => {
      try {
        const savedCity = await AsyncStorage.getItem('@user_city');
        const cachedWeather = await AsyncStorage.getItem('@weather_cache');
        let hasCachedWeather = false;
        if (cachedWeather) {
          try {
            const parsed = JSON.parse(cachedWeather);
            setWeatherData(parsed.weatherData);
            setForecastData(parsed.forecastData || []);
            setCity(parsed.city || savedCity || '');
            setLoading(false);
            hasCachedWeather = true;
          } catch { await AsyncStorage.removeItem('@weather_cache'); }
        }
        fetchWeather(savedCity || 'São Bernardo do Campo', false, hasCachedWeather);
      } catch { setLoading(false); }
    };
    loadSavedCity();
  }, []);

  useEffect(() => {
    if (!weatherData) return;
    reveal.setValue(0);
    Animated.timing(reveal, { toValue: 1, duration: 550, useNativeDriver: true }).start();
  }, [weatherData?.id]);

  const fetchWeather = async (cityName, isRefresh = false, keepExisting = false) => {
    const hasVisibleData = keepExisting || !!weatherData;
    if (isRefresh) setRefreshing(true); else if (!hasVisibleData) setLoading(true);
    setApiError(null);
    try {
      const [weatherRes, forecastRes] = await Promise.all([
        fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(cityName)},BR&appid=${API_KEY}&units=metric&lang=pt_br`),
        fetch(`https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(cityName)},BR&appid=${API_KEY}&units=metric&lang=pt_br`)
      ]);
      const data = await weatherRes.json();
      let nextForecast = [];
      if (!weatherRes.ok) throw new Error(data.message || 'Cidade não localizada.');
      setCity(data.name);
      await AsyncStorage.setItem('@user_city', data.name);
      // A cidade também fica no perfil: assim quem recebe a notificação vê o
      // próprio clima, mesmo se o app estiver fechado.
      if (userCode) {
        const { error: cityError } = await supabase
          .from('perfis')
          .update({ city: data.name })
          .eq('connection_code', userCode.trim().toLowerCase());
        if (cityError) console.warn('Não foi possível sincronizar a cidade do perfil:', cityError.message);
      }
      if (forecastRes.ok) {
        const forecast = await forecastRes.json();
        const daily = {};
        forecast.list.forEach(item => {
          const key = item.dt_txt.split(' ')[0];
          if (!daily[key]) daily[key] = { dateStr: key, dt: item.dt, min: item.main.temp_min, max: item.main.temp_max, icon: item.weather[0].icon, description: item.weather[0].description, precipitation: Math.round((item.pop || 0) * 100) };
          else {
            daily[key].min = Math.min(daily[key].min, item.main.temp_min);
            daily[key].max = Math.max(daily[key].max, item.main.temp_max);
            if (item.dt_txt.includes('12:00:00')) {
              daily[key].icon = item.weather[0].icon;
              daily[key].description = item.weather[0].description;
              daily[key].precipitation = Math.round((item.pop || 0) * 100);
            }
          }
        });
        nextForecast = Object.values(daily).sort((a, b) => a.dt - b.dt).slice(0, 5);
        if (nextForecast[0]) {
          data.main.temp_min = Math.min(data.main.temp, nextForecast[0].min);
          data.main.temp_max = Math.max(data.main.temp, nextForecast[0].max);
        }
      }
      setForecastData(nextForecast);
      setWeatherData(data);
      await AsyncStorage.setItem('@weather_cache', JSON.stringify({ city: data.name, weatherData: data, forecastData: nextForecast }));
    } catch (error) {
      if (!hasVisibleData) { setWeatherData(null); setForecastData([]); }
      setApiError(error.message || 'Sem conexão. Verifique sua internet e tente novamente.');
    } finally { setLoading(false); setRefreshing(false); }
  };

  const searchCitiesIBGE = async text => {
    setSearchQuery(text); if (apiError) setApiError(null);
    if (text.trim().length < 3) return setSuggestions([]);
    setSearching(true);
    try {
      const response = await fetch('https://servicodados.ibge.gov.br/api/v1/localidades/municipios?minhas=true');
      const data = await response.json();
      setSuggestions(data.filter(item => item.nome.toLowerCase().includes(text.toLowerCase())).map(item => `${item.nome}, ${item.microrregiao.mesorregiao.UF.sigla}`).slice(0, 5));
    } catch { setSuggestions([]); } finally { setSearching(false); }
  };

  const selectCity = fullName => { fetchWeather(fullName.split(',')[0]); setSearchQuery(''); setSuggestions([]); Keyboard.dismiss(); };
  const refresh = () => fetchWeather(city || 'São Bernardo do Campo', true);
  const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  return (
    <ImageBackground source={weatherData ? getWeatherArt(weatherData.weather[0].icon) : WEATHER_ART.clouds} style={styles.backgroundImage} resizeMode="cover">
    <LinearGradient colors={['rgba(5,19,35,0.25)', 'rgba(9,39,59,0.18)', 'rgba(7,32,49,0.44)']} locations={[0, 0.52, 1]} style={styles.container}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.searchBox}>
          <View style={styles.searchContainer}>
            <Ionicons name="search-outline" size={19} color="rgba(255,255,255,0.74)" />
            <TextInput style={styles.input} placeholder="Buscar cidade" placeholderTextColor="rgba(255,255,255,0.58)" value={searchQuery} onChangeText={searchCitiesIBGE} />
            {searching && <ActivityIndicator size="small" color="#fff" />}
          </View>
          {suggestions.length > 0 && <View style={styles.suggestions}>{<FlatList data={suggestions} keyExtractor={item => item} renderItem={({ item }) => <TouchableOpacity style={styles.suggestion} onPress={() => selectCity(item)}><Ionicons name="location-outline" size={16} color="#dff6ff" /><Text style={styles.suggestionText}>{item}</Text></TouchableOpacity>} />}</View>}
        </View>
        {loading ? <ActivityIndicator size="large" color="#fff" style={styles.loader} /> : weatherData ? (
          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scrollContent} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor="#fff" />}>
            {apiError && <View style={styles.offline}><Ionicons name="cloud-offline-outline" size={16} color="#fff" /><Text style={styles.offlineText}>{apiError}</Text></View>}
            <Animated.View style={[styles.hero, { height: screenHeight - 34, opacity: reveal, transform: [{ translateY: reveal.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] }]}>
              <Text style={styles.city}>{weatherData.name}</Text>
              <Text style={styles.today}>AGORA · {new Date().toLocaleDateString('pt-BR', { weekday: 'long' }).toUpperCase()}</Text>
              <TouchableOpacity style={styles.temperatureArea} activeOpacity={0.88} delayLongPress={2000} onLongPress={onUnlock}>
                <Text style={styles.temperature}>{Math.round(weatherData.main.temp)}°</Text>
                <Text style={styles.description}>{weatherData.weather[0].description}</Text>
                <Text style={styles.minMax}>Máx. {Math.round(weatherData.main.temp_max)}°  ·  Mín. {Math.round(weatherData.main.temp_min)}°</Text>
              </TouchableOpacity>
              <View style={styles.dragHint}><View style={styles.dragLine} /><Text style={styles.dragText}>Arraste para ver detalhes</Text></View>
            </Animated.View>
            <View style={styles.detailsArea}>
              <Text style={styles.sectionTitle}>Condições de hoje</Text>
              <View style={styles.metrics}>
                <View style={styles.metric}><Feather name="wind" size={21} color="#e8f8ff" /><Text style={styles.metricLabel}>Vento</Text><Text style={styles.metricValue}>{weatherData.wind.speed} m/s</Text></View>
                <View style={styles.metric}><Feather name="droplet" size={21} color="#e8f8ff" /><Text style={styles.metricLabel}>Umidade</Text><Text style={styles.metricValue}>{weatherData.main.humidity}%</Text></View>
              </View>
              <Text style={styles.sectionTitle}>Próximos dias</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.forecastScroll}>
                {forecastData.map((item, index) => <View key={item.dateStr} style={styles.forecastItem}><Text style={styles.forecastDay}>{index === 0 ? 'Hoje' : days[new Date(`${item.dateStr}T12:00:00`).getDay()]}</Text><Ionicons name={getWeatherIcon(item.icon)} size={27} color="#fff" style={{ marginVertical: 7 }} /><Text numberOfLines={1} style={styles.forecastDescription}>{item.description}</Text><View style={styles.forecastTemps}><Text style={styles.forecastMax}>{Math.round(item.max)}°</Text><Text style={styles.forecastMin}>{Math.round(item.min)}°</Text></View><View style={styles.precipitation}><Ionicons name="water-outline" size={11} color="rgba(235,250,255,0.9)" /><Text style={styles.precipitationText}>{item.precipitation}%</Text></View></View>)}
              </ScrollView>
            </View>
          </ScrollView>
        ) : <View style={styles.empty}><Ionicons name="cloud-offline-outline" size={72} color="rgba(255,255,255,0.7)" /><Text style={styles.emptyTitle}>Clima indisponível</Text><Text style={styles.emptyText}>{apiError || 'Busque uma cidade para começar.'}</Text><TouchableOpacity style={styles.retryButton} onPress={refresh}><Text style={styles.retryButtonText}>Tentar novamente</Text></TouchableOpacity></View>}
      </SafeAreaView>
    </LinearGradient>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  backgroundImage: { flex: 1 }, container: { flex: 1 }, safe: { flex: 1, paddingHorizontal: 20, paddingTop: Platform.OS === 'android' ? 18 : 6 }, searchBox: { zIndex: 10, position: 'absolute', top: Platform.OS === 'android' ? 18 : 6, left: 20, right: 20 }, searchContainer: { height: 46, borderRadius: 23, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(9,35,52,0.30)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.30)' }, input: { flex: 1, color: '#fff', fontSize: 15 }, suggestions: { position: 'absolute', top: 51, left: 0, right: 0, borderRadius: 18, overflow: 'hidden', backgroundColor: 'rgba(13,42,63,0.96)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' }, suggestion: { padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.14)' }, suggestionText: { color: '#fff', fontSize: 15 }, loader: { flex: 1 }, scrollContent: { paddingBottom: 36 }, hero: { minHeight: 515, alignItems: 'center', justifyContent: 'center' }, city: { position: 'absolute', top: 76, color: '#fff', fontSize: 28, fontWeight: '700', letterSpacing: -0.5 }, today: { position: 'absolute', top: 114, color: 'rgba(238,250,255,0.88)', fontSize: 10, letterSpacing: 1.1 }, temperatureArea: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' }, temperature: { color: '#fff', fontSize: 102, fontWeight: '200', letterSpacing: -5, textShadowColor: 'rgba(0,38,62,0.65)', textShadowRadius: 12 }, description: { color: '#f5fdff', fontSize: 17, fontWeight: '600', textTransform: 'capitalize', marginTop: -3, textShadowColor: 'rgba(0,38,62,0.6)', textShadowRadius: 5 }, minMax: { color: 'rgba(255,255,255,0.92)', fontSize: 13, marginTop: 8 }, dragHint: { position: 'absolute', bottom: 2, alignItems: 'center' }, dragLine: { width: 34, height: 4, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.75)', marginBottom: 5 }, dragText: { color: 'rgba(242,252,255,0.9)', fontSize: 10 }, detailsArea: { paddingTop: 20 }, sectionTitle: { color: 'rgba(240,252,255,0.96)', fontSize: 12, letterSpacing: 1.1, fontWeight: '800', textTransform: 'uppercase', marginBottom: 11, marginLeft: 4 }, metrics: { flexDirection: 'row', gap: 12, marginBottom: 27 }, metric: { flex: 1, minHeight: 118, padding: 16, borderRadius: 22, backgroundColor: 'rgba(7,29,45,0.36)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)' }, metricLabel: { color: 'rgba(239,251,255,0.82)', fontSize: 12, marginTop: 13 }, metricValue: { color: '#fff', fontSize: 20, fontWeight: '700', marginTop: 3 }, forecastScroll: { paddingHorizontal: 2, paddingBottom: 4 }, forecastItem: { alignItems: 'center', backgroundColor: 'rgba(7,29,45,0.36)', paddingVertical: 14, paddingHorizontal: 13, borderRadius: 20, marginRight: 9, width: 108, borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)' }, forecastDay: { color: '#fff', fontWeight: '700', fontSize: 14 }, forecastDescription: { color: 'rgba(244,253,255,0.88)', fontSize: 10, width: '100%', textAlign: 'center', textTransform: 'capitalize' }, forecastTemps: { flexDirection: 'row', alignItems: 'flex-start', gap: 5, marginTop: 7 }, forecastMin: { color: 'rgba(241,252,255,0.78)', fontSize: 13, marginTop: 2 }, forecastMax: { color: '#fff', fontWeight: '800', fontSize: 16 }, precipitation: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 6 }, precipitationText: { color: 'rgba(235,250,255,0.9)', fontSize: 11, fontWeight: '700' }, offline: { marginTop: 12, padding: 10, borderRadius: 13, backgroundColor: 'rgba(20,45,65,0.46)', flexDirection: 'row', alignItems: 'center', gap: 8 }, offlineText: { color: '#fff', fontSize: 12, flex: 1 }, empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30 }, emptyTitle: { color: '#fff', fontSize: 24, fontWeight: '800', marginTop: 15 }, emptyText: { color: 'rgba(255,255,255,0.75)', fontSize: 14, textAlign: 'center', marginVertical: 12 }, retryButton: { minWidth: 150, height: 45, borderRadius: 23, backgroundColor: '#e8f8ff', alignItems: 'center', justifyContent: 'center' }, retryButtonText: { color: '#123147', fontSize: 14, fontWeight: '800' }
});
