import { createRoot } from 'react-dom/client';
import '@arco-design/web-react/dist/css/arco.css';
import 'react-json-view-lite/dist/index.css';
import '../style.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
