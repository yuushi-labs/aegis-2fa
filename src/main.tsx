import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/inter/index.css';
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/jetbrains-mono/index.css';
import './styles/app.css';
import { App } from './App';

const container = document.getElementById('root');
if (container === null) throw new Error('#root が見つかりません');

// 配置先がサブディレクトリ（/aegis/ など）でも動くように、基準は Vite の BASE_URL から取る。
const baseUrl = import.meta.env.BASE_URL;
const basename = baseUrl === '/' ? undefined : baseUrl.replace(/\/+$/, '');

// PWA: 本番ビルドのみ Service Worker を登録する（dev では HMR を邪魔しない）。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${baseUrl}sw.js`).catch(() => undefined);
  });
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
