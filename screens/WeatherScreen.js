import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, FlatList, Keyboard, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

export default function WeatherScreen({ onUnlock }) {
  const [city, setCity] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]); 
  const [weatherData, setWeatherData] = useState(null);
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
      const response = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(cityName)},BR&appid=${API_KEY}&units=metric&lang=pt_br`
      );
      const data = await response.json();

      if (response.ok) {
        setWeatherData(data);
        setCity(data.name);
        await AsyncStorage.setItem('@user_city', data.name);
      } else {
        setWeatherData(null);
        setApiError(data.message || 'Cidade não localizada.');
      }
    } catch (err) {
      setWeatherData(null);
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
    <View style={styles.container}>
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
        <TouchableOpacity 
          style={styles.mainContainerWrapper} 
          activeOpacity={1} 
          delayLongPress={2000} 
          onLongPress={onUnlock}
        >
          <View style={styles.header}>
            <Text style={styles.city}>{weatherData.name}</Text>
          </View>

          <View style={styles.main}>
            <Ionicons name="cloudy-night-outline" size={130} color="#fff" />
            <Text style={styles.temp}>{Math.round(weatherData.main.temp)}°C</Text>
            <Text style={styles.desc}>
              {weatherData.weather[0].description.replace(/^\w/, (c) => c.toUpperCase())}
            </Text>
          </View>

          <View style={styles.details}>
            <View style={styles.detailBox}>
              <Text style={styles.detailLabel}>Vento</Text>
              <Text style={styles.detailVal}>{weatherData.wind.speed} m/s</Text>
            </View>
            <View style={styles.detailBox}>
              <Text style={styles.detailLabel}>Umidade</Text>
              <Text style={styles.detailVal}>{weatherData.main.humidity}%</Text>
            </View>
          </View>
        </TouchableOpacity>
      ) : (
        <View style={styles.welcomeContainer}>
          <Ionicons name="partly-sunny-outline" size={100} color="#64748B" style={styles.welcomeIcon} />
          <Text style={styles.welcomeTitle}>Seja Bem-vindo(a)</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B131F', padding: 20 },
  searchBox: { marginTop: Platform.OS === 'ios' ? 50 : 40, marginBottom: 10, zIndex: 50 },
  searchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#152233', borderRadius: 12, paddingHorizontal: 15, height: 50, borderWidth: 1, borderColor: '#23354D' },
  input: { flex: 1, color: '#fff', fontSize: 16 },
  suggestionsContainer: { backgroundColor: '#152233', borderRadius: 12, position: 'absolute', top: 55, left: 0, right: 0, borderWidth: 1, borderColor: '#23354D', zIndex: 99 },
  suggestionItem: { flexDirection: 'row', alignItems: 'center', padding: 15, borderBottomWidth: 1, borderBottomColor: '#23354D' },
  suggestionText: { color: '#fff', fontSize: 16 },
  mainContainerWrapper: { flex: 1, justifyContent: 'space-between' },
  header: { alignItems: 'center', marginTop: 15 },
  city: { color: '#fff', fontSize: 32, fontWeight: 'bold' },
  date: { color: '#64748B', fontSize: 14, marginTop: 4 },
  main: { alignItems: 'center', justifyContent: 'center', flex: 1 },
  temp: { color: '#fff', fontSize: 95, fontWeight: '100', marginTop: 10 },
  desc: { color: '#94A3B8', fontSize: 20 },
  details: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 20, paddingVertical: 20, borderTopWidth: 1, borderTopColor: '#152233' },
  detailBox: { alignItems: 'center' },
  detailLabel: { color: '#64748B', fontSize: 14 },
  detailVal: { color: '#f8fafc', fontSize: 18, fontWeight: 'bold' },
  welcomeContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  welcomeIcon: { marginBottom: 10, opacity: 0.5 },
  welcomeTitle: { color: '#fff', fontSize: 28, fontWeight: 'bold' }
});