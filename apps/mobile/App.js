import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

// Phase 0 skeleton screen. Exists so the Expo workspace resolves and boots.
export default function App() {
  return (
    <View style={styles.container}>
      <Text>chat-app mobile — Phase 0 skeleton</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
