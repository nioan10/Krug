import { createRoot } from 'react-dom/client';
import { StreamViewer } from './StreamViewer';
import './styles.css';
import './streams.css';
createRoot(document.getElementById('root')!).render(<StreamViewer />);
