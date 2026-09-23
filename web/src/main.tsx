import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

// 注意：刻意不使用 React.StrictMode，避免开发模式下 effect 双调用导致 WebSocket 重复连接。
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
