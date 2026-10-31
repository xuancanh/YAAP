/**
 * Web push on the client (docs/channels.md): register the service worker,
 * subscribe this browser with the server's VAPID public key, and tell the
 * API about it. Everything degrades silently where push is unsupported
 * (no `PushManager`, insecure origin, Firefox private mode, iOS Safari
 * outside an installed PWA) — the Settings toggle reads `pushSupported()`.
 */
import { api } from './api';

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // Vite serves public/ at the root in dev and copies it into dist/ on build.
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* unsupported or blocked: push is simply off */ });
}

/** The browser's current subscription for this origin, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** base64url VAPID public key → the BufferSource `subscribe()` wants. */
export function toApplicationServerKey(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Ask permission, subscribe, and register with the API. Throws a message
 *  fit for a toast when the user denies or the server has no keys. */
export async function enablePush(): Promise<PushSubscription> {
  if (!pushSupported()) throw new Error('This browser does not support web push.');
  const { enabled, publicKey } = await api.pushPublicKey();
  if (!enabled || !publicKey) throw new Error('The server has no VAPID keys — run `npm run push:keys` and set them in .env.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed for this site.');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toApplicationServerKey(publicKey) });
  await api.pushSubscribe(sub.toJSON(), navigator.userAgent);
  return sub;
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}
