import React, { useState, useEffect } from 'react';
import { SafeAreaView, View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, FlatList, Keyboard, Platform, ScrollView } from 'react-native';
import { Ionicons, Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';

export default function WeatherScreen({ onUnlock }) {
  const [city, setCity] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]); 
  const [weatherData, setWeatherData] = useState(null);
  const [forecastData, setForecastData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [apiError, setApiError] = useState(null);

  const API_KEY = 'cb4d2d940cde8d6eb30c2531b3392c41'; 

  useEffect(() => {
    const loadSavedCity = async () => {
      try {
        const savedCity = await AsyncStorage.getItem('@user_city');
        fetchWeather(savedCity || 'São Bernardo do Campo');
      } catch (e) {
        setLoading(false);
      }
    };
    loadSavedCity();
  }, []);

  const fetchWeather = async (cityName) => {
    setLoading(true);
    setApiError(null);
    try {
      const [weatherRes, forecastRes] = await Promise.all([
        fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(cityName)},BR&appid=${API_KEY}&units=metric&lang=pt_br`),
        fetch(`https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(cityName)},BR&appid=${API_KEY}&units=metric&lang=pt_br`)
      ]);

      const data = await weatherRes.json();

      if (weatherRes.ok) {
        setCity(data.name);
        await AsyncStorage.setItem('@user_city', data.name);

        if (forecastRes.ok) {
          const fData = await forecastRes.json();
          const dailyData = {};
          
          for (const item of fData.list) {
            const dateStr = item.dt_txt.split(' ')[0];
            if (!dailyData[dateStr]) {
              dailyData[dateStr] = { dateStr, dt: item.dt, min: item.main.temp_min, max: item.main.temp_max, icon: item.weather[0].icon };
            } else {
              dailyData[dateStr].min = Math.min(dailyData[dateStr].min, item.main.temp_min);
              dailyData[dateStr].max = Math.max(dailyData[dateStr].max, item.main.temp_max);
              if (item.dt_txt.includes('12:00:00') || item.dt_txt.includes('15:00:00')) {
                dailyData[dateStr].icon = item.weather[0].icon;
              }
            }
          }
          const daily = Object.values(dailyData).sort((a, b) => a.dt - b.dt);
          
          if (daily.length > 0) {
            data.main.temp_min = Math.min(data.main.temp, daily[0].min);
            data.main.temp_max = Math.max(data.main.temp, daily[0].max);
          }

          setForecastData(daily.slice(0, 5));
        }
        setWeatherData(data);
      } else {
        setWeatherData(null);
        setForecastData([]);
        setApiError(data.message || 'Cidade não localizada.');
      }
    } catch (err) {
      setWeatherData(null);
      setForecastData([]);
      setApiError('Sem conexão.');
    } finally {
      setLoading(false);
    }
  };

  const searchCitiesIBGE = async (text) => {
    setSearchQuery(text);
    if (apiError) setApiError(null);
    
    if (text.trim().length < 3) {
      setSuggestions([]);
      return;
    }

    setSearching(true);
    try {
      const response = await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/municipios?minhas=true`);
      const data = await response.json();
      const filtered = data
        .filter(muni => muni.nome.toLowerCase().includes(text.toLowerCase()))
        .map(muni => `${muni.nome}, ${muni.microrregiao.mesorregiao.UF.sigla}`)
        .slice(0, 5);
      setSuggestions(filtered);
    } catch (err) {
      console.log(err);
    } finally {
      setSearching(false);
    }
  };

  const handleSelectCity = (fullCityName) => {
    const cityNameOnly = fullCityName.split(',')[0];
    fetchWeather(cityNameOnly);
    setSearchQuery('');
    setSuggestions([]);
    Keyboard.dismiss(); 
  };

  return (
    <LinearGradient colors={['#0B132B', '#16315C', '#2563EB']} style={styles.container}>
      <SafeAreaView style={{ flex: 1 }}>
      <View style={styles.searchBox}>
        <View style={styles.searchContainer}>
          <Ionicons name="search-outline" size={20} color="#64748B" style={{ marginRight: 10 }} />
          <TextInput
            style={styles.input}
            placeholder="Digite sua cidade..."
            placeholderTextColor="#64748B"
            value={searchQuery}
            onChangeText={searchCitiesIBGE}
          />
          {searching && <ActivityIndicator size="small" color="#00ff66" />}
        </View>

        {suggestions.length > 0 && (
          <View style={styles.suggestionsContainer}>
            <FlatList
              data={suggestions}
              keyExtractor={(item) => item}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.suggestionItem} onPress={() => handleSelectCity(item)}>
                  <Ionicons name="location-outline" size={16} color="#00ff66" style={{ marginRight: 10 }} />
                  <Text style={styles.suggestionText}>{item}</Text>
                </TouchableOpacity>
              )}
            />
          </View>
        )}
      </View>

      {loading ? (
        <ActivityIndicator size="large" color="#00ff66" style={{ flex: 1 }} />
      ) : weatherData ? (
        <ScrollView contentContainerStyle={{ flexGrow: 1, paddingBottom: 20 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <View style={styles.mainContainerWrapper}>
            <View style={styles.header}>
              <Text style={styles.city}>{weatherData.name}</Text>
            </View>

            {/* 🚀 GATILHO SECRETO AGORA FICA APENAS AQUI NO MEIO */}
            <TouchableOpacity 
              style={styles.main}
              activeOpacity={0.8} 
              delayLongPress={2000} 
              onLongPress={onUnlock}
            >
              <Ionicons name="cloudy-night-outline" size={130} color="#fff" />
              <Text style={styles.temp}>{Math.round(weatherData.main.temp)}°C</Text>
              <Text style={styles.desc}>
                {weatherData.weather[0].description.replace(/^\w/, (c) => c.toUpperCase())}
              </Text>
              <View style={styles.currentMinMax}>
                <Text style={styles.currentMax}>Máx: {Math.round(weatherData.main.temp_max)}°</Text>
                <Text style={styles.currentMin}>Mín: {Math.round(weatherData.main.temp_min)}°</Text>
              </View>
            </TouchableOpacity>

          <View style={styles.details}>
            <View style={styles.detailBox}>
              <Feather name="wind" size={24} color="#cbd5e1" style={{ marginBottom: 6 }} />
              <Text style={styles.detailVal}>{weatherData.wind.speed} m/s</Text>
            </View>
            <View style={styles.detailBox}>
              <Feather name="droplet" size={24} color="#cbd5e1" style={{ marginBottom: 6 }} />
              <Text style={styles.detailVal}>{weatherData.main.humidity}%</Text>
            </View>
          </View>

          {/* PREVISÃO PARA OS PRÓXIMOS DIAS */}
          {forecastData && forecastData.length > 0 && (
            <View style={styles.forecastContainer}>
              <Text style={styles.forecastTitle}>Próximos Dias</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={true} contentContainerStyle={styles.forecastScroll}>
                {forecastData.map((item, index) => {
                  const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
                  // Adicionamos T12:00:00 para evitar que o fuso horário empurre a data para o dia anterior no Brasil
                  const date = new Date(item.dateStr + 'T12:00:00');
                  const dayName = days[date.getDay()];
                  
                  const iconCode = item.icon;
                  let iconName = 'cloud-outline';
                  if (iconCode.startsWith('01')) iconName = 'sunny-outline';
                  else if (iconCode.startsWith('02')) iconName = 'partly-sunny-outline';
                  else if (iconCode.startsWith('03') || iconCode.startsWith('04')) iconName = 'cloud-outline';
                  else if (iconCode.startsWith('09') || iconCode.startsWith('10')) iconName = 'rainy-outline';
                  else if (iconCode.startsWith('11')) iconName = 'thunderstorm-outline';
                  else if (iconCode.startsWith('13')) iconName = 'snow-outline';

                  return (
                    <View key={index} style={styles.forecastItem}>
                      <Text style={styles.forecastDay}>{dayName}</Text>
                      <Ionicons name={iconName} size={26} color="#fff" style={{ marginVertical: 8 }} />
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 5 }}>
                        <Text style={styles.forecastTemp}>{Math.round(item.max)}°</Text>
                        <Text style={styles.forecastMin}>{Math.round(item.min)}°</Text>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            </View>
          )}
          </View>
        </ScrollView>
      ) : (
        <View style={styles.welcomeContainer}>
          <Ionicons name="partly-sunny-outline" size={100} color="#64748B" style={styles.welcomeIcon} />
          <Text style={styles.welcomeTitle}>Seja Bem-vindo(a)</Text>
        </View>
      )}
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 20, paddingTop: Platform.OS === 'ios' ? 10 : 20 },
  searchBox: { marginBottom: 15, zIndex: 50 },
  searchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255, 255, 255, 0.15)', borderRadius: 16, paddingHorizontal: 15, height: 52, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.2)' },
  input: { flex: 1, color: '#fff', fontSize: 16 },
  suggestionsContainer: { backgroundColor: '#1e293b', borderRadius: 16, position: 'absolute', top: 60, left: 0, right: 0, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.2)', zIndex: 99, elevation: 5, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 3.84 },
  suggestionItem: { flexDirection: 'row', alignItems: 'center', padding: 15, borderBottomWidth: 1, borderBottomColor: 'rgba(255, 255, 255, 0.1)' },
  suggestionText: { color: '#fff', fontSize: 16 },
  mainContainerWrapper: { flexGrow: 1, justifyContent: 'space-between' },
  header: { alignItems: 'center', marginTop: 15 },
  city: { color: '#fff', fontSize: 34, fontWeight: 'bold', textShadowColor: 'rgba(0,0,0,0.3)', textShadowOffset: { width: 1, height: 1 }, textShadowRadius: 3 },
  date: { color: '#64748B', fontSize: 14, marginTop: 4 },
  main: { alignItems: 'center', justifyContent: 'center', flex: 1 },
  temp: { color: '#fff', fontSize: 95, fontWeight: '100', marginTop: 10, textShadowColor: 'rgba(0,0,0,0.3)', textShadowOffset: { width: 2, height: 2 }, textShadowRadius: 5 },
  desc: { color: '#e2e8f0', fontSize: 22, fontWeight: '500', textTransform: 'capitalize' },
  currentMinMax: { flexDirection: 'row', gap: 15, marginTop: 8 },
  currentMax: { color: '#fff', fontSize: 16, fontWeight: 'bold', textShadowColor: 'rgba(0,0,0,0.3)', textShadowOffset: { width: 1, height: 1 }, textShadowRadius: 2 },
  currentMin: { color: '#94a3b8', fontSize: 16, fontWeight: 'bold' },
  details: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 20, paddingVertical: 20, backgroundColor: 'rgba(255, 255, 255, 0.1)', borderRadius: 20 },
  detailBox: { alignItems: 'center' },
  detailVal: { color: '#f8fafc', fontSize: 18, fontWeight: 'bold' },
  forecastContainer: { marginTop: 5, paddingVertical: 15 },
  forecastTitle: { color: '#f1f5f9', fontSize: 14, textTransform: 'uppercase', fontWeight: 'bold', marginBottom: 12, paddingHorizontal: 10, letterSpacing: 1 },
  forecastScroll: { paddingHorizontal: 5 },
  forecastItem: { alignItems: 'center', backgroundColor: 'rgba(255, 255, 255, 0.15)', paddingVertical: 14, paddingHorizontal: 18, borderRadius: 20, marginHorizontal: 6, minWidth: 80, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.2)' },
  forecastDay: { color: '#e2e8f0', fontSize: 14, fontWeight: 'bold' },
  forecastTemp: { color: '#f8fafc', fontSize: 16, fontWeight: 'bold' },
  forecastMin: { color: '#94a3b8', fontSize: 13, fontWeight: '600', marginTop: 2 },
  welcomeContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  welcomeIcon: { marginBottom: 10, opacity: 0.5 },
  welcomeTitle: { color: '#fff', fontSize: 28, fontWeight: 'bold' }
});