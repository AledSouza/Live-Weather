import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

const ToastContext = createContext(() => {});

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const translateY = useRef(new Animated.Value(80)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const timeoutRef = useRef(null);

  const hideToast = useCallback(() => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: 80, duration: 180, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished) setToast(null);
    });
  }, [opacity, translateY]);

  const showToast = useCallback((message, options = {}) => {
    if (!message) return;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    setToast({
      message,
      tone: options.tone || 'default',
    });

    Animated.parallel([
      Animated.spring(translateY, { toValue: 0, damping: 18, stiffness: 180, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }),
    ]).start();

    timeoutRef.current = setTimeout(hideToast, options.duration || 2600);
  }, [hideToast, opacity, translateY]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <ToastContext.Provider value={showToast}>
      <View style={styles.providerRoot}>
        {children}
        <View pointerEvents="none" style={styles.toastLayer}>
          {toast && (
            <Animated.View
              style={[
                styles.toast,
                toast.tone === 'error' && styles.toastError,
                { opacity, transform: [{ translateY }] },
              ]}
            >
              <Text style={styles.toastText}>{toast.message}</Text>
            </Animated.View>
          )}
        </View>
      </View>
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  providerRoot: {
    flex: 1,
  },
  toastLayer: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 26,
    zIndex: 9999,
    alignItems: 'center',
  },
  toast: {
    maxWidth: 520,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 8,
    backgroundColor: '#101827',
    borderWidth: 1,
    borderColor: '#1f2937',
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  toastError: {
    borderColor: '#7f1d1d',
    backgroundColor: '#221113',
  },
  toastText: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
});
