import { createRoot } from 'react-dom/client';
import { Component, type ReactNode } from 'react';
import { App } from './App';
import './styles.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="fatal"><h1>Не удалось загрузить интерфейс.</h1><p>Ваши сообщения остаются на сервере.</p><button className="primary" onClick={() => location.reload()}>Перезагрузить Круг</button></div> : this.props.children;
  }
}
createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>);
