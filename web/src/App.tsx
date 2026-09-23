import { useEffect, useState } from 'react';
import { useStore } from './store';
import RoomListPage from './components/RoomListPage';
import TablePage from './components/TablePage';

function parseHash(): { page: string; code?: string } {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (h.startsWith('r/')) return { page: 'room', code: h.slice(2).toUpperCase() };
  return { page: 'list' };
}

function useHashRoute(): { page: string; code?: string } {
  const [route, setRoute] = useState(() => parseHash());
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export default function App() {
  const route = useHashRoute();
  const enterRoom = useStore((s) => s.enterRoom);
  const leaveRoom = useStore((s) => s.leaveRoom);

  useEffect(() => {
    if (route.page === 'room' && route.code) {
      if (useStore.getState().code !== route.code) enterRoom(route.code);
    } else {
      leaveRoom();
    }
    // 仅在路由变化（页面/房间码）时响应，避免重复连接
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.page, route.code]);

  if (route.page === 'room' && route.code) {
    return <TablePage code={route.code} />;
  }
  return <RoomListPage />;
}
