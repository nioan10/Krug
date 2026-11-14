import { useEffect, useState } from 'react';
import type { Message } from './api';
import { useEncryption } from './EncryptionSettings';
import type { SecretPayload } from './e2ee-crypto';
export function EncryptedImage({ message, payload }: { message: Message; payload?: SecretPayload }) {
  const { manager } = useEncryption();
  const [url, setUrl] = useState(''), [failed, setFailed] = useState(false);
  useEffect(() => {
    setUrl(''); setFailed(false);
    if (!message.encrypted || !manager || !payload) return;
    let cancelled = false, objectUrl = '';
    void manager.image(message, payload).then(blob => { if (cancelled) return; objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [message.id, message.encrypted?.ciphertext, payload, manager]);
  if (!message.encrypted) return <img loading="lazy" src={`/api/messages/${message.id}/image`} alt="Изображение в сообщении" />;
  if (!url) return <span className="tiny">{failed ? 'Не удалось расшифровать изображение' : 'Зашифрованное изображение'}</span>;
  return <img loading="lazy" src={url} alt="Изображение в сообщении" />;
}
