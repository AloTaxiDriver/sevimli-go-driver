import { useLocalSearchParams } from 'expo-router';
import MapScreen from '../../src/MapScreen';

export default function OrdersTab() {
  const { acceptOrderId } = useLocalSearchParams<{ acceptOrderId: string }>();
  return <MapScreen acceptOrderId={acceptOrderId} />;
}