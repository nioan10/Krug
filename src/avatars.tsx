import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type AvatarStyle } from './api';
import { subscribe } from './events';

type Avatars = Record<string, AvatarStyle>;
const Context = createContext<{ avatars: Avatars; setAvatar: (id: string, avatar: AvatarStyle | null) => void }>({ avatars: {}, setAvatar: () => {} });
export function AvatarProvider({ children }: { children: ReactNode }) {
  const [avatars, setAvatars] = useState<Avatars>({});
  useEffect(() => {
    let live = true; let revision = 0;
    const load = () => { const before = revision; void api<{ avatars: Avatars }>('/avatars').then(result => { if (live && before === revision) setAvatars(result.avatars); }).catch(() => {}); };
    const off = subscribe(event => {
      if (event.type === 'ready') load();
      if (event.type === 'avatar-updated') { revision++; setAvatars(old => { const next = { ...old }; if (event.avatar) next[event.userId] = event.avatar; else delete next[event.userId]; return next; }); load(); }
    });
    load(); return () => { live = false; off(); };
  }, []);
  const setAvatar = (id: string, avatar: AvatarStyle | null) => setAvatars(old => { const next = { ...old }; if (avatar) next[id] = avatar; else delete next[id]; return next; });
  return <Context.Provider value={{ avatars, setAvatar }}>{children}</Context.Provider>;
}
export function useAvatars() { return useContext(Context); }
