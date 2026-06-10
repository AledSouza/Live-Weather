import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SUPABASE_URL = 'https://rzmhvinmavwgtglrhqmf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6bWh2aW5tYXZ3Z3RnbHJocW1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwNTA0NTcsImV4cCI6MjA5NjYyNjQ1N30.Yp6w81vNORd7sKguYV7x6kl476KJoMbl5es1GdwjpLc';

// Inicializa o cliente do Supabase com persistência local automática
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});