import { createRoot } from 'react-dom/client';
import { Reader } from '../../src/ui/Reader';

const params = new URLSearchParams(location.search);
createRoot(document.getElementById('root')!).render(<Reader bookId={params.get('book') || undefined} embedded={params.has('embedded')}/>);
