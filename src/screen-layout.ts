export type ScreenLayout = 'focus' | 'grid' | 'single';
export type ScreenPreferences = { layout: ScreenLayout; size: number; people: boolean };
export const defaultScreenPreferences: ScreenPreferences = { layout: 'focus', size: 50, people: true };
const storageKey = 'krug-screen-layout-v1';
export function loadScreenPreferences(): ScreenPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '{}');
    return {
      layout: ['focus', 'grid', 'single'].includes(value.layout) ? value.layout : 'focus',
      size: typeof value.size === 'number' && Number.isFinite(value.size) ? Math.min(100, Math.max(0, value.size)) : 50,
      people: typeof value.people === 'boolean' ? value.people : true,
    };
  } catch { return { ...defaultScreenPreferences }; }
}
export function saveScreenPreferences(value: ScreenPreferences) {
  try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* Keep the layout for this call. */ }
}
export function reconcileScreenOrder(order: string[], current: string[]): string[] {
  const available = new Set(current);
  return [...new Set([...order.filter(id => available.has(id)), ...current])];
}
export function moveScreen(order: string[], id: string, target: string): string[] {
  const from = order.indexOf(id), to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return order;
  const next = order.filter(value => value !== id);
  next.splice(to, 0, id);
  return next;
}
