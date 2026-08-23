import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SUPABASE_URL = 'https://byqldmxkbtltrhwwihjx.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_pDknu1ErFeiEZemV2_Z8ng_MH0HQY3k';

// Inicializa o cliente do Supabase com persistência local automática
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});