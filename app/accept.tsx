import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';

export default function AcceptScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();

  useEffect(() => {
    if (orderId) {
      router.replace({
        pathname: '/(tabs)',
        params: { acceptOrderId: orderId },
      });
    } else {
      router.replace('/(tabs)');
    }
  }, [orderId]);

  return null;
}